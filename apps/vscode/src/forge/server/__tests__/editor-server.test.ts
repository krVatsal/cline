import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { startForgeEditorServer, ForgeEditorServer } from "../editor-server";
import {
	reviewBroker,
	changeLog,
	createEditProposal,
	createWriteProposal,
} from "../../core";

describe("ForgeEditorServer - Streamable HTTP MCP Integration", () => {
	let tempDir: string;
	let server: ForgeEditorServer;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `forge-server-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
		fs.mkdirSync(tempDir, { recursive: true });

		// Seed initial files
		fs.writeFileSync(path.join(tempDir, "hello.txt"), "Hello World\nLine 2\nLine 3\n", "utf-8");
		fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const greeting = 'Hello World';\n", "utf-8");

		reviewBroker.clear();
		changeLog.clear();

		server = await startForgeEditorServer({ workspaceRoot: tempDir });
	});

	afterEach(async () => {
		await server.stop();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	async function callMcp(method: string, params: any = {}, customHeaders: Record<string, string> = {}) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
			"Authorization": `Bearer ${server.token}`,
			...customHeaders,
		};

		const resp = await fetch(server.url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method,
				params,
			}),
		});

		const text = await resp.text();
		return { status: resp.status, text };
	}

	it("rejects unauthorized requests without valid bearer token", async () => {
		const resp = await callMcp("tools/list", {}, { Authorization: "Bearer bad-token" });
		expect(resp.status).toBe(401);
		expect(resp.text).toContain("Unauthorized");
	});

	it("lists all 5 core tools via tools/list", async () => {
		const resp = await callMcp("tools/list");
		expect(resp.status).toBe(200);

		// Streamable HTTP wraps response in SSE format
		expect(resp.text).toContain("read_file");
		expect(resp.text).toContain("list_dir");
		expect(resp.text).toContain("search_workspace");
		expect(resp.text).toContain("propose_edit");
		expect(resp.text).toContain("propose_write");
	});

	it("reads files via read_file tool", async () => {
		const resp = await callMcp("tools/call", {
			name: "read_file",
			arguments: { path: "hello.txt" },
		});
		expect(resp.status).toBe(200);
		expect(resp.text).toContain("1 | Hello World");
		expect(resp.text).toContain("2 | Line 2");
		expect(resp.text).toContain("3 | Line 3");
	});

	it("lists files via list_dir tool", async () => {
		const resp = await callMcp("tools/call", {
			name: "list_dir",
			arguments: { path: "" },
		});
		expect(resp.status).toBe(200);
		expect(resp.text).toContain("[FILE] hello.txt");
		expect(resp.text).toContain("[DIR]  src/");
	});

	it("searches workspace files via search_workspace tool", async () => {
		const resp = await callMcp("tools/call", {
			name: "search_workspace",
			arguments: { query: "greeting" },
		});
		expect(resp.status).toBe(200);
		expect(resp.text).toContain("src/index.ts:1");
		expect(resp.text).toContain("export const greeting");
	});

	it("HARD RULE: propose_edit without recorded broker approval FAILS and does NOT modify disk", async () => {
		const originalContent = fs.readFileSync(path.join(tempDir, "hello.txt"), "utf-8");

		const resp = await callMcp("tools/call", {
			name: "propose_edit",
			arguments: {
				path: "hello.txt",
				edits: [{ old_text: "Line 2", new_text: "Line 2 MODIFIED" }],
			},
		});

		// Server must return an error result and MUST NOT touch disk
		expect(resp.text).toContain("Permission denied: No recorded user approval");

		const contentAfter = fs.readFileSync(path.join(tempDir, "hello.txt"), "utf-8");
		expect(contentAfter).toBe(originalContent);
	});

	it("propose_edit WITH recorded broker approval succeeds, modifies disk, and pushes to changelog", async () => {
		const filePath = path.join(tempDir, "hello.txt");
		const originalContent = fs.readFileSync(filePath, "utf-8");

		// Compute proposal and record approval
		const edits = [{ old_text: "Line 2", new_text: "Line 2 ACCEPTED" }];
		const proposal = createEditProposal("hello.txt", originalContent, edits);
		expect(proposal.result).toBeDefined();

		const hash = proposal.result!.hash;
		const hunkIds = proposal.result!.hunks.map((h) => h.id);

		// Record approval in ReviewBroker
		reviewBroker.recordApproval(hash, hunkIds);

		const resp = await callMcp("tools/call", {
			name: "propose_edit",
			arguments: {
				path: "hello.txt",
				edits,
			},
		});

		expect(resp.text).toContain("Successfully applied edits");

		const updatedContent = fs.readFileSync(filePath, "utf-8");
		expect(updatedContent).toContain("Line 2 ACCEPTED");

		// ChangeLog should have recorded the change
		expect(changeLog.canUndo()).toBe(true);
		expect(changeLog.peekChange()?.relativePath).toBe("hello.txt");

		// Re-calling immediately must FAIL because approval is single-use
		const resp2 = await callMcp("tools/call", {
			name: "propose_edit",
			arguments: {
				path: "hello.txt",
				edits,
			},
		});
		expect(resp2.text).toContain("Permission denied: No recorded user approval");
	});

	it("propose_write creates a new file only when approved in ReviewBroker", async () => {
		const newRelPath = "new-folder/created.txt";
		const newContent = "Brand new file content\n";

		// Step 1: Without approval -> fails
		const unapprovedResp = await callMcp("tools/call", {
			name: "propose_write",
			arguments: { path: newRelPath, content: newContent },
		});
		expect(unapprovedResp.text).toContain("Permission denied: No recorded user approval");
		expect(fs.existsSync(path.join(tempDir, newRelPath))).toBe(false);

		// Step 2: With approval -> succeeds
		const proposal = createWriteProposal(newRelPath, newContent, false);
		const hash = proposal.result!.hash;
		reviewBroker.recordApproval(hash, ["hunk-0"]);

		const approvedResp = await callMcp("tools/call", {
			name: "propose_write",
			arguments: { path: newRelPath, content: newContent },
		});
		expect(approvedResp.text).toContain("Successfully created new file");

		const writtenContent = fs.readFileSync(path.join(tempDir, newRelPath), "utf-8");
		expect(writtenContent).toBe(newContent);
	});
});
