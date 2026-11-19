import { describe, it, expect, beforeEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { TurnRunner } from "../turn-runner";
import { classifyTurnError } from "../resilience";

describe("Phase C: Resilience Run Guard Tests", () => {
	let tempDir: string;
	let mockEditorServer: any;
	let mockTrueForgeClient: any;
	let createdSessions: any[];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `forge-resilience-test-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		mockEditorServer = {
			url: "http://127.0.0.1:55555/mcp",
			port: 55555,
			token: "secret-mcp-token",
			workspaceRoot: tempDir,
		};

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
				createTurnStream: async () => {},
				cancel: async () => {},
			},
		};
	});

	it("C1: error classifier categorizes turn errors correctly", () => {
		expect(classifyTurnError({ status: 429 })).toBe("RETRYABLE");
		expect(classifyTurnError(new Error("Rate limit exceeded"))).toBe("RETRYABLE");
		expect(classifyTurnError(new Error("HTTP 503 Service Unavailable"))).toBe("RETRYABLE");
		expect(classifyTurnError(new Error("Model 'groq/xyz' not found"))).toBe("MODEL_FATAL");
		expect(classifyTurnError({ status: 400, message: "Invalid model specified" })).toBe("MODEL_FATAL");
		expect(classifyTurnError({ status: 401 })).toBe("OTHER_FATAL");
	});

	it("C4a: 429 then success -> succeeds on retry 2", async () => {
		let attempts = 0;
		mockTrueForgeClient.sessions.createTurnStream = async () => {
			attempts++;
			if (attempts === 1) {
				const err: any = new Error("Rate limit exceeded (429)");
				err.status = 429;
				throw err;
			}
			return (async function* () {
				yield { data: { type: "model.message.delta", content: "Success on retry" } };
				yield { data: { type: "turn.done", state: { status: "done" } } };
			})();
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "primary-model",
		});

		const result = await runner.runTurn("Test retryable");
		expect(attempts).toBe(2);
		expect(result.text).toBe("Success on retry");
		expect(result.status).toBe("done");
	});

	it("C4b: 3x 503 -> fails after 3 retries with clear message", async () => {
		let attempts = 0;
		mockTrueForgeClient.sessions.createTurnStream = async () => {
			attempts++;
			const err: any = new Error("Service Unavailable (503)");
			err.status = 503;
			throw err;
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "primary-model",
		});

		let thrownError: any = null;
		try {
			await runner.runTurn("Test 503 exhaustion");
		} catch (err: any) {
			thrownError = err;
		}

		expect(attempts).toBe(3);
		expect(thrownError).toBeDefined();
		expect(thrownError.message).toContain("503");
	}, 15000);

	it("C4c: model_not_found on primary -> switches to fallback and succeeds", async () => {
		mockTrueForgeClient.sessions.createTurnStream = async (sessionId: string) => {
			if (sessionId === "session-1") {
				const err = new Error("Model groq/nonexistent not found");
				throw err;
			}
			return (async function* () {
				yield { data: { type: "model.message.delta", content: "Fallback model succeeded" } };
				yield { data: { type: "turn.done", state: { status: "done" } } };
			})();
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "groq/nonexistent",
			fallbackModel: "groq/working-fallback",
		});

		const result = await runner.runTurn("Test fallback switch");
		expect(result.text).toBe("Fallback model succeeded");
		expect(createdSessions.length).toBe(2);
		expect(createdSessions[1].agent.spec.model.name).toBe("groq/working-fallback");
		expect(runner.model).toBe("groq/working-fallback");
	});

	it("C4d: model_not_found with no fallback configured -> surfaces clean error naming the model id", async () => {
		mockTrueForgeClient.sessions.createTurnStream = async () => {
			throw new Error("Model groq/invalid-xyz not found");
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "groq/invalid-xyz",
		});

		let thrownError: any = null;
		try {
			await runner.runTurn("Test fatal model without fallback");
		} catch (err: any) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		expect(thrownError.message).toContain('Model "groq/invalid-xyz" failed');
		expect(thrownError.message).toContain("cline.trueforge.modelId");
	});
});
