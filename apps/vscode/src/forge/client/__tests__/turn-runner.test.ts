import { describe, it, expect, beforeEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { TurnRunner, TurnRunnerCallbacks } from "../turn-runner";
import { reviewBroker } from "../../core";

describe("TurnRunner - TrueForge Client & Approval Loop", () => {
	let tempDir: string;
	let mockEditorServer: any;
	let mockTrueForgeClient: any;
	let sessionTurns: any[];
	let createdSessions: any[];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `forge-runner-test-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		fs.writeFileSync(path.join(tempDir, "file.txt"), "Original content\n", "utf-8");

		reviewBroker.clear();

		mockEditorServer = {
			url: "http://127.0.0.1:55555/mcp",
			port: 55555,
			token: "secret-mcp-token",
			workspaceRoot: tempDir,
		};

		sessionTurns = [];
		createdSessions = [];

		mockTrueForgeClient = {
			settings: {
				mcpServers: {
					createOrUpdate: async (args: any) => args,
				},
			},
			sessions: {
				create: async (spec: any) => {
					createdSessions.push(spec);
					return { data: { id: `session-${createdSessions.length}` } };
				},
				createTurnStream: async (sessionId: string, opts: any) => {
					sessionTurns.push({ sessionId, opts });
					const events = mockTrueForgeClient._nextTurnEvents || [
						{ type: "turn.created" },
						{ type: "model.message.delta", content: "Agent completed task." },
						{ type: "turn.done", state: { status: "done" } },
					];
					return (async function* () {
						for (const ev of events) {
							yield { data: ev };
						}
					})();
				},
				cancel: async (sessionId: string) => {
					mockTrueForgeClient._cancelledSession = sessionId;
				},
			},
		};
	});

	it("initializes session with correct agent spec, preloadTools, and mcp registration", async () => {
		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "test-provider/test-model",
		});

		const sessId = await runner.initSession();
		expect(sessId).toBe("session-1");
		expect(createdSessions.length).toBe(1);

		const spec = createdSessions[0].agent.spec;
		expect(spec.model.name).toBe("test-provider/test-model");
		expect(spec.mcpServers[0].name).toBe("forge-editor");
		expect(spec.mcpServers[0].preloadTools).toEqual(["read_file", "list_dir", "search_workspace", "propose_edit", "propose_write"]);
		expect(spec.mcpServers[0].enableTools).toEqual(["read_file", "list_dir", "search_workspace", "propose_edit", "propose_write"]);
		expect(spec.mcpServers[0].requireApprovalForTools).toEqual(["propose_edit", "propose_write"]);
		expect(spec.instructions).toContain("Context:\n- <relative path>:<line range> - <why this file matters>");
		expect(spec.instructions).toContain("create_sub_agent");
		expect(spec.config.dynamicSubAgents.enabled).toBe(true);
	});

	it("falls back to secondary model if primary model fails during session initialization", async () => {
		let callCount = 0;
		mockTrueForgeClient.sessions.create = async (spec: any) => {
			callCount++;
			if (callCount === 1) {
				throw new Error("Model unavailable: provider quota exceeded");
			}
			return { data: { id: "fallback-session-id" } };
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "primary/model",
			fallbackModel: "fallback/model",
		});

		const statusMsgs: string[] = [];
		const result = await runner.runTurn("Hello", {
			onStatusChange: (s) => statusMsgs.push(s),
		});

		expect(statusMsgs.some((s) => s.includes("Falling back to fallback/model"))).toBe(true);
		expect(result.status).toBe("done");
		expect(runner.sessionId).toBe("fallback-session-id");
	});

	it("handles streaming text deltas and done event in a standard turn", async () => {
		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "provider/model",
		});

		const deltas: string[] = [];
		const result = await runner.runTurn("Test prompt", {
			onTextDelta: (d) => deltas.push(d),
		});

		expect(deltas.join("")).toBe("Agent completed task.");
		expect(result.text).toBe("Agent completed task.");
		expect(result.status).toBe("done");
	});

	it("handles tool.approval_required: extracts proposal, requests approval, and records hash in reviewBroker", async () => {
		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "provider/model",
		});

		let turnCount = 0;
		mockTrueForgeClient.sessions.createTurnStream = async (sessionId: string, opts: any) => {
			turnCount++;
			sessionTurns.push({ sessionId, opts });

			if (turnCount === 1) {
				// First turn calls propose_edit, emitting tool.approval_required
				return (async function* () {
					yield {
						data: {
							id: "msg-1",
							type: "model.message",
							role: "assistant",
							toolCalls: [
								{
									id: "call-edit-1",
									type: "function",
									function: {
										name: "propose_edit",
										arguments: JSON.stringify({
											path: "file.txt",
											edits: [{ old_text: "Original content", new_text: "Updated content" }],
										}),
									},
								},
							],
						},
					};
					yield {
						data: {
							type: "tool.approval_required",
							threadId: "thread-xyz",
							toolCalls: [
								{
									id: "call-edit-1",
									sourceEventId: "msg-1",
								},
							],
						},
					};
				})();
			} else {
				// Second turn (resumed with approval)
				return (async function* () {
					yield {
						data: {
							type: "model.message.delta",
							content: "File edit applied successfully.",
						},
					};
					yield {
						data: {
							type: "turn.done",
							state: { status: "done" },
						},
					};
				})();
			}
		};

		let approvalReceived: any = null;
		const result = await runner.runTurn("Please edit file.txt", {
			onApprovalRequired: async (approval) => {
				approvalReceived = approval;
				return { allow: true };
			},
		});

		expect(approvalReceived).toBeDefined();
		expect(approvalReceived.toolName).toBe("propose_edit");
		expect(approvalReceived.proposal).toBeDefined();
		expect(approvalReceived.proposal.hunks.length).toBe(1);

		// Verified that user approval was recorded in reviewBroker
		const hash = approvalReceived.proposal.hash;
		expect(reviewBroker.hasApproval(hash)).toBe(true);

		// Verified resumption turn input
		expect(sessionTurns.length).toBe(2);
		const resumeInput = sessionTurns[1].opts.input;
		expect(resumeInput).toEqual([
			{
				type: "user.tool_approval",
				threadId: "thread-xyz",
				toolCallId: "call-edit-1",
				approval: { status: "allow" },
			},
		]);

		expect(result.text).toBe("File edit applied successfully.");
	});

	it("cancels running session cleanly", async () => {
		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "provider/model",
		});

		await runner.initSession();
		await runner.cancel();

		expect(mockTrueForgeClient._cancelledSession).toBe("session-1");
	});
});
