import { describe, it, expect, beforeEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { TurnRunner } from "../turn-runner";
import { classifyTurnError } from "../resilience";
import { changeLog } from "../../core/change-log";

describe("Phase C: Resilience Run Guard Tests", () => {
	let tempDir: string;
	let mockEditorServer: any;
	let mockTrueForgeClient: any;
	let createdSessions: any[];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `forge-resilience-test-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		changeLog.clear();

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

	it("C1: error classifier categorizes turn errors correctly into AUTH, NETWORK, TRUEFORGE_DOWN, MODEL_FATAL, RETRYABLE", () => {
		// RETRYABLE
		expect(classifyTurnError({ status: 429 })).toBe("RETRYABLE");
		expect(classifyTurnError(new Error("Rate limit exceeded"))).toBe("RETRYABLE");
		expect(classifyTurnError(new Error("HTTP 503 Service Unavailable"))).toBe("RETRYABLE");

		// AUTH
		expect(classifyTurnError({ status: 401 })).toBe("AUTH");
		expect(classifyTurnError({ status: 403 })).toBe("AUTH");
		expect(classifyTurnError(new Error("Invalid API key provided"))).toBe("AUTH");
		expect(classifyTurnError(new Error("Unauthorized access"))).toBe("AUTH");
		expect(classifyTurnError(new Error("Authentication failed for provider"))).toBe("AUTH");

		// NETWORK (model endpoint)
		expect(classifyTurnError(new Error("[Model Error] Cannot connect to API: Connection refused"))).toBe("NETWORK");
		expect(classifyTurnError(new Error("[Model Error] fetch failed: ETIMEDOUT"))).toBe("NETWORK");
		expect(classifyTurnError(new Error("[Model Error] Request failed: ENOTFOUND"))).toBe("NETWORK");

		// TRUEFORGE_DOWN (SDK call to TrueForge base URL failed)
		expect(classifyTurnError(new Error("fetch failed"), true)).toBe("TRUEFORGE_DOWN");
		expect(classifyTurnError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8790" })).toBe("TRUEFORGE_DOWN");

		// MODEL_FATAL
		expect(classifyTurnError(new Error("Model 'groq/xyz' not found"))).toBe("MODEL_FATAL");
		expect(classifyTurnError({ status: 400, message: "Invalid model specified" })).toBe("MODEL_FATAL");
		expect(classifyTurnError(new Error("tool call validation failed: parameters for tool call_tool did not match schema"))).toBe("MODEL_FATAL");
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
				throw new Error("Model groq/nonexistent not found");
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
		expect(thrownError.message).toContain("No fallback model configured");
	});

	it("C5a: AUTH error on primary -> automatically switches to fallback and succeeds", async () => {
		mockTrueForgeClient.sessions.createTurnStream = async (sessionId: string) => {
			if (sessionId === "session-1") {
				const err: any = new Error("Invalid API key provided for groq");
				err.status = 401;
				throw err;
			}
			return (async function* () {
				yield { data: { type: "model.message.delta", content: "Fallback succeeded after Auth error" } };
				yield { data: { type: "turn.done", state: { status: "done" } } };
			})();
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "groq/bad-key-model",
			fallbackModel: "google-gemini/gemini-2.5-flash",
		});

		const result = await runner.runTurn("Test auth error fallback");
		expect(result.text).toBe("Fallback succeeded after Auth error");
		expect(createdSessions.length).toBe(2);
		expect(runner.model).toBe("google-gemini/gemini-2.5-flash");
	});

	it("C5b: AUTH error without fallback -> surfaces clean error without stack trace", async () => {
		mockTrueForgeClient.sessions.createTurnStream = async () => {
			const err: any = new Error("Invalid API key for primary provider");
			err.status = 401;
			throw err;
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "groq/bad-key-model",
		});

		let thrownError: any = null;
		try {
			await runner.runTurn("Test auth fatal without fallback");
		} catch (err: any) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		expect(thrownError.message).toContain("AUTH");
		expect(thrownError.message).toContain("No fallback model configured");
	});

	it("C6a: NETWORK error from model endpoint -> automatically switches to fallback", async () => {
		mockTrueForgeClient.sessions.createTurnStream = async (sessionId: string) => {
			if (sessionId === "session-1") {
				throw new Error("[Model Error] Cannot connect to API: Headers Timeout Error");
			}
			return (async function* () {
				yield { data: { type: "model.message.delta", content: "Fallback succeeded after Network error" } };
				yield { data: { type: "turn.done", state: { status: "done" } } };
			})();
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "primary-model",
			fallbackModel: "fallback-model",
		});

		const result = await runner.runTurn("Test network error fallback");
		expect(result.text).toBe("Fallback succeeded after Network error");
		expect(createdSessions.length).toBe(2);
		expect(runner.model).toBe("fallback-model");
	});

	it("C7: TRUEFORGE_DOWN never falls back and prompts to start TrueForge", async () => {
		mockTrueForgeClient.sessions.create = async () => {
			const err: any = new Error("connect ECONNREFUSED 127.0.0.1:8790");
			err.code = "ECONNREFUSED";
			throw err;
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "primary-model",
			fallbackModel: "fallback-model",
			baseUrl: "http://127.0.0.1:8790",
		});

		let thrownError: any = null;
		try {
			await runner.runTurn("Test trueforge down");
		} catch (err: any) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		expect(thrownError.message).toContain("Cannot reach TrueForge at http://127.0.0.1:8790");
		expect(thrownError.message).toContain("npx @truefoundry/trueforge@latest");
		// Verify it did NOT attempt fallback
		expect(createdSessions.length).toBe(0);
	});

	it("C8: change already applied -> no replay or fallback, surfaces error and list of applied changes", async () => {
		mockTrueForgeClient.sessions.createTurnStream = async (sessionId: string) => {
			// Simulate that before failing, an approved change was recorded to changeLog
			changeLog.pushChange({
				filePath: path.join(tempDir, "src/flask/helpers.py"),
				relativePath: "src/flask/helpers.py",
				beforeText: "old content",
				afterText: "new content",
			});

			const err: any = new Error("Model failed midway after file change");
			err.status = 500;
			throw err;
		};

		const runner = new TurnRunner({
			client: mockTrueForgeClient,
			editorServer: mockEditorServer,
			model: "primary-model",
			fallbackModel: "fallback-model",
		});

		let thrownError: any = null;
		try {
			await runner.runTurn("Test no replay when change already applied");
		} catch (err: any) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		expect(thrownError.message).toContain("Changes were already applied to: src/flask/helpers.py");
		expect(thrownError.message).toContain("Replay aborted to prevent duplicate changes");
		// Verify no second session was created for fallback
		expect(createdSessions.length).toBe(1);
	});
});
