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
	 * Default model name (e.g. "moonshot/kimi-k3-fast").
	 * Defaults to `process.env.TRUEFORGE_MODEL` or "moonshot/kimi-k3-fast".
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
	private readonly configuredModelName?: string;
	private readonly sessionsByConversation = new Map<string, string>();

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
		this.configuredModelName =
			options.model ||
			process.env.TRUEFORGE_MODEL;
	}

	private async resolveModelName(): Promise<string> {
		if (this.configuredModelName?.trim()) {
			return this.configuredModelName.trim();
		}
		const envModel = process.env.TRUEFORGE_MODEL;
		if (envModel?.trim()) {
			return envModel.trim();
		}
		try {
			const modelsResponse = await this.client.models.list();
			const activeModels = modelsResponse.data ?? [];
			if (activeModels.length > 0 && activeModels[0]?.name) {
				return activeModels[0].name;
			}
		} catch (error) {
			console.warn("[TrueForgeHarness] Could not query active models list from TrueForge:", error);
		}
		return "groq/llama-3-3-70b-versatile";
	}

	public async run(
		ctx: AgentHarnessContext,
		input?: AgentRunInput,
	): Promise<AgentRunResult> {
		ctx.throwIfAborted();

		const snapshot = ctx.snapshot();
		const conversationId = snapshot.conversationId ?? "default";

		// 1. Resolve or create TrueForge session for this conversation
		let sessionId = this.sessionsByConversation.get(conversationId);
		if (!sessionId) {
			const systemPrompt =
				(typeof ctx.config.systemPrompt === "string" ? ctx.config.systemPrompt : "") ||
				"You are a helpful coding assistant.";

			const modelName = await this.resolveModelName();

			const sessionResponse = await this.client.sessions.create({
				agent: {
					spec: {
						instructions: systemPrompt,
						model: {
							name: modelName,
						},
					},
				},
			});

			const createdId = sessionResponse.data?.id;
			if (!createdId) {
				throw new Error("TrueForge did not return a session ID");
			}
			sessionId = createdId;
			this.sessionsByConversation.set(conversationId, sessionId);
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
		const stream = await this.client.sessions.createTurnStream(sessionId, {
			input: [
				{
					type: "user.message",
					content: promptText,
				},
			],
		});

		let accumulatedText = "";
		const finishReason: AgentModelFinishReason = "stop";

		for await (const event of stream) {
			ctx.throwIfAborted();

			if (event.type === "model.message.delta") {
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
			} else if (event.type === "turn.done") {
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
