import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
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
		const baseUrl =
			options.baseUrl ||
			process.env.TRUEFORGE_BASE_URL ||
			"http://127.0.0.1:8790";
		const token =
			options.token ||
			process.env.TFY_API_KEY ||
			process.env.TRUEFOUNDRY_API_KEY;

		this.client = new TrueForge({
			baseUrl,
			token,
		});

		// Fallback client for localhost / IPv6 loopback on Windows if 127.0.0.1 fails
		if (!options.baseUrl && !process.env.TRUEFORGE_BASE_URL) {
			this.fallbackClient = new TrueForge({
				baseUrl: "http://localhost:8790",
				token,
			});
		}

		this.configuredModelName =
			options.model ||
			process.env.TRUEFORGE_MODEL;
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
		if (TrueForgeHarness.isSpawning) {
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 400));
				try {
					const res = await fetch("http://127.0.0.1:8790/api/v1/models");
					if (res.ok) return true;
				} catch {}
			}
			return false;
		}

		TrueForgeHarness.isSpawning = true;
		try {
			const cliPath = TrueForgeHarness.findTrueForgeCli();
			const env = {
				...process.env,
				HOST: "0.0.0.0",
				NETWORK_POLICY_ENABLED: "false",
			};

			if (cliPath && fs.existsSync(cliPath)) {
				const child = spawn(process.execPath, [cliPath, "--port", "8790"], {
					detached: true,
					stdio: "ignore",
					env,
					windowsHide: true,
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

			// Wait up to 10 seconds for server to respond
			for (let i = 0; i < 25; i++) {
				await new Promise((r) => setTimeout(r, 400));
				try {
					const res = await fetch("http://127.0.0.1:8790/api/v1/models");
					if (res.ok) return true;
				} catch {}
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
				error?.cause?.code === "ECONNREFUSED";

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
			}

			throw error;
		}
	}

	private async resolveModelName(requestedModelId?: string): Promise<string> {
		if (this.configuredModelName?.trim()) {
			return this.configuredModelName.trim();
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

	public async run(
		ctx: AgentHarnessContext,
		input?: AgentRunInput,
	): Promise<AgentRunResult> {
		ctx.throwIfAborted();

		const snapshot = ctx.snapshot();
		const conversationId = snapshot.conversationId ?? "default";

		// 1. Resolve or create TrueForge session for this conversation
		let sessionId = TrueForgeHarness.sessionsByConversation.get(conversationId);
		if (!sessionId) {
			let basePrompt = (typeof ctx.config.systemPrompt === "string" ? ctx.config.systemPrompt : "").trim();

			// Strip any legacy mandates forcing API tool calls since tools are not exposed via function-calling schemas
			basePrompt = basePrompt
				.replace(/IMPORTANT:\s*Always includes? tool calls[^\n]*/gi, "")
				.replace(/Response without tool calls will considered as completed[^\n]*/gi, "")
				.replace(/run independent inspection commands in one run_commands call[;,]?/gi, "")
				.replace(/read all known relevant files in one read_files call[;,]?/gi, "");

			let systemPrompt = basePrompt || "You are Zentrix, an autonomous AI software engineering assistant.";

			systemPrompt += `\n\n# Execution & Command Guidelines
You are Zentrix, an autonomous software engineering assistant running inside VS Code.
You assist users with all development tasks: writing code, running terminal commands, creating and editing files, and debugging.

CRITICAL INSTRUCTIONS FOR ACTIONS AND COMMANDS:
1. Do NOT invoke or emit JSON/API function calls or tools (such as run_commands, execute_command, or ask_user_question) via function-call schemas.
2. When the user asks you to run, execute, clone, pull, test, or build anything, ALWAYS provide the exact, executable terminal command inside standard markdown bash blocks:
\`\`\`bash
git clone <repo-url>
\`\`\`
3. Always explain clearly what each command does and provide complete, functional, runnable commands.
4. Never state that you cannot execute commands or that you are in a restricted sandbox. Provide the necessary command and instructions directly and proactively.`;

			const modelObj = ctx.config.model;
			const requestedModel =
				(typeof (ctx.config as any).modelId === "string" ? (ctx.config as any).modelId : undefined) ||
				(typeof modelObj === "string" ? modelObj : undefined) ||
				(modelObj && typeof (modelObj as any).modelId === "string" ? (modelObj as any).modelId : undefined) ||
				(modelObj && typeof (modelObj as any).name === "string" ? (modelObj as any).name : undefined) ||
				(typeof (snapshot as any).modelId === "string" ? (snapshot as any).modelId : undefined);

			const modelName = await this.resolveModelName(requestedModel);

			const sessionResponse = await this.withClient((c) =>
				c.sessions.create({
					agent: {
						spec: {
							instructions: systemPrompt,
							model: {
								name: modelName,
							},
							config: {
								askUserQuestions: { enabled: false },
								dynamicSubAgents: { enabled: false },
							},
						},
					},
				}),
			);

			const createdId = sessionResponse.data?.id;
			if (!createdId) {
				throw new Error("TrueForge did not return a session ID");
			}
			sessionId = createdId;
			TrueForgeHarness.sessionsByConversation.set(conversationId, sessionId);
		}

		// 2. Extract user input text
		let promptText = "";
		if (typeof input === "string") {
			promptText = input;
		} else if (input && typeof input === "object") {
			if ("content" in input && Array.isArray((input as any).content)) {
				const parts = (input as any).content;
				promptText = parts
					.filter((part: any) => part && part.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text)
					.join("\n");
			} else if (Array.isArray(input)) {
				const lastMsg = input[input.length - 1];
				if (lastMsg && "content" in lastMsg && Array.isArray(lastMsg.content)) {
					promptText = lastMsg.content
						.filter((part: any) => part && part.type === "text" && typeof part.text === "string")
						.map((part: any) => part.text)
						.join("\n");
				}
			}
		}

		if (!promptText && snapshot.messages.length > 0) {
			const lastMsg = snapshot.messages[snapshot.messages.length - 1];
			if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
				promptText = lastMsg.content
					.filter((part: any) => part && part.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text)
					.join("\n");
			}
		}

		if (!promptText) {
			promptText = "Continue";
		}

		// 3. Initiate turn streaming from TrueForge
		try {
			const stream = await this.withClient((c) =>
				c.sessions.createTurnStream(sessionId, {
					input: [
						{
							type: "user.message",
							content: promptText,
						},
					],
				}),
			);

			let accumulatedText = "";
			let accumulatedReasoning = "";
			const finishReason: AgentModelFinishReason = "stop";

			const handleToolCalls = async (toolCalls: any[]) => {
				if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;
				for (const tc of toolCalls) {
					const fnName = tc.function?.name || tc.toolInfo?.name || tc.name;
					const fnArgs = tc.function?.arguments || tc.arguments;
					let parsedArgs: any = {};
					try {
						parsedArgs = typeof fnArgs === "string" ? JSON.parse(fnArgs) : fnArgs;
					} catch {}

					if (fnName === "ask_user_question") {
						const question = parsedArgs?.question || "Please clarify:";
						const options = Array.isArray(parsedArgs?.options)
							? parsedArgs.options.map((opt: string) => `• ${opt}`).join("\n")
							: "";
						const formatted = `\n\n**${question}**\n\n${options}\n`;
						if (!accumulatedText.includes(question)) {
							accumulatedText += formatted;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: formatted,
								accumulatedText,
							});
						}
					} else if (fnName === "run_commands" || fnName === "execute_command") {
						const cmds = parsedArgs?.commands || (parsedArgs?.command ? [parsedArgs.command] : []);
						const cmdText = cmds.length > 0 ? `\n\n\`\`\`bash\n${cmds.join("\n")}\n\`\`\`\n` : "";
						if (cmdText && !accumulatedText.includes(cmds[0])) {
							accumulatedText += cmdText;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: cmdText,
								accumulatedText,
							});
						}
					}
				}
			};

			for await (const event of stream) {
				ctx.throwIfAborted();

				if (event.type === "model.message.delta") {
					// Handle streaming reasoning (thinking) content from Groq/Qwen/GPT-OSS
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
						accumulatedText += delta;
						await ctx.emit({
							type: "assistant-text-delta",
							snapshot: ctx.snapshot(),
							iteration: ctx.snapshot().iteration,
							text: delta,
							accumulatedText,
						});
					}

					// Handle tool calls in deltas
					const toolCalls = (event as any).toolCalls;
					if (toolCalls) {
						await handleToolCalls(toolCalls);
					}
				} else if (event.type === "model.message") {
					const content = (event as any).content;
					if (content && !accumulatedText) {
						accumulatedText = content;
						await ctx.emit({
							type: "assistant-text-delta",
							snapshot: ctx.snapshot(),
							iteration: ctx.snapshot().iteration,
							text: content,
							accumulatedText,
						});
					}

					const toolCalls = (event as any).toolCalls;
					if (toolCalls) {
						await handleToolCalls(toolCalls);
					}
				} else if (event.type === "tool.response_required") {
					const toolCalls = (event as any).toolCalls;
					if (toolCalls) {
						await handleToolCalls(toolCalls);
					}
				} else if (event.type === "turn.done") {
					const output = (event as any).state?.output;
					if (output?.content && !accumulatedText) {
						accumulatedText = output.content;
						await ctx.emit({
							type: "assistant-text-delta",
							snapshot: ctx.snapshot(),
							iteration: ctx.snapshot().iteration,
							text: accumulatedText,
							accumulatedText,
						});
					}

					const toolCalls = output?.toolCalls;
					if (toolCalls && !accumulatedText) {
						await handleToolCalls(toolCalls);
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

			// Ensure the assistant never leaves the user with an empty response
			if (!accumulatedText.trim()) {
				accumulatedText = "I'm ready to assist with your coding tasks, running commands, and workspace operations. What would you like to run or build?";
				await ctx.emit({
					type: "assistant-text-delta",
					snapshot: ctx.snapshot(),
					iteration: ctx.snapshot().iteration,
					text: accumulatedText,
					accumulatedText,
				});
			}

			// 4. Record assistant message in transcript
			const assistantMessage: AgentMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: "assistant",
				content: accumulatedText ? [{ type: "text", text: accumulatedText }] : [],
				createdAt: Date.now(),
			};

			await ctx.recordAssistantMessage(assistantMessage, finishReason);

			return ctx.finishRun("completed", assistantMessage, accumulatedText);
		} catch (error: any) {
			// In case of a session failure (e.g. 400 error), evict the cached session so next turn recovers cleanly
			TrueForgeHarness.sessionsByConversation.delete(conversationId);
			throw error;
		}
	}
}
