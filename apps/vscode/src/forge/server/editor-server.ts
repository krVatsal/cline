import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
	detectEol,
	restoreEol,
	normalizeToLf,
	normalizePath,
	resolveSafePath,
	computeHunks,
	applyHunks,
	createEditProposal,
	createWriteProposal,
	computeProposalHash,
	reviewBroker,
	changeLog,
} from "../core";

export interface ForgeEditorServerOptions {
	workspaceRoot: string;
	port?: number;
	token?: string;
}

export interface ForgeEditorServer {
	url: string;
	port: number;
	token: string;
	workspaceRoot: string;
	stop(): Promise<void>;
	setWorkspaceRoot(newRoot: string): void;
}

const TOOLS: Tool[] = [
	{
		name: "read_file",
		description: "Reads the contents of a file from the workspace root. Output is numbered by line ('1 | content') and capped to max 400 lines / ~16 KB. Use start_line and end_line to paginate through larger files.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to read, relative to workspace root.",
				},
				start_line: {
					type: "number",
					description: "Optional 1-indexed line number to start reading from.",
				},
				end_line: {
					type: "number",
					description: "Optional 1-indexed line number to stop reading at (inclusive).",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_dir",
		description: "Lists directory contents in the workspace root.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Relative directory path to list. Omit or pass empty string for workspace root.",
				},
			},
		},
	},
	{
		name: "search_workspace",
		description: "Searches for text occurrences across files in the workspace.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The substring or term to search for.",
				},
				path: {
					type: "string",
					description: "Optional relative subfolder path to restrict the search.",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "propose_edit",
		description: "Proposes edits to an existing file in the workspace. Edits are verified against recorded user approval before writing to disk.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Relative path of the existing file to edit.",
				},
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							old_text: {
								type: "string",
								description: "Exact text snippet to replace (must appear exactly once).",
							},
							new_text: {
								type: "string",
								description: "Replacement text snippet.",
							},
						},
						required: ["old_text", "new_text"],
					},
					description: "List of replacement edits to apply sequentially.",
				},
			},
			required: ["path", "edits"],
		},
	},
	{
		name: "propose_write",
		description: "Proposes writing a completely new file in the workspace. Fails if the file already exists.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Relative path of the new file to create.",
				},
				content: {
					type: "string",
					description: "Initial content for the new file.",
				},
			},
			required: ["path", "content"],
		},
	},
];

export async function startForgeEditorServer(
	options: ForgeEditorServerOptions,
): Promise<ForgeEditorServer> {
	let currentWorkspaceRoot = path.resolve(options.workspaceRoot);
	const token = options.token || crypto.randomBytes(24).toString("hex");

	function createMcpServer(): Server {
		const mcpServer = new Server(
			{
				name: "forge-editor",
				version: "1.0.0",
			},
			{
				capabilities: {
					tools: {},
				},
			},
		);

		// Register tools list handler
		mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
			return { tools: TOOLS };
		});

		// Register tool call handler
		mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params;

			switch (name) {
				case "read_file": {
					const relPath = args?.path as string;
					if (!relPath) {
						return { isError: true, content: [{ type: "text", text: "Missing required argument 'path'" }] };
					}
					const check = resolveSafePath(currentWorkspaceRoot, relPath);
					if (!check.safe || !check.resolvedPath) {
						return { isError: true, content: [{ type: "text", text: `Path safety error: ${check.error}` }] };
					}
					if (!fs.existsSync(check.resolvedPath)) {
						return { isError: true, content: [{ type: "text", text: `File not found: ${relPath}` }] };
					}
					try {
						let raw = "";
						const vscode = (globalThis as any).vscode;
						const openDoc = vscode?.workspace?.textDocuments?.find(
							(d: any) => d?.uri?.fsPath && path.normalize(d.uri.fsPath) === path.normalize(check.resolvedPath!)
						);
						if (openDoc && typeof openDoc.getText === "function") {
							raw = openDoc.getText();
						} else {
							raw = fs.readFileSync(check.resolvedPath, "utf-8");
						}

						const lfContent = normalizeToLf(raw);
						const allLines = lfContent.split("\n");
						const totalLines = allLines.length;

						const startLine =
							typeof args?.start_line === "number" && args.start_line > 0
								? Math.floor(args.start_line)
								: 1;
						const requestedEnd =
							typeof args?.end_line === "number" && args.end_line > 0
								? Math.floor(args.end_line)
								: totalLines;
						const endLine = Math.min(totalLines, Math.max(startLine, requestedEnd));

						const maxLinesBudget = 400;
						const maxBytesBudget = 16000; // ~16 KB budget to avoid tool-response overflow & rate-limit traps

						let resultText = "";
						let linesRead = 0;
						let truncated = false;

						for (let i = startLine; i <= endLine; i++) {
							const lineContent = allLines[i - 1] ?? "";
							const formattedLine = `${i} | ${lineContent}\n`;
							if (linesRead >= maxLinesBudget || (resultText.length + formattedLine.length) > maxBytesBudget) {
								truncated = true;
								break;
							}
							resultText += formattedLine;
							linesRead++;
						}

						if (truncated) {
							resultText += `\n[... output capped at ${linesRead} lines (${resultText.length} bytes); file has ${totalLines} lines. Narrow request using start_line and end_line]`;
						}

						return { content: [{ type: "text", text: resultText }] };
					} catch (err: any) {
						return { isError: true, content: [{ type: "text", text: `Failed to read file: ${err.message}` }] };
					}
				}

				case "list_dir": {
					const relPath = (args?.path as string) || "";
					const check = resolveSafePath(currentWorkspaceRoot, relPath);
					if (!check.safe || !check.resolvedPath) {
						return { isError: true, content: [{ type: "text", text: `Path safety error: ${check.error}` }] };
					}
					if (!fs.existsSync(check.resolvedPath)) {
						return { isError: true, content: [{ type: "text", text: `Directory not found: ${relPath}` }] };
					}
					try {
						const entries = fs.readdirSync(check.resolvedPath, { withFileTypes: true });
						const ignored = new Set([
							".git",
							"node_modules",
							".vscode",
							"dist",
							"build",
							".next",
							"__pycache__",
							".venv",
							"venv",
							".pytest_cache",
						]);
						const lines: string[] = [];
						for (const entry of entries) {
							if (ignored.has(entry.name)) continue;
							const entryRel = path.join(relPath, entry.name);
							const normalized = normalizePath(entryRel);
							if (entry.isDirectory()) {
								lines.push(`[DIR]  ${normalized}/`);
							} else {
								lines.push(`[FILE] ${normalized}`);
							}
						}
						return { content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }] };
					} catch (err: any) {
						return { isError: true, content: [{ type: "text", text: `Failed to list directory: ${err.message}` }] };
					}
				}

				case "search_workspace": {
					const query = args?.query as string;
					if (!query) {
						return { isError: true, content: [{ type: "text", text: "Missing required argument 'query'" }] };
					}
					const subPath = (args?.path as string) || "";
					const check = resolveSafePath(currentWorkspaceRoot, subPath);
					if (!check.safe || !check.resolvedPath) {
						return { isError: true, content: [{ type: "text", text: `Path safety error: ${check.error}` }] };
					}

					try {
						const maxResults =
							typeof args?.max_results === "number" && args.max_results > 0
								? Math.floor(args.max_results)
								: 50;
						const matches = searchInDirectory(check.resolvedPath, currentWorkspaceRoot, query, maxResults);
						if (matches.length === 0) {
							return { content: [{ type: "text", text: `No occurrences of "${query}" found.` }] };
						}

						let output = "";
						let count = 0;
						const maxBytes = 8000;
						let truncatedCount = 0;

						for (const m of matches) {
							const line = `${m.relativePath}:${m.lineNumber}: ${m.lineText}\n`;
							if (output.length + line.length > maxBytes) {
								truncatedCount = matches.length - count;
								break;
							}
							output += line;
							count++;
						}

						if (truncatedCount > 0) {
							output += `\n[... ${truncatedCount} more matches omitted. Narrow your search query or path]`;
						}

						return { content: [{ type: "text", text: output.trimEnd() }] };
					} catch (err: any) {
						return { isError: true, content: [{ type: "text", text: `Search failed: ${err.message}` }] };
					}
				}

				case "propose_edit": {
					const relPath = args?.path as string;
					const edits = args?.edits as Array<{ old_text: string; new_text: string }>;
					if (!relPath || !Array.isArray(edits)) {
						return { isError: true, content: [{ type: "text", text: "Missing 'path' or 'edits' array" }] };
					}
					const check = resolveSafePath(currentWorkspaceRoot, relPath);
					if (!check.safe || !check.resolvedPath) {
						return { isError: true, content: [{ type: "text", text: `Path safety error: ${check.error}` }] };
					}
					if (!fs.existsSync(check.resolvedPath)) {
						return { isError: true, content: [{ type: "text", text: `Cannot edit non-existent file: ${relPath}. Use propose_write for new files.` }] };
					}

					let rawOriginal = "";
					try {
						rawOriginal = fs.readFileSync(check.resolvedPath, "utf-8");
					} catch (readErr: any) {
						return { isError: true, content: [{ type: "text", text: `Failed to read ${relPath}: ${readErr.message}` }] };
					}

					const origEol = detectEol(rawOriginal);
					const proposal = createEditProposal(relPath, rawOriginal, edits);
					if (proposal.error || !proposal.result) {
						return { isError: true, content: [{ type: "text", text: `Edit proposal rejected: ${proposal.error}` }] };
					}

					const { hash, hunks, proposedContentLF } = proposal.result;

					// HARD INVARIANT: Check for recorded user approval in ReviewBroker
					const approval = reviewBroker.consumeApproval(hash);
					if (!approval) {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: `Permission denied: No recorded user approval for edit proposal (hash: ${hash}). Disk was NOT modified.`,
								},
							],
						};
					}

					// Apply only the accepted hunks
					const finalContentLF = applyHunks(rawOriginal, hunks, approval.acceptedHunkIds);
					const finalWithEol = restoreEol(finalContentLF, origEol);

					try {
						fs.writeFileSync(check.resolvedPath, finalWithEol, "utf-8");
						changeLog.pushChange({
							filePath: check.resolvedPath,
							relativePath: normalizePath(relPath),
							beforeText: rawOriginal,
							afterText: finalWithEol,
							description: `Edited ${relPath} (${approval.acceptedHunkIds.length}/${hunks.length} hunks accepted)`,
						});
						return {
							content: [
								{
									type: "text",
									text: `Successfully applied edits to ${relPath} (${approval.acceptedHunkIds.length} of ${hunks.length} hunks accepted).`,
								},
							],
						};
					} catch (writeErr: any) {
						return { isError: true, content: [{ type: "text", text: `Failed to write file to disk: ${writeErr.message}` }] };
					}
				}

				case "propose_write": {
					const relPath = args?.path as string;
					const content = args?.content as string;
					if (!relPath || typeof content !== "string") {
						return { isError: true, content: [{ type: "text", text: "Missing 'path' or 'content'" }] };
					}
					const check = resolveSafePath(currentWorkspaceRoot, relPath);
					if (!check.safe || !check.resolvedPath) {
						return { isError: true, content: [{ type: "text", text: `Path safety error: ${check.error}` }] };
					}
					const fileExists = fs.existsSync(check.resolvedPath);
					if (fileExists) {
						return { isError: true, content: [{ type: "text", text: `File "${relPath}" already exists. Use propose_edit to modify existing files.` }] };
					}

					const proposal = createWriteProposal(relPath, content, false);
					if (proposal.error || !proposal.result) {
						return { isError: true, content: [{ type: "text", text: `Write proposal rejected: ${proposal.error}` }] };
					}

					const { hash, proposedContentLF } = proposal.result;

					// HARD INVARIANT: Check for recorded user approval in ReviewBroker
					const approval = reviewBroker.consumeApproval(hash);
					if (!approval) {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: `Permission denied: No recorded user approval for write proposal (hash: ${hash}). Disk was NOT modified.`,
								},
							],
						};
					}

					try {
						const parentDir = path.dirname(check.resolvedPath);
						if (!fs.existsSync(parentDir)) {
							fs.mkdirSync(parentDir, { recursive: true });
						}
						fs.writeFileSync(check.resolvedPath, proposedContentLF, "utf-8");
						changeLog.pushChange({
							filePath: check.resolvedPath,
							relativePath: normalizePath(relPath),
							beforeText: null, // new file
							afterText: proposedContentLF,
							description: `Created new file ${relPath}`,
						});
						return {
							content: [
								{
									type: "text",
									text: `Successfully created new file ${relPath}.`,
								},
							],
						};
					} catch (writeErr: any) {
						return { isError: true, content: [{ type: "text", text: `Failed to create file: ${writeErr.message}` }] };
					}
				}

				default:
					return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
			}
		});

		return mcpServer;
	}

	// HTTP Server with Bearer Auth and host loopback protection
	const httpServer = http.createServer(async (req, res) => {
		// Verify Bearer Auth token
		const authHeader = req.headers.authorization;
		if (!authHeader || authHeader !== `Bearer ${token}`) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized: invalid or missing Bearer token" }));
			return;
		}

		// Delegate request to fresh MCP transport (stateless mode requirement)
		try {
			const mcpServer = createMcpServer();
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			await mcpServer.connect(transport);
			await transport.handleRequest(req, res);
		} catch (handleErr: any) {
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: handleErr?.message || "Internal server error" }));
			}
		}
	});

	const port = options.port ?? 0;
	await new Promise<void>((resolve, reject) => {
		httpServer.listen(port, "127.0.0.1", () => resolve());
		httpServer.on("error", reject);
	});

	const assignedPort = (httpServer.address() as any).port;
	const url = `http://127.0.0.1:${assignedPort}/mcp`;

	return {
		url,
		port: assignedPort,
		token,
		get workspaceRoot() {
			return currentWorkspaceRoot;
		},
		setWorkspaceRoot(newRoot: string) {
			currentWorkspaceRoot = path.resolve(newRoot);
		},
		async stop() {
			await new Promise<void>((res) => httpServer.close(() => res()));
		},
	};
}

function searchInDirectory(
	dir: string,
	root: string,
	query: string,
	maxResults: number,
): Array<{ relativePath: string; lineNumber: number; lineText: string }> {
	const results: Array<{ relativePath: string; lineNumber: number; lineText: string }> = [];
	const ignoredDirs = new Set([".git", "node_modules", ".vscode", "dist", ".next", "build", "out"]);

	function walk(currentDir: string) {
		if (results.length >= maxResults) return;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (results.length >= maxResults) return;
			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				if (!ignoredDirs.has(entry.name)) {
					walk(fullPath);
				}
			} else if (entry.isFile()) {
				// Skip obvious binary files
				const ext = path.extname(entry.name).toLowerCase();
				if ([".png", ".jpg", ".jpeg", ".gif", ".exe", ".bin", ".zip", ".tar", ".gz", ".woff", ".woff2"].includes(ext)) {
					continue;
				}

				try {
					const content = fs.readFileSync(fullPath, "utf-8");
					if (content.includes(query)) {
						const lines = content.split("\n");
						for (let i = 0; i < lines.length; i++) {
							if (lines[i].includes(query)) {
								const rel = normalizePath(path.relative(root, fullPath));
								results.push({
									relativePath: rel,
									lineNumber: i + 1,
									lineText: lines[i].trim().slice(0, 120),
								});
								if (results.length >= maxResults) return;
							}
						}
					}
				} catch {
					// Ignore unreadable files
				}
			}
		}
	}

	walk(dir);
	return results;
}
