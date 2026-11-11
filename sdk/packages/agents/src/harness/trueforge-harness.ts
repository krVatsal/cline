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

	constructor(options: TrueForgeHarnessOptions = {}) {
		const baseUrl =
			options.baseUrl ||
			process.env.TRUEFORGE_BASE_URL ||
			"http://localhost:8790";
		const token =
			options.token ||
			process.env.TFY_API_KEY ||
			process.env.TRUEFOUNDRY_API_KEY;

		this.client = new TrueForge({
			baseUrl,
			token,
		});

		// Fallback client for IPv6 loopback on Windows if localhost/127.0.0.1 fails
		if (!options.baseUrl && !process.env.TRUEFORGE_BASE_URL) {
			this.fallbackClient = new TrueForge({
				baseUrl: "http://[::1]:8790",
				token,
			});
		}

		this.configuredModelName =
			options.model ||
			process.env.TRUEFORGE_MODEL;
	}

	private async withClient<T>(operation: (client: TrueForge) => Promise<T>): Promise<T> {
		try {
			return await operation(this.client);
		} catch (error: any) {
			if (this.fallbackClient && (error?.message?.includes("fetch failed") || error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED")) {
				return await operation(this.fallbackClient);
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
			let systemPrompt =
				(typeof ctx.config.systemPrompt === "string" ? ctx.config.systemPrompt : "") ||
				"You are Zentrix, an autonomous AI software engineering assistant.";

			// Ensure the model knows it is Zentrix with full execution capabilities
			systemPrompt += "\n\n# Capabilities & Persona\nYou are Zentrix, an autonomous software engineering assistant running inside VS Code.\nYou can execute terminal commands, edit and create files, search code, and assist users with all development tasks.\nAlways answer user prompts directly, proactively, and clearly. When asked to execute commands or write code, provide the exact commands and code necessary. Never claim to be unable to execute commands or be in a restricted sandbox unless specifically instructed.";

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

				// Handle tool calls if emitted by the model
				const toolCalls = (event as any).toolCalls;
				if (Array.isArray(toolCalls) && toolCalls.length > 0) {
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
							accumulatedText += formatted;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: formatted,
								accumulatedText,
							});
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
				if (Array.isArray(toolCalls) && toolCalls.length > 0 && !accumulatedText) {
					for (const tc of toolCalls) {
						const fnName = tc.function?.name || tc.name;
						if (fnName === "ask_user_question") {
							try {
								const args = JSON.parse(tc.function?.arguments || "{}");
								const question = args.question || "Please clarify:";
								const options = Array.isArray(args.options) ? args.options.map((o: string) => `• ${o}`).join("\n") : "";
								accumulatedText = `**${question}**\n\n${options}`;
								await ctx.emit({
									type: "assistant-text-delta",
									snapshot: ctx.snapshot(),
									iteration: ctx.snapshot().iteration,
									text: accumulatedText,
									accumulatedText,
								});
							} catch {}
						}
					}
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
			if (accumulatedReasoning.trim()) {
				accumulatedText = accumulatedReasoning.trim();
			} else {
				accumulatedText = "I'm ready to assist with your coding tasks, running commands, and workspace operations. What would you like to run or build?";
			}
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
	}
}
