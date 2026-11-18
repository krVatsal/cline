import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { TrueForge, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import type {
	AgentMessage,
	AgentModelFinishReason,
	AgentRunResult,
	AgentUsage,
} from "@cline/shared";
import type {
	AgentHarness,
	AgentHarnessContext,
	AgentRunInput,
} from "../agent-runtime";

export interface TrueForgeHarnessOptions {
	/**
	 * Base URL for TrueForge Agent Harness Server.
	 * Defaults to `process.env.TRUEFORGE_BASE_URL` or `http://localhost:8790`.
	 */
	baseUrl?: string;
	/**
	 * Bearer token or API key for TrueForge / TrueFoundry.
	 * Defaults to `process.env.TFY_API_KEY` or `process.env.TRUEFOUNDRY_API_KEY`.
	 */
	token?: string;
	/**
	 * Default model name (e.g. "groq/openai-gpt-oss-120b").
	 * Defaults to `process.env.TRUEFORGE_MODEL` or "groq/openai-gpt-oss-120b".
	 */
	model?: string;
}

/**
 * TrueForge Agent Harness implementation.
 *
 * Drives agentic execution via the TrueForge Agent Harness Server HTTP/SSE API:
 * 1. Creates/reuses a persistent session with inline agent specs and system instructions.
 * 2. Streams turns over Server-Sent Events (SSE).
 * 3. Translates TrueForge `model.message.delta` streaming events into `assistant-text-delta` runtime events.
 * 4. Updates cumulative token usage and completes turns cleanly.
 */
export class TrueForgeHarness implements AgentHarness {
	private readonly client: TrueForge;
	private readonly fallbackClient?: TrueForge;
	private readonly configuredModelName?: string;
	private static readonly sessionsByConversation = new Map<string, string>();
	private static isSpawning = false;

	constructor(options: TrueForgeHarnessOptions = {}) {
		const vscode = (globalThis as any).vscode;
		const vsConfig = vscode?.workspace?.getConfiguration?.("cline");

		const baseUrl =
			options.baseUrl ||
			process.env.TRUEFORGE_BASE_URL ||
			vsConfig?.get?.("trueforge.baseUrl") ||
			"http://127.0.0.1:8790";
		const token =
			options.token ||
			process.env.TFY_API_KEY ||
			process.env.TRUEFOUNDRY_API_KEY;

		this.client = new TrueForge({
			baseUrl,
			environment: baseUrl,
			token,
		});

		// Fallback client for localhost / IPv6 loopback on Windows if 127.0.0.1 fails
		if (!options.baseUrl && !process.env.TRUEFORGE_BASE_URL && !vsConfig?.get?.("trueforge.baseUrl")) {
			this.fallbackClient = new TrueForge({
				baseUrl: "http://localhost:8790",
				environment: "http://localhost:8790",
				token,
			});
		}

		this.configuredModelName =
			options.model ||
			process.env.TRUEFORGE_MODEL ||
			vsConfig?.get?.("trueforge.modelId");
	}

	private static findNodeExecutable(): string {
		const isWin = process.platform === "win32";
		const exec = process.execPath;
		const execLower = exec.toLowerCase();
		if (
			!execLower.endsWith("code.exe") &&
			!execLower.endsWith("code") &&
			!execLower.endsWith("electron.exe") &&
			execLower.includes("node")
		) {
			return exec;
		}

		if (isWin) {
			const candidates = [
				"C:\\Program Files\\nodejs\\node.exe",
				"C:\\Program Files\\Volta\\node.exe",
				"C:\\nvm4w\\nodejs\\node.exe",
				path.join(process.env.LOCALAPPDATA || "", "Programs", "node", "node.exe"),
			];
			for (const cand of candidates) {
				if (fs.existsSync(cand)) return cand;
			}
			return "node.exe";
		}
		return "node";
	}

	private static findTrueForgeCli(): string | undefined {
		const appData =
			process.env.LOCALAPPDATA ||
			(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
		if (appData) {
			const npxDir = path.join(appData, "npm-cache", "_npx");
			if (fs.existsSync(npxDir)) {
				try {
					const entries = fs.readdirSync(npxDir);
					for (const entry of entries) {
						const cliCandidate = path.join(
							npxDir,
							entry,
							"node_modules",
							"@truefoundry",
							"trueforge",
							"dist",
							"cli.js",
						);
						if (fs.existsSync(cliCandidate)) {
							return cliCandidate;
						}
					}
				} catch {}
			}
		}
		return undefined;
	}

	private static async ensureServerRunning(): Promise<boolean> {
		const checkServer = async (): Promise<boolean> => {
			try {
				const res = await fetch("http://127.0.0.1:8790/api/v1/models");
				if (res.ok) return true;
			} catch {}
			try {
				const res = await fetch("http://localhost:8790/api/v1/models");
				if (res.ok) return true;
			} catch {}
			return false;
		};

		if (await checkServer()) return true;

		if (TrueForgeHarness.isSpawning) {
			for (let i = 0; i < 50; i++) {
				await new Promise((r) => setTimeout(r, 500));
				if (await checkServer()) return true;
			}
			return false;
		}

		TrueForgeHarness.isSpawning = true;
		try {
			const cliPath = TrueForgeHarness.findTrueForgeCli();
			const nodeExe = TrueForgeHarness.findNodeExecutable();
			const env = {
				...process.env,
				HOST: "0.0.0.0",
				NETWORK_POLICY_ENABLED: "false",
			};

			if (cliPath && fs.existsSync(cliPath)) {
				const isWin = process.platform === "win32";
				const useShell = isWin && !nodeExe.includes("\\");
				const child = spawn(nodeExe, [cliPath, "--port", "8790"], {
					detached: true,
					stdio: "ignore",
					env,
					windowsHide: true,
					shell: useShell,
				});
				child.unref();
			} else {
				const isWin = process.platform === "win32";
				const cmd = isWin ? "npx.cmd" : "npx";
				const child = spawn(cmd, ["@truefoundry/trueforge@latest", "--port", "8790"], {
					detached: true,
					stdio: "ignore",
					env,
					windowsHide: true,
					shell: isWin,
				});
				child.unref();
			}

			// Wait up to 25 seconds for server to start and become ready
			for (let i = 0; i < 50; i++) {
				await new Promise((r) => setTimeout(r, 500));
				if (await checkServer()) return true;
			}
		} catch (err) {
			console.warn("[TrueForgeHarness] Failed to auto-spawn TrueForge server:", err);
		} finally {
			TrueForgeHarness.isSpawning = false;
		}
		return false;
	}

	private async withClient<T>(operation: (client: TrueForge) => Promise<T>): Promise<T> {
		try {
			return await operation(this.client);
		} catch (error: any) {
			const isConnectionError =
				error?.message?.includes("fetch failed") ||
				error?.code === "ECONNREFUSED" ||
				error?.cause?.code === "ECONNREFUSED" ||
				error?.cause?.message?.includes("ECONNREFUSED");

			if (isConnectionError && this.fallbackClient) {
				try {
					return await operation(this.fallbackClient);
				} catch {}
			}

			if (isConnectionError) {
				const spawned = await TrueForgeHarness.ensureServerRunning();
				if (spawned) {
					try {
						return await operation(this.client);
					} catch {
						if (this.fallbackClient) {
							return await operation(this.fallbackClient);
						}
					}
				}
				// Final check against localhost fallback in case server just finished starting
				if (this.fallbackClient) {
					try {
						return await operation(this.fallbackClient);
					} catch {}
				}
				try {
					return await operation(this.client);
				} catch {}
			}

			throw error;
		}
	}

	private async resolveModelName(requestedModelId?: string): Promise<string> {
		if (this.configuredModelName?.trim()) {
			return this.configuredModelName.trim();
		}
		const vscode = (globalThis as any).vscode;
		const vsConfig = vscode?.workspace?.getConfiguration?.("cline");
		const configModel = vsConfig?.get?.("trueforge.modelId");
		if (typeof configModel === "string" && configModel.trim()) {
			return configModel.trim();
		}
		const envModel = process.env.TRUEFORGE_MODEL;
		if (envModel?.trim()) {
			return envModel.trim();
		}
		try {
			const modelsResponse = await this.withClient((c) => c.models.list());
			const activeModels = modelsResponse.data ?? [];

			// If a specific model was requested (e.g. "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b")
			if (requestedModelId?.trim()) {
				const req = requestedModelId.trim();
				const matched = activeModels.find(
					(m) =>
						m.name === req ||
						m.modelId === req ||
						m.name === `groq/${req}` ||
						m.modelId?.endsWith(req) ||
						(m.modelId && req.includes(m.modelId)),
				);
				if (matched?.name) {
					return matched.name;
				}
			}

			// Prefer Groq models (e.g. groq/openai-gpt-oss-120b)
			const groqModel = activeModels.find((m) => m.name?.startsWith("groq/"));
			if (groqModel?.name) {
				return groqModel.name;
			}
			if (activeModels.length > 0 && activeModels[0]?.name) {
				return activeModels[0].name;
			}
		} catch (error) {
			console.warn("[TrueForgeHarness] Could not query active models list from TrueForge:", error);
		}
		return "groq/openai-gpt-oss-120b";
	}

	private resolveWorkspaceCwd(ctx: AgentHarnessContext): string {
		const basePrompt = typeof ctx.config.systemPrompt === "string" ? ctx.config.systemPrompt : "";
		const envWorkDir = basePrompt.match(/Working Directory:\s*([^\r\n<]+)/i)?.[1]?.trim();
		if (envWorkDir && fs.existsSync(envWorkDir)) {
			return envWorkDir;
		}

		try {
			const vscode = (globalThis as any).vscode;
			const wsFolder = vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
			if (wsFolder && fs.existsSync(wsFolder)) {
				return wsFolder;
			}
		} catch {}

		const cfgCwd = (ctx.config as any).cwd || (ctx.config as any).workspaceRoot;
		if (cfgCwd && fs.existsSync(cfgCwd)) {
			return cfgCwd;
		}

		if (envWorkDir) {
			return envWorkDir;
		}

		return process.cwd();
	}

	public async run(
		ctx: AgentHarnessContext,
		input?: AgentRunInput,
	): Promise<AgentRunResult> {
		ctx.throwIfAborted();

		const snapshot = ctx.snapshot();
		const conversationId =
			(ctx.config as any).sessionId?.trim() ||
			(ctx.config as any).conversationId?.trim() ||
			snapshot.conversationId ||
			snapshot.agentId ||
			"default";

		const cwd = this.resolveWorkspaceCwd(ctx);

		// Always ensure Forge Editor MCP server is registered with current port and token
		const editorServer = (globalThis as any).forgeEditorServer;
		if (editorServer?.url && editorServer?.token) {
			try {
				await this.withClient((c) =>
					c.settings.mcpServers.createOrUpdate({
						manifest: {
							type: "remote",
							name: "forge-editor",
							description: "Local workspace file operations and diff proposals",
							url: editorServer.url,
							auth: {
								type: "header",
								headers: {
									Authorization: `Bearer ${editorServer.token}`,
								},
							},
						},
					}),
				);
			} catch (mcpErr) {
				console.warn("[TrueForgeHarness] Failed to register forge-editor MCP server:", mcpErr);
			}
		}

		// 1. Resolve or create TrueForge session for this conversation
		let sessionId = TrueForgeHarness.sessionsByConversation.get(conversationId);
		if (!sessionId) {
			const basePrompt = (typeof ctx.config.systemPrompt === "string" ? ctx.config.systemPrompt : "").trim();
			const envMatch = basePrompt.match(/<env>[\s\S]*?<\/env>/i);
			const envSection = envMatch ? `\n\n${envMatch[0]}` : "";

			const systemPrompt = `You are an expert software engineer working directly in the user's workspace.
Current Workspace: ${cwd}${envSection}

MCP Tools Specification:
The MCP server "forge-editor" provides all workspace operations.
When calling tools via call_tool, you MUST ALWAYS provide all required parameters:
- "mcp_server": "forge-editor"
- "tool_name": "<tool_name>"
- "input": { <parameters> }

Available tools on "forge-editor":
1. read_file:
   mcp_server: "forge-editor", tool_name: "read_file", input: { "path": "path/to/file" }
2. list_dir:
   mcp_server: "forge-editor", tool_name: "list_dir", input: { "path": "optional/dir/path" }
3. search_workspace:
   mcp_server: "forge-editor", tool_name: "search_workspace", input: { "query": "text to find" }
4. propose_edit:
   mcp_server: "forge-editor", tool_name: "propose_edit", input: { "path": "path/to/file", "edits": [{ "old_text": "...", "new_text": "..." }] }
5. propose_write:
   mcp_server: "forge-editor", tool_name: "propose_write", input: { "path": "path/to/new_file", "content": "..." }

Instructions:
- Explore with search_workspace, list_dir, and read_file before proposing edits.
- Never guess file paths or symbols.
- Write a short "Context:" list (files chosen, one-line reason each) before the first edit.
- Make the smallest change and do not touch unrelated code.
- Use propose_edit for existing files and propose_write only for new files.
- Update tests and docs when the request implies them.
- If hunks were declined do not re-propose them.
- Finish with a brief summary of the completed task.`;

			const modelObj = ctx.config.model;
			const requestedModel =
				(typeof (ctx.config as any).modelId === "string" ? (ctx.config as any).modelId : undefined) ||
				(typeof modelObj === "string" ? modelObj : undefined) ||
				(modelObj && typeof (modelObj as any).modelId === "string" ? (modelObj as any).modelId : undefined) ||
				(modelObj && typeof (modelObj as any).name === "string" ? (modelObj as any).name : undefined) ||
				(typeof (snapshot as any).modelId === "string" ? (snapshot as any).modelId : undefined);

			const modelName = await this.resolveModelName(requestedModel);

			const coreTools = ["read_file", "list_dir", "search_workspace", "propose_edit", "propose_write"];
			const vscode = (globalThis as any).vscode;
			const vsConfig = vscode?.workspace?.getConfiguration?.("cline");

			const createSpecForModel = (model: string) => ({
				agent: {
					spec: {
						instructions: systemPrompt,
						model: {
							name: model,
							params: {
								parallelToolCalls: false,
							},
						},
						...(editorServer
							? {
									mcpServers: [
										{
											name: "forge-editor",
											preload: true,
											enableTools: coreTools,
											preloadTools: coreTools,
											requireApprovalForTools: ["propose_edit", "propose_write"],
										},
									],
								}
							: {}),
						config: {
							iterationLimit: 30,
							askUserQuestions: { enabled: false },
							dynamicSubAgents: { enabled: false },
							contextManagement: {
								compaction: {
									enabled: true,
								},
							},
						},
					},
				},
			});

			let sessionResponse: any;
			try {
				sessionResponse = await this.withClient((c) => c.sessions.create(createSpecForModel(modelName)));
			} catch (primaryErr: any) {
				const fallbackModel = vsConfig?.get?.("trueforge.fallbackModelId") || process.env.TRUEFORGE_FALLBACK_MODEL;
				if (typeof fallbackModel === "string" && fallbackModel.trim() && fallbackModel.trim() !== modelName) {
					console.warn(`[TrueForgeHarness] Primary model ${modelName} failed. Falling back to ${fallbackModel.trim()}...`);
					sessionResponse = await this.withClient((c) => c.sessions.create(createSpecForModel(fallbackModel.trim())));
				} else {
					throw primaryErr;
				}
			}

			const createdId = sessionResponse.data?.id;
			if (!createdId || typeof createdId !== "string") {
				throw new Error("TrueForge did not return a session ID");
			}
			sessionId = createdId;
			TrueForgeHarness.sessionsByConversation.set(conversationId, createdId);
		}

		// 2. Extract user input text
		let promptText = "";
		if (typeof input === "string") {
			promptText = input;
		} else if (input && typeof input === "object") {
			if ("text" in input && typeof (input as any).text === "string") {
				promptText = (input as any).text;
			} else if ("prompt" in input && typeof (input as any).prompt === "string") {
				promptText = (input as any).prompt;
			} else if ("content" in input) {
				if (typeof (input as any).content === "string") {
					promptText = (input as any).content;
				} else if (Array.isArray((input as any).content)) {
					promptText = (input as any).content
						.filter((part: any) => part && (part.type === "text" || typeof part.text === "string"))
						.map((part: any) => (typeof part === "string" ? part : part.text || ""))
						.join("\n");
				}
			} else if (Array.isArray(input)) {
				for (let i = input.length - 1; i >= 0; i--) {
					const msg = input[i];
					if (msg && typeof msg === "object") {
						if (typeof (msg as any).content === "string") {
							promptText = (msg as any).content;
							break;
						} else if (Array.isArray((msg as any).content)) {
							const extracted = (msg as any).content
								.filter((part: any) => part && (part.type === "text" || typeof part.text === "string"))
								.map((part: any) => (typeof part === "string" ? part : part.text || ""))
								.join("\n");
							if (extracted) {
								promptText = extracted;
								break;
							}
						}
					}
				}
			}
		}

		if (!promptText && snapshot.messages.length > 0) {
			for (let i = snapshot.messages.length - 1; i >= 0; i--) {
				const msg = snapshot.messages[i];
				if (msg.role === "user") {
					if (typeof (msg as any).content === "string") {
						promptText = (msg as any).content;
						break;
					} else if (Array.isArray(msg.content)) {
						const extracted = msg.content
							.filter((part: any) => part && (part.type === "text" || typeof part.text === "string"))
							.map((part: any) => (typeof part === "string" ? part : (part as any).text || ""))
							.join("\n");
						if (extracted) {
							promptText = extracted;
							break;
						}
					}
				}
			}
		}

		// Strip mode envelopes and tags like <mode_notice>...</mode_notice> or <user_input mode="act">...</user_input>
		promptText = promptText
			.replace(/<mode_notice>[\s\S]*?<\/mode_notice>/gi, "")
			.replace(/<user_input(?:\s+[^>]*)?>([\s\S]*?)<\/user_input>/gi, "$1")
			.trim();

		// If this is a synthetic resumption or generic continue/retry prompt, recover the original task prompt from history
		if (
			promptText.includes("[TASK RESUMPTION]") ||
			promptText.toLowerCase().trim() === "continue" ||
			promptText.toLowerCase().trim() === "retry"
		) {
			let originalPrompt = "";
			for (const msg of snapshot.messages) {
				if (msg.role === "user") {
					const text =
						typeof (msg as any).content === "string"
							? (msg as any).content
							: Array.isArray((msg as any).content)
								? (msg as any).content
										.filter((p: any) => p && (p.type === "text" || typeof p.text === "string"))
										.map((p: any) => (typeof p === "string" ? p : p.text || ""))
										.join("\n")
								: "";
					const cleaned = text
						.replace(/<mode_notice>[\s\S]*?<\/mode_notice>/gi, "")
						.replace(/<user_input(?:\s+[^>]*)?>([\s\S]*?)<\/user_input>/gi, "$1")
						.replace(/\[TASK RESUMPTION\][^\r\n]*/gi, "")
						.trim();
					if (
						cleaned &&
						cleaned.toLowerCase() !== "continue" &&
						cleaned.toLowerCase() !== "retry"
					) {
						originalPrompt = cleaned;
						break;
					}
				}
			}
			if (originalPrompt) {
				promptText = `Please resume and complete this task:\n${originalPrompt}`;
			}
		}

		// If no prompt was provided and no user messages exist in history, this is an interactive
		// session bootstrap without an initial prompt. Return cleanly without sending a turn.
		if (!promptText) {
			return ctx.finishRun("completed", undefined, "");
		}

		// Prompt sent to the agent is user's promptText plus lightweight references only (no full file bodies)
		const turnInputContent = promptText;
		const nextTurnPrompt = turnInputContent;
		let fullAccumulatedText = "";
		const finishReason: AgentModelFinishReason = "stop";

		if (!sessionId) {
			throw new Error("No TrueForge session available");
		}

		// 4. Autonomous execution loop: runs turns, executes inspection/action commands, and completes work
		try {
			let turnInputs: any[] = [
				{
					type: "user.message",
					content: nextTurnPrompt,
				},
			];

			const indexedMessages = new Map<string, any>();

			while (true) {
				ctx.throwIfAborted();

				const stream = await this.withClient((c) =>
					c.sessions.createTurnStream(sessionId, {
						input: turnInputs,
					}),
				);

				let turnAccumulatedText = "";
				let accumulatedReasoning = "";
				let pendingApprovalEvent: any = null;

				for await (const chunk of ((stream as any).withMetadata ? (stream as any).withMetadata() : stream)) {
					ctx.throwIfAborted();
					const event = chunk.data ?? chunk;

					if (event.type === "model.message.delta") {
						if (event.id && isEventDelta(event)) {
							const existing = indexedMessages.get(event.id);
							if (existing) {
								mergeEventDelta(existing, event);
							}
						}

						const reasoning = (event as any).reasoningContent;
						if (reasoning) {
							accumulatedReasoning += reasoning;
							await ctx.emit({
								type: "assistant-reasoning-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: reasoning,
								accumulatedText: accumulatedReasoning,
							});
						}

						const delta = event.content ?? "";
						if (delta) {
							turnAccumulatedText += delta;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: delta,
								accumulatedText: fullAccumulatedText + turnAccumulatedText,
							});
						}
					} else if (event.type === "model.message") {
						indexedMessages.set(event.id, event);
						const content = (event as any).content;
						if (content && !turnAccumulatedText) {
							turnAccumulatedText = content;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: content,
								accumulatedText: fullAccumulatedText + turnAccumulatedText,
							});
						}
					} else if (event.type === "tool.approval_required") {
						pendingApprovalEvent = event;
					} else if (event.type === "turn.done") {
						const output = (event as any).state?.output;
						if (output?.content && !turnAccumulatedText) {
							turnAccumulatedText = output.content;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: turnAccumulatedText,
								accumulatedText: fullAccumulatedText + turnAccumulatedText,
							});
						}

						if (event.state && "metrics" in event.state && event.state.metrics) {
							const metrics = event.state.metrics as {
								totalInputTokens?: number;
								totalOutputTokens?: number;
								totalTokens?: number;
							};
							const usage: Partial<AgentUsage> = {
								inputTokens: metrics.totalInputTokens ?? 0,
								outputTokens: metrics.totalOutputTokens ?? 0,
							};
							await ctx.updateUsage(usage);
						}

						if (event.state && event.state.status === "error") {
							throw new Error(event.state.message || "TrueForge turn failed");
						}
					}
				}

				if (turnAccumulatedText) {
					fullAccumulatedText += (fullAccumulatedText ? "\n\n" : "") + turnAccumulatedText;
				}

				// If an approval is required, pause, resolve proposals, show diff review to user, and resume turn
				if (pendingApprovalEvent) {
					const toolCalls = pendingApprovalEvent.toolCalls || [];
					const approvalInputs: any[] = [];

					for (const tc of toolCalls) {
						const toolCallId = tc.id;
						const sourceMessage = indexedMessages.get(tc.sourceEventId);
						const matchedToolCall = sourceMessage?.toolCalls?.find((c: any) => c.id === toolCallId);

						const rawFnName = matchedToolCall?.function?.name || matchedToolCall?.name || matchedToolCall?.toolInfo?.name;
						let fnArgs: any = {};
						try {
							const raw = matchedToolCall?.function?.arguments || matchedToolCall?.arguments;
							fnArgs = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
						} catch {}

						const fnName = rawFnName === "call_tool" ? fnArgs.tool_name : rawFnName;
						const toolArgs = (rawFnName === "call_tool" && fnArgs.input) ? fnArgs.input : fnArgs;

						let decision: { allow: boolean; acceptedHunkIds?: string[]; denyReason?: string } = {
							allow: false,
							denyReason: "No approval provider available",
						};

						const inlineReview = (globalThis as any).clineInlineReview;
						const broker = (globalThis as any).forgeReviewBroker;
						const vscode = (globalThis as any).vscode;
						const createEditProposal = (globalThis as any).forgeCreateEditProposal;
						const createWriteProposal = (globalThis as any).forgeCreateWriteProposal;

						let proposalResult: any = null;

						if (fnName === "propose_edit" && createEditProposal) {
							const relPath = toolArgs?.path;
							const edits = toolArgs?.edits;
							const absPath = path.resolve(cwd, relPath);
							if (fs.existsSync(absPath)) {
								const orig = fs.readFileSync(absPath, "utf-8");
								const p = createEditProposal(relPath, orig, edits || []);
								if (p.result) {
									proposalResult = p.result;
								}
							}
						} else if (fnName === "propose_write" && createWriteProposal) {
							const relPath = toolArgs?.path;
							const content = toolArgs?.content || "";
							const p = createWriteProposal(relPath, content, false);
							if (p.result) {
								proposalResult = p.result;
							}
						}

						if (proposalResult && inlineReview && vscode) {
							const relPath = toolArgs?.path;
							const absPath = path.resolve(cwd, relPath);
							const fileUri = vscode.Uri.file(absPath);
							const orig = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";

							decision = await new Promise<{ allow: boolean; acceptedHunkIds?: string[]; denyReason?: string }>((resolve) => {
								let settled = false;
								const settle = (d: { allow: boolean; acceptedHunkIds?: string[]; denyReason?: string }) => {
									if (!settled) {
										settled = true;
										resolve(d);
									}
								};

								inlineReview.startReview(fileUri, orig, proposalResult.proposedContentLF, (dec: any) => {
									settle(dec);
								});

								vscode.window.showInformationMessage(
									`Agent proposed changes to ${relPath}. Review diff in editor:`,
									"Accept All",
									"Reject All",
								).then((action: string | undefined) => {
									if (action === "Accept All") {
										inlineReview.acceptAll(fileUri.toString());
										settle({ allow: true });
									} else if (action === "Reject All") {
										inlineReview.rejectAll(fileUri.toString());
										settle({ allow: false, denyReason: "User rejected all changes" });
									}
								});
							});
						}

						if (decision.allow && proposalResult && broker) {
							const hunkIdsToAccept =
								decision.acceptedHunkIds && decision.acceptedHunkIds.length > 0
									? decision.acceptedHunkIds
									: proposalResult.hunks.map((h: any) => h.id);
							broker.recordApproval(proposalResult.hash, hunkIdsToAccept);

							approvalInputs.push({
								type: "user.tool_approval",
								threadId: pendingApprovalEvent.threadId,
								toolCallId,
								approval: { status: "allow" },
							});
						} else {
							approvalInputs.push({
								type: "user.tool_approval",
								threadId: pendingApprovalEvent.threadId,
								toolCallId,
								approval: {
									status: "deny",
									reason: decision.denyReason || "User rejected proposed changes",
								},
							});
						}
					}

					turnInputs = approvalInputs;
					continue;
				}

				if (!fullAccumulatedText.trim()) {
					fullAccumulatedText = "I'm ready to assist with your coding tasks, running commands, and workspace operations. What would you like to run or build?";
					await ctx.emit({
						type: "assistant-text-delta",
						snapshot: ctx.snapshot(),
						iteration: ctx.snapshot().iteration,
						text: fullAccumulatedText,
						accumulatedText: fullAccumulatedText,
					});
				}

				break;
			}

			// 5. Record assistant message in transcript
			const assistantMessage: AgentMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: "assistant",
				content: fullAccumulatedText ? [{ type: "text", text: fullAccumulatedText }] : [],
				createdAt: Date.now(),
			};

			await ctx.recordAssistantMessage(assistantMessage, finishReason);

			return ctx.finishRun("completed", assistantMessage, fullAccumulatedText);
		} catch (error: any) {
			// In case of a session failure (e.g. 400 error), evict the cached session so next turn recovers cleanly
			TrueForgeHarness.sessionsByConversation.delete(conversationId);
			throw error;
		}
	}
}
