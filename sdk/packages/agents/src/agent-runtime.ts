import {
	classifyProviderError,
	createGateway,
	type GatewayProviderSettings,
	isRetryableProviderError,
} from "@cline/llms";
import type {
	AgentAfterToolResult,
	AgentBeforeModelResult,
	AgentBeforeToolResult,
	AgentMessage,
	AgentMessagePart,
	AgentModel,
	AgentModelEvent,
	AgentModelFinishReason,
	AgentModelRequest,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentRuntimeHooks,
	AgentRuntimeStateSnapshot,
	AgentStopControl,
	AgentTool,
	AgentToolCallPart,
	AgentToolDefinition,
	AgentToolResult,
	AgentUsage,
	AgentRuntimeConfig as BaseAgentRuntimeConfig,
	CaptureTaskLifecycleEventInput,
	ProviderErrorClass,
	TelemetryProperties,
	ToolApprovalResult,
	ToolPolicy,
} from "@cline/shared";
import {
	captureAgentUnexpectedReasoningTokens,
	captureSdkError,
	captureTaskLifecycleEvent,
	estimateTokens,
	mergeModelOptions,
	normalizeJsonLikeStringsForSchema,
	omitUndefinedValues,
	TASK_CANCELLED_EVENT,
	TASK_PROVIDER_STREAM_FAILED_EVENT,
	TOOL_REJECTION_SUFFIX,
	trimNonEmpty,
} from "@cline/shared";
import { nanoid } from "nanoid";
import { TrueForgeHarness } from "./harness/trueforge-harness";

/** A model request after turn preparation, ready to be issued (possibly more than once). */
interface PreparedModelRequest {
	request: AgentModelRequest;
	/** When preparation began; anchors the provider-request lifecycle timings. */
	startedAt: number;
}

export const MAX_TOKENS_INCOMPLETE_TURN_MESSAGE =
	"Model reached the maximum output token limit before completing the turn";

/**
 * How many times a turn that ends at the model's output-token limit without a
 * usable tool call is retried before the run fails. Each retry nudges the model
 * to be more concise (see MAX_TOKENS_RECOVERY_NUDGE). The counter resets on any
 * turn that makes progress (produces a tool call), so this bounds only a *run*
 * of consecutive cut-off turns — a single over-long response recovers, while a
 * model that keeps overflowing still ends rather than looping forever.
 */
export const MAX_TOKENS_RECOVERY_LIMIT = 3;
/** Nudge appended after an output-limit cut-off, asking for more concise output. */
export const MAX_TOKENS_RECOVERY_NUDGE =
	"Your previous response was cut off because it reached the model's output-token limit before finishing. Keep responses concise: take one small step at a time, avoid long explanations, and write large files or command output in smaller chunks across multiple tool calls.";

/**
 * How many times to retry a model turn that failed with a transient,
 * provider-side error (rate limits, 5xx, network hiccups, OpenRouter's
 * generic "Provider returned error"). The initial attempt is not counted, so
 * a value of 3 means up to 4 total requests for one turn. Retrying only
 * transient errors — and never auth, context-overflow, or other client errors
 * (see {@link isRetryableProviderError}) — keeps well-behaved providers on
 * their existing single-request path, so this does not change behavior for
 * models whose endpoints do not throw transient errors.
 */
export const PROVIDER_ERROR_MAX_RETRIES = 3;
/** Base backoff before the first retry; doubled each subsequent attempt. */
export const PROVIDER_ERROR_RETRY_BASE_DELAY_MS = 1_000;
/** Upper bound on any single backoff wait. */
export const PROVIDER_ERROR_RETRY_MAX_DELAY_MS = 15_000;

/**
 * Terminal message for a turn the provider blocked. Kept separate from the
 * generic empty-response text because the two call for opposite user action:
 * an empty response is worth retrying, a filtered one reproduces every time.
 */
export const CONTENT_FILTER_EMPTY_TURN_MESSAGE =
	"Model returned no content because the response was blocked by a content filter. Retrying is unlikely to help — try rephrasing the request.";

/**
 * Terminal message when a context-window overflow cannot be recovered because
 * there is no conversation history to compact — the system prompt, tools, and
 * current input alone exceed the window.
 */
export const CONTEXT_WINDOW_OVERFLOW_NOTHING_TO_COMPACT_MESSAGE =
	"The request exceeds the model's context window and there is no conversation history to compact — the system prompt, tools, and current input alone are too large. Reduce attached content or switch to a model with a larger context window.";

/**
 * Terminal message when a context-window overflow persists after the runtime
 * already compacted the conversation and retried once.
 */
export const CONTEXT_WINDOW_OVERFLOW_RECOVERY_FAILED_MESSAGE =
	"The conversation still exceeds the model's context window after compacting it. Start a new session or switch to a model with a larger context window.";

/**
 * Terminal message when no compaction pipeline is available to recover from a
 * context-window overflow (e.g. compaction disabled).
 */
export const CONTEXT_WINDOW_OVERFLOW_NO_RECOVERY_MESSAGE =
	"The conversation exceeds the model's context window. Compact the conversation, start a new session, or switch to a model with a larger context window.";

/** Thrown when overflow recovery cannot proceed; carries the terminal text. */
class ContextWindowOverflowError extends Error {
	constructor(message: string, providerError: string | undefined) {
		super(
			providerError?.trim()
				? `${message} (provider reported: ${providerError.trim()})`
				: message,
		);
		this.name = "ContextWindowOverflowError";
	}
}

/**
 * Exposes the runtime's internal service atoms to an external harness.
 * The harness receives this context from `execute()` and uses it to drive
 * the turn loop without depending on private `AgentRuntime` internals.
 */
export interface AgentHarnessContext {
	/** Current immutable runtime snapshot. */
	snapshot(): AgentRuntimeStateSnapshot;
	/** Emit an event to all listeners + telemetry. */
	emit(event: AgentRuntimeEvent): Promise<void>;
	/** Registered tools (read-only view). */
	readonly tools: ReadonlyMap<string, AgentTool<unknown, unknown>>;
	/** Registered hook bags (read-only view). */
	readonly hooks: Readonly<HookBag>;
	/** Resolved runtime config (read-only). */
	readonly config: Readonly<BaseAgentRuntimeConfig>;
	/** Throws AgentRuntimeAbortError if the run has been aborted. */
	throwIfAborted(): void;
	/** Run-scoped abort signal; undefined before the first execute() call. */
	readonly signal: AbortSignal | undefined;
	/** Update cumulative usage counters and emit usage-updated. */
	updateUsage(usage: Partial<AgentUsage>): Promise<void>;
	/** Append an assistant message to the transcript and emit message-added + assistant-message. */
	recordAssistantMessage(message: AgentMessage, finishReason: AgentModelFinishReason): Promise<void>;
	/** Assemble a completed AgentRunResult without ending the run. */
	finishRun(
		status: AgentRunResult["status"],
		assistantMessage?: AgentMessage,
		outputText?: string,
	): AgentRunResult;
	/** Add a user-role reminder message to the transcript. */
	addUserReminderMessage(
		text: string,
		metadata?: AgentMessage["metadata"],
	): Promise<AgentMessage>;
	/**
	 * Prepare and normalise a tool call for execution:
	 * input coercion, beforeTool hooks, policy resolution.
	 * Returns a PreparedToolExecution ready for executePreparedTool().
	 */
	prepareToolExecution(toolCall: AgentToolCallPart): Promise<PreparedToolExecution>;
	/**
	 * Execute a prepared tool call: run tool.execute(), afterTool hooks,
	 * successContext injection, and emit tool-started / tool-finished events.
	 */
	executePreparedTool(prepared: PreparedToolExecution): Promise<AgentMessage>;
}

/**
 * A harness drives the agentic turn loop. Implement this interface and pass
 * it via `AgentRuntimeConfig.harness` to provide a custom loop, retry, and
 * tool-dispatch strategy.
 *
 * The runtime calls `harness.run(ctx)` after initialization and state reset,
 * with an AgentHarnessContext that exposes the runtime's service atoms.
 *
 * TODO: Replace with TrueForge harness implementation.
 */
export interface AgentHarness {
	run(ctx: AgentHarnessContext, input?: AgentRunInput): Promise<AgentRunResult>;
}

// Local `createUID` helper. The clinee source imports this from
// `@cline/shared` (see `packages/shared/dist/identifier.ts`), but
// sdk-re's shared package does not expose it yet. Inlining here keeps
// PLAN.md Step 1 scoped to `packages/agents/src/` and matches the
// exact clinee implementation (`${prefix}_${nanoid(length)}`).
function createUID(prefix: string, length = 8): string {
	return `${prefix}_${nanoid(length)}`;
}

export type AgentRunInput = string | AgentMessage | readonly AgentMessage[];
export type AgentEventListener = (event: AgentRuntimeEvent) => void;

/**
 * Advanced form: caller supplies a pre-built `AgentModel`. Used by
 * `@cline/core`, which constructs models itself to share gateway/telemetry
 * wiring with the rest of the session runtime.
 */
export interface AgentRuntimeConfigWithModel extends BaseAgentRuntimeConfig {
	model: AgentModel;
	/** Pluggable harness that drives the agentic loop */
	harness?: AgentHarness;
}

/**
 * Friendly form: caller supplies provider/model IDs and credentials, and the
 * runtime builds an `AgentModel` internally via `@cline/llms`. This is the
 * entry point most standalone users want.
 */
export interface AgentRuntimeConfigWithProvider
	extends Omit<BaseAgentRuntimeConfig, "model"> {
	/** Provider ID (e.g., "anthropic", "openai") */
	providerId: string;
	/** Model ID to use */
	modelId: string;
	/** API key for the provider */
	apiKey?: string;
	/** Custom base URL for the API */
	baseUrl?: string;
	/** Additional headers for API requests */
	headers?: Record<string, string>;
	/** Provider-specific gateway options */
	options?: GatewayProviderSettings["options"];
	/** Pluggable harness that drives the agentic loop */
	harness?: AgentHarness;
}

/**
 * Config accepted by `new AgentRuntime(...)` / `createAgentRuntime(...)` /
 * `new Agent(...)` / `createAgent(...)`. Either supply a pre-built `model`
 * (advanced) or `providerId` + `modelId` (+ credentials) and the runtime will
 * construct the model itself via `@cline/llms`.
 */
export type AgentRuntimeConfig =
	| AgentRuntimeConfigWithModel
	| AgentRuntimeConfigWithProvider;

function hasPrebuiltModel(
	config: AgentRuntimeConfig,
): config is AgentRuntimeConfigWithModel {
	return (config as AgentRuntimeConfigWithModel).model !== undefined;
}

function resolveRuntimeConfig(
	config: AgentRuntimeConfig,
): BaseAgentRuntimeConfig & { harness?: AgentHarness } {
	if (hasPrebuiltModel(config)) {
		return config;
	}
	const { providerId, modelId, apiKey, baseUrl, headers, options, harness, ...rest } =
		config;
	const gateway = createGateway({
		providerConfigs: [{ providerId, apiKey, baseUrl, headers, options }],
		telemetry: rest.telemetry,
	});
	const model = gateway.createAgentModel({ providerId, modelId });
	// The prebuilt-model path preserves a caller-provided messageModelInfo;
	// mirror that here so the provider/model constructor also tags assistant
	// messages with modelInfo. An explicit caller-provided value still wins.
	const messageModelInfo = rest.messageModelInfo ?? {
		id: modelId,
		provider: providerId,
	};
	return { ...rest, model, messageModelInfo, harness };
}

function resolveToolPolicy(
	toolName: string,
	policies: BaseAgentRuntimeConfig["toolPolicies"],
	dependencies: readonly string[] = [],
): ToolPolicy {
	const policy = {
		...(policies?.["*"] ?? {}),
		...(policies?.[toolName] ?? {}),
	};
	for (const name of dependencies) {
		const dependency = {
			...policies?.["*"],
			...policies?.[name],
		};
		if (dependency.enabled === false) policy.enabled = false;
		if (dependency.autoApprove === false) policy.autoApprove = false;
	}
	return policy;
}

interface PendingToolAssembly {
	toolCallId: string;
	toolName?: string;
	inputText: string;
	inputValue?: unknown;
	metadata?: unknown;
	parseError?: string;
}

interface InvalidToolCall {
	toolCallId: string;
	toolName?: string;
	input: Record<string, unknown>;
	reason: "missing_name" | "missing_arguments" | "invalid_arguments";
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function getOutputSize(output: unknown): number {
	if (typeof output === "string") {
		return output.length;
	}
	return safeJsonSize(output);
}

function summarizeModelRequest(
	request: AgentModelRequest,
): Record<string, unknown> {
	let textChars = request.systemPrompt?.length ?? 0;
	let toolResultCount = 0;
	let toolResultChars = 0;
	let maxToolResultChars = 0;
	for (const message of request.messages) {
		for (const part of message.content) {
			switch (part.type) {
				case "text":
					textChars += part.text.length;
					break;
				case "reasoning":
					textChars += part.text.length;
					break;
				case "file":
					textChars += part.content.length;
					break;
				case "tool-call":
					textChars += safeJsonSize(part.input);
					break;
				case "tool-result": {
					const outputChars = getOutputSize(part.output);
					toolResultCount += 1;
					toolResultChars += outputChars;
					maxToolResultChars = Math.max(maxToolResultChars, outputChars);
					textChars += outputChars;
					break;
				}
			}
		}
	}

	return {
		messageCount: request.messages.length,
		toolSchemaCount: request.tools.length,
		systemPromptChars: request.systemPrompt?.length ?? 0,
		requestJsonChars: safeJsonSize({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
			options: request.options,
		}),
		visibleTextChars: textChars,
		estimatedTextTokens: estimateTokens(textChars),
		toolResultCount,
		toolResultChars,
		maxToolResultChars,
	};
}

export interface PreparedToolExecution {
	toolCall: AgentToolCallPart;
	tool?: AgentTool;
	input: unknown;
	skipReason?: string;
}

export interface HookBag {
	beforeRun: NonNullable<AgentRuntimeHooks["beforeRun"]>[];
	afterRun: NonNullable<AgentRuntimeHooks["afterRun"]>[];
	beforeModel: NonNullable<AgentRuntimeHooks["beforeModel"]>[];
	afterModel: NonNullable<AgentRuntimeHooks["afterModel"]>[];
	beforeTool: NonNullable<AgentRuntimeHooks["beforeTool"]>[];
	afterTool: NonNullable<AgentRuntimeHooks["afterTool"]>[];
	onEvent: NonNullable<AgentRuntimeHooks["onEvent"]>[];
}

class ControlledStopError extends Error {
	readonly reason?: string;

	constructor(reason?: string) {
		super(reason ?? "Run stopped by runtime control");
		this.name = "ControlledStopError";
		this.reason = reason;
	}
}

export class AgentRuntimeAbortError extends Error {
	readonly reason?: unknown;

	constructor(reason?: unknown) {
		const message =
			typeof reason === "string"
				? reason
				: reason instanceof Error
					? reason.message
					: reason === undefined
						? "Run aborted"
						: String(reason);
		super(message);
		this.name = "AgentRuntimeAbortError";
		this.reason = reason;
	}
}

const DEFAULT_USAGE: AgentUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

function createMessage(
	role: AgentMessage["role"],
	content: AgentMessagePart[],
	metadata?: Record<string, unknown>,
): AgentMessage {
	return {
		id: createUID("msg"),
		role,
		content,
		createdAt: Date.now(),
		metadata,
	};
}

function cloneUsage(usage: AgentUsage): AgentUsage {
	return { ...usage };
}

const HOOK_ATTRIBUTE_ESCAPES: Record<string, string> = {
	_: "__",
	'"': "_q_",
	"<": "_lt_",
	">": "_gt_",
};

function sanitizeHookAttribute(value: string): string {
	// The underscore escapes itself, which makes the encoding injective
	// (uniquely decodable escape code): no two distinct ids can collapse to
	// the same sanitized stamp.
	return value.replace(/[_"<>]/g, (char) => HOOK_ATTRIBUTE_ESCAPES[char]);
}

/**
 * Where a hook context block came from. Tool hooks carry the call they ran
 * for; run-start hooks (TaskStart/UserPromptSubmit/TaskResume in their
 * various layer spellings) have no tool identity, and the layers merge their
 * outputs before the runtime sees them, so a single generic source labels
 * those blocks.
 */
type HookContextOrigin =
	| { source: "RunStart" }
	| {
			source: "PreToolUse" | "PostToolUse" | "ToolSuccess";
			toolCall: AgentToolCallPart;
	  };

function formatHookContextBlock(
	origin: HookContextOrigin,
	text: string,
): string {
	// Tool identity keeps each block attributable to its call: contexts are
	// batched into one message after the tool results, and parallel tool
	// execution collects them in completion order, so position alone cannot
	// identify the tool. Attribute values are sanitized and embedded
	// hook_context tags (opening and closing) neutralized so neither
	// provider-supplied ids nor hook output can corrupt or spoof the block
	// markup.
	const attributes = [`source="${origin.source}"`];
	if ("toolCall" in origin) {
		attributes.push(
			`tool_name="${sanitizeHookAttribute(origin.toolCall.toolName)}"`,
			`tool_call_id="${sanitizeHookAttribute(origin.toolCall.toolCallId)}"`,
		);
	}
	const body = text.trim().replace(/<(\/?)hook_context/gi, "<\\$1hook_context");
	return `<hook_context ${attributes.join(" ")}>\n${body}\n</hook_context>`;
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => ({
		...message,
		content: message.content.map((part: AgentMessagePart) => ({ ...part })),
		metadata: message.metadata ? { ...message.metadata } : undefined,
		modelInfo: message.modelInfo ? { ...message.modelInfo } : undefined,
		metrics: message.metrics ? { ...message.metrics } : undefined,
	}));
}

export function usageDelta(
	start: AgentUsage,
	end: AgentUsage,
): NonNullable<AgentMessage["metrics"]> | undefined {
	const inputTokens = Math.max(
		0,
		(end.inputTokens ?? 0) - (start.inputTokens ?? 0),
	);
	const outputTokens = Math.max(
		0,
		(end.outputTokens ?? 0) - (start.outputTokens ?? 0),
	);
	const cacheReadTokens = Math.max(
		0,
		(end.cacheReadTokens ?? 0) - (start.cacheReadTokens ?? 0),
	);
	const cacheWriteTokens = Math.max(
		0,
		(end.cacheWriteTokens ?? 0) - (start.cacheWriteTokens ?? 0),
	);
	const reasoningTokenCount = Math.max(
		0,
		(end.reasoningTokenCount ?? 0) - (start.reasoningTokenCount ?? 0),
	);
	const startCost = start.totalCost ?? 0;
	const endCost = end.totalCost ?? 0;
	const cost = Math.max(0, endCost - startCost);
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		cacheReadTokens === 0 &&
		cacheWriteTokens === 0 &&
		reasoningTokenCount === 0 &&
		cost === 0
	) {
		return undefined;
	}
	return {
		inputTokens: inputTokens > 0 ? inputTokens : 0,
		outputTokens: outputTokens > 0 ? outputTokens : 0,
		cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : 0,
		cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : 0,
		...(reasoningTokenCount > 0 ? { reasoningTokenCount } : {}),
		...(cost > 0 ? { cost } : {}),
	};
}

function reasoningWasRequestedOff(request: AgentModelRequest): boolean {
	return request.options?.thinking === false;
}

function textFromMessage(message: AgentMessage | undefined): string {
	if (!message) {
		return "";
	}
	return message.content
		.filter(
			(
				part: AgentMessagePart,
			): part is Extract<AgentMessagePart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part: Extract<AgentMessagePart, { type: "text" }>) => part.text)
		.join("");
}

export function textFromToolMessage(message: AgentMessage | undefined): string {
	const result = message?.content.find(
		(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
			part.type === "tool-result",
	);
	if (!result || result.isError) {
		return "";
	}
	if (typeof result.output === "string") {
		return result.output;
	}
	try {
		return JSON.stringify(result.output);
	} catch {
		return String(result.output);
	}
}

export function normalizeInput(input: AgentRunInput): AgentMessage[] {
	if (typeof input === "string") {
		return [createMessage("user", [{ type: "text", text: input }])];
	}
	if (Array.isArray(input)) {
		return cloneMessages(input);
	}
	return cloneMessages([input as AgentMessage]);
}

export class AgentRuntime {
	private config: Required<Pick<BaseAgentRuntimeConfig, "toolExecution">> &
		BaseAgentRuntimeConfig & { harness?: AgentHarness };
	private readonly listeners = new Set<AgentEventListener>();
	// biome-ignore lint/suspicious/noExplicitAny: tool input/output types vary per tool
	private readonly tools = new Map<string, AgentTool<any, any>>();
	private hooks: HookBag = {
		beforeRun: [],
		afterRun: [],
		beforeModel: [],
		afterModel: [],
		beforeTool: [],
		afterTool: [],
		onEvent: [],
	};
	/**
	 * `appendContext` blocks waiting to be injected as one user message.
	 * beforeRun hooks fill it before the run's first model request; beforeTool
	 * and afterTool hooks fill it during an iteration's tool executions and it
	 * flushes after the tool results, so tool-result parts stay contiguous for
	 * providers that require them first in the following turn.
	 */
	private pendingHookContexts: string[] = [];
	private readonly state = {
		agentId: "",
		agentRole: undefined as string | undefined,
		parentAgentId: undefined as string | null | undefined,
		runId: undefined as string | undefined,
		status: "idle" as AgentRuntimeStateSnapshot["status"],
		iteration: 0,
		messages: [] as AgentMessage[],
		pendingToolCalls: [] as string[],
		usage: cloneUsage(DEFAULT_USAGE),
		lastError: undefined as string | undefined,
		lastErrorClass: undefined as ProviderErrorClass | undefined,
		/** Provider-reported input tokens for the most recent request this run. */
		lastRequestInputTokens: 0,
		/**
		 * Whether the last provider failure was transient and worth retrying,
		 * carried from the model boundary via `errorRetryable` on the `finish`
		 * event (the AI SDK's typed `isRetryable` flag). Undefined when no such
		 * signal was provided, in which case the agent loop classifies from the
		 * flattened `lastError` message instead.
		 */
		lastErrorRetryable: undefined as boolean | undefined,
		/**
		 * Whether the model layer already recorded `sdk.error` telemetry for
		 * `lastError` (from `errorReported` on the stream's `finish` event).
		 * Custom `AgentModel` implementations that do not record their own
		 * telemetry leave this false, so their failures still get reported.
		 */
		lastErrorReported: false,
		/**
		 * Finish reason carried into the run-failed `sdk.error` event. Set
		 * only at the throw sites where a finish reason IS the failure's
		 * cause (empty turn, max-tokens, provider error) — never recorded
		 * ambiently on finish events, so a failure elsewhere in the loop
		 * (hooks, listeners, transport, setup) can never inherit a reason
		 * from a request that did not cause it. Undefined means the
		 * attribute is omitted, which is always safe; a wrong reason is not.
		 */
		lastFinishReason: undefined as AgentModelFinishReason | undefined,
	};
	/** One automatic overflow-recovery attempt per run. */
	protected overflowRecoveryAttempted = false;
	/** Consecutive output-limit cut-offs recovered this run; see MAX_TOKENS_RECOVERY_LIMIT. */
	protected maxTokensRecoveryCount = 0;
	/** One automatic recovery attempt per run for max-tokens-truncated turns. */
	protected maxTokensRecoveryAttempted = false;
	private initialization?: Promise<void>;
	private abortController?: AbortController;
	private modelSteerController?: AbortController;
	private readonly telemetryProviderId?: string;
	private readonly telemetryModelId?: string;
	private modelRequestId?: string;

	constructor(config: AgentRuntimeConfig) {
		this.telemetryProviderId =
			trimNonEmpty(config.messageModelInfo?.provider) ??
			("providerId" in config ? trimNonEmpty(config.providerId) : undefined);
		this.telemetryModelId =
			trimNonEmpty(config.messageModelInfo?.id) ??
			("modelId" in config ? trimNonEmpty(config.modelId) : undefined);
		const resolved = resolveRuntimeConfig(config);
		this.config = {
			...resolved,
			toolExecution: resolved.toolExecution ?? "sequential",
		};
		this.state.agentId = resolved.agentId ?? createUID("agent");
		this.state.agentRole = resolved.agentRole;
		this.state.parentAgentId = resolved.parentAgentId;
		this.state.messages = cloneMessages(resolved.initialMessages ?? []);
	}

	async run(input: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	async continue(input?: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	/** Interrupt only the current model request; running tools finish normally. */
	notifyPendingUserMessage(): void {
		this.modelSteerController?.abort();
	}

	abort(reason?: unknown): void {
		if (!this.abortController) {
			return;
		}
		if (this.abortController.signal.aborted) {
			return;
		}
		const abortError =
			reason instanceof AgentRuntimeAbortError
				? reason
				: new AgentRuntimeAbortError(reason);
		this.state.lastError = abortError.message;
		this.captureTaskLifecycle(TASK_CANCELLED_EVENT, {
			error: abortError,
		});
		this.abortController.abort(abortError);
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Replace the conversation with a fresh set of messages, discarding any
	 * in-flight run and usage state while preserving the underlying model,
	 * tools, hooks, plugins, and active event subscribers.
	 *
	 * Useful for standalone callers that persist conversations externally and
	 * want to re-seed the runtime from storage without recreating subscribers.
	 */
	restore(messages: readonly AgentMessage[]): void {
		this.abort("Agent state restored");
		// Reset state that is not carried across restores. Keep `listeners`,
		// tools, hooks, plugins, model, and agent identity so external event
		// subscribers continue to receive events after restore().
		this.state.runId = undefined;
		this.state.status = "idle";
		this.state.iteration = 0;
		this.state.pendingToolCalls = [];
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.lastErrorReported = false;
		this.state.messages = cloneMessages(messages);
		this.config = {
			...this.config,
			initialMessages: cloneMessages(messages),
		};
	}

	snapshot(): AgentRuntimeStateSnapshot {
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			parentAgentId: this.state.parentAgentId,
			conversationId: this.config.conversationId?.trim() || undefined,
			runId: this.state.runId,
			status: this.state.status,
			iteration: this.state.iteration,
			messages: cloneMessages(this.state.messages),
			pendingToolCalls: [...this.state.pendingToolCalls],
			usage: cloneUsage(this.state.usage),
			lastError: this.state.lastError,
			lastErrorClass: this.state.lastErrorClass,
		};
	}

	private async ensureInitialized(): Promise<void> {
		this.initialization ??= this.initialize();
		await this.initialization;
	}

	private async initialize(): Promise<void> {
		this.registerHooks(this.config.hooks);
		for (const tool of this.config.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		for (const plugin of this.config.plugins ?? []) {
			const setup = await plugin.setup?.({
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				systemPrompt: this.config.systemPrompt,
			});
			for (const tool of setup?.tools ?? []) {
				this.tools.set(tool.name, tool);
			}
			this.registerHooks(setup?.hooks);
		}
	}

	private registerHooks(hooks: Partial<AgentRuntimeHooks> | undefined): void {
		if (!hooks) {
			return;
		}
		if (hooks.beforeRun) this.hooks.beforeRun.push(hooks.beforeRun);
		if (hooks.afterRun) this.hooks.afterRun.push(hooks.afterRun);
		if (hooks.beforeModel) this.hooks.beforeModel.push(hooks.beforeModel);
		if (hooks.afterModel) this.hooks.afterModel.push(hooks.afterModel);
		if (hooks.beforeTool) this.hooks.beforeTool.push(hooks.beforeTool);
		if (hooks.afterTool) this.hooks.afterTool.push(hooks.afterTool);
		if (hooks.onEvent) this.hooks.onEvent.push(hooks.onEvent);
	}

	private getRequiredCompletionToolNames(): string[] {
		if (this.config.completionPolicy?.requireCompletionTool !== true) {
			return [];
		}
		return [...this.tools.values()]
			.filter((tool) => tool.lifecycle?.completesRun === true)
			.map((tool) => tool.name)
			.sort();
	}

	private getCompletionToolReminderMessage(): string | undefined {
		const terminalToolNames = this.getRequiredCompletionToolNames();
		if (terminalToolNames.length === 0) {
			return undefined;
		}
		return `[SYSTEM] This run is not complete until you call one of these terminal completion tools: ${terminalToolNames.join(
			", ",
		)}. Continue working if requirements are not met. If the task is complete, call the appropriate terminal completion tool now.`;
	}

	protected getCompletionReminderMessages(): string[] {
		return [
			this.getCompletionToolReminderMessage(),
			this.config.completionPolicy?.completionGuard?.(),
		].filter((message): message is string => Boolean(message));
	}

	async addUserReminderMessage(
		text: string,
		metadata: AgentMessage["metadata"] = {},
	): Promise<AgentMessage> {
		const reminderMessage = createMessage("user", [{ type: "text", text }], {
			...metadata,
			userRunSpan: 0,
		});
		this.state.messages.push(reminderMessage);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message: reminderMessage,
		});
		return reminderMessage;
	}

	protected buildHarnessContext(): AgentHarnessContext {
		return {
			snapshot: () => this.snapshot(),
			emit: (event) => this.emit(event),
			tools: this.tools,
			hooks: this.hooks,
			config: this.config,
			throwIfAborted: () => this.throwIfAborted(),
			signal: this.abortController?.signal,
			updateUsage: (usage) => this.updateUsage(usage),
			recordAssistantMessage: (msg, reason) => this.recordAssistantMessage(msg, reason),
			finishRun: (status, msg, text) => this.finishRun(status, msg, text),
			addUserReminderMessage: (text, meta) => this.addUserReminderMessage(text, meta),
			prepareToolExecution: (toolCall) => this.prepareToolExecution(toolCall),
			executePreparedTool: (prep) => this.executePreparedTool(prep),
		};
	}

	private async execute(_input?: AgentRunInput): Promise<AgentRunResult> {
		await this.ensureInitialized();
		if (this.state.status === "running") {
			throw new Error("Agent runtime is already running");
		}

		this.abortController = new AbortController();
		this.state.runId = createUID("run");
		this.modelRequestId = undefined;
		this.state.status = "running";
		this.state.iteration = 0;
		this.state.pendingToolCalls = [];
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.lastErrorReported = false;
		this.state.lastFinishReason = undefined;
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.overflowRecoveryAttempted = false;
		this.state.lastRequestInputTokens = 0;
		this.pendingHookContexts = [];
		this.maxTokensRecoveryCount = 0;
		this.maxTokensRecoveryAttempted = false;

		await this.emit({
			type: "run-started",
			snapshot: this.snapshot(),
		});

		if (_input !== undefined) {
			for (const msg of normalizeInput(_input)) {
				this.state.messages.push(msg);
				await this.emit({
					type: "message-added",
					snapshot: this.snapshot(),
					message: msg,
				});
			}
		}

		await this.callBeforeRunHooks();
		await this.flushPendingHookContexts();

		const harness = this.config.harness ?? new TrueForgeHarness();
		const harnessCtx = this.buildHarnessContext();

		try {
			const result = await harness.run(harnessCtx, _input);
			await this.callAfterRunHooks(result);
			this.state.status = "idle";
			await this.emit({
				type: "run-finished",
				snapshot: this.snapshot(),
				result,
			});
			return result;
		} catch (error) {
			this.state.status = "idle";
			const normalizedError = error instanceof Error ? error : new Error(String(error));
			this.state.lastError = normalizedError.message;
			await this.emit({
				type: "run-failed",
				snapshot: this.snapshot(),
				error: normalizedError,
			});
			throw normalizedError;
		}
	}

	/**
	 * Flushes pending hook contexts via addUserReminderMessage.
	 */
	protected async flushPendingHookContexts(): Promise<void> {
		if (this.pendingHookContexts.length === 0) {
			return;
		}
		const contexts = [...this.pendingHookContexts];
		this.pendingHookContexts = [];
		for (const ctx of contexts) {
			await this.addUserReminderMessage(ctx);
		}
	}

	/**
	 * Invokes configured beforeRun hooks.
	 */
	protected async callBeforeRunHooks(): Promise<void> {
		if (this.hooks.beforeRun.length === 0) {
			return;
		}
		const snapshot = this.snapshot();
		for (const hook of this.hooks.beforeRun) {
			await hook({ snapshot });
		}
	}

	/**
	 * Invokes configured afterRun hooks.
	 */
	protected async callAfterRunHooks(result: AgentRunResult): Promise<void> {
		if (this.hooks.afterRun.length === 0) {
			return;
		}
		const snapshot = this.snapshot();
		for (const hook of this.hooks.afterRun) {
			await hook({ snapshot, result });
		}
	}

	/**
	 * Max-tokens recovery handled by harness.
	 */
	protected async recoverFromIncompleteMaxTokensTurn(): Promise<boolean> {
		return false;
	}

	/**
	 * @deprecated Part of the agentic loop's LLM orchestration. The
	 * AgentHarness is responsible for all model turn generation.
	 */
	protected async generateAssistantMessageWithProviderRetry(): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		const message: AgentMessage = {
			id: createUID("msg"),
			role: "assistant",
			content: [],
			createdAt: Date.now(),
		};
		return { message, finishReason: "stop" };
	}

	/**
	 * @deprecated Part of the agentic loop's LLM retry orchestration.
	 */
	protected async withProviderErrorRetry<
		T extends { message: AgentMessage; finishReason: AgentModelFinishReason },
	>(issue: () => Promise<T>): Promise<T> {
		return issue();
	}

	/**
	 * @deprecated Part of the agentic loop. The AgentHarness is responsible
	 * for classifying retryable errors.
	 */
	protected isRetryableProviderErrorTurn(_turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}): boolean {
		return false;
	}

	/**
	 * Clear the last-error fields. Called at the start of every turn and before
	 * every provider-error retry, so a `finish` event that omits `error` (allowed
	 * by the public AgentModel contract) cannot inherit the class or retryability
	 * of an earlier attempt. Deliberately not called inside overflow recovery,
	 * whose "nothing to compact" error reports the first attempt's provider
	 * message.
	 */
	protected resetLastError(): void {
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.lastErrorReported = false;
	}

	/**
	 * Sleep for `ms`, rejecting early with the abort error if the run is
	 * aborted while waiting, so a retry backoff never blocks cancellation.
	 */
	protected async abortableDelay(ms: number): Promise<void> {
		this.throwIfAborted();
		const signal = this.abortController?.signal;
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(this.normalizeAbortError());
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	/**
	 * @deprecated Part of the agentic loop's context-overflow recovery.
	 */
	protected async generateAssistantMessageWithOverflowRecovery(): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		return this.generateAssistantMessageWithProviderRetry();
	}

	/**
	 * @deprecated Part of the agentic loop's overflow classification.
	 */
	protected isRecoverableOverflowTurn(_turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}): boolean {
		return false;
	}

	/**
	 * @deprecated Part of the agentic loop's max-tokens classification.
	 */
	protected isRecoverableMaxTokensTurn(_turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}): boolean {
		return false;
	}

	/** Tool activity executed outside AgentRuntime is recorded in metadata. */
	protected hasModelToolActivity(message: AgentMessage): boolean {
		const activities = message.metadata?.modelToolActivities;
		return Array.isArray(activities) && activities.length > 0;
	}

	/**
	 * @deprecated Part of the agentic loop's max-tokens compaction recovery.
	 */
	protected async retryTruncatedTurnWithCompaction(first: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}> {
		return first;
	}

	/** Append an assistant turn to the transcript and announce it. */
	async recordAssistantMessage(
		message: AgentMessage,
		finishReason: AgentModelFinishReason,
	): Promise<void> {
		this.state.messages.push(message);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message,
		});
		await this.emit({
			type: "assistant-message",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			message,
			finishReason,
		});
	}

	/**
	 * @deprecated Part of the agentic loop's LLM turn dispatch.
	 */
	protected async generateAssistantMessage(_options?: {
		overflowRecovery?: boolean;
	}): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		return this.generateAssistantMessageWithProviderRetry();
	}

	/**
	 * @deprecated Part of the agentic loop — re-issues a prepared request.
	 */
	protected async issuePreparedRequest(_prepared: PreparedModelRequest): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		return this.generateAssistantMessageWithProviderRetry();
	}

	/** A model request with turn preparation and before-model hooks applied. */
	async prepareModelRequest(options?: {
		overflowRecovery?: boolean;
	}): Promise<PreparedModelRequest> {
		const modelRequestMetadata = omitUndefinedValues({
			distinctId: trimNonEmpty(this.config.distinctId),
			clientName: trimNonEmpty(this.config.clientName),
			clientVersion: trimNonEmpty(this.config.clientVersion),
			clineCoreVersion: trimNonEmpty(this.config.clineCoreVersion),
			sessionId: trimNonEmpty(this.config.sessionId),
			agentId: this.state.agentId,
			conversationId: trimNonEmpty(this.config.conversationId),
			runId: this.state.runId,
			iteration: this.state.iteration,
		});
		let request: AgentModelRequest = {
			systemPrompt: this.config.systemPrompt,
			messages: cloneMessages(this.state.messages),
			tools: [...this.tools.values()].map<AgentToolDefinition>((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			})),
			modelTools: this.config.modelTools,
			signal: this.abortController?.signal,
			options: mergeModelOptions(this.config.modelOptions, {
				metadata: modelRequestMetadata,
			}),
		};

		const startedAt = Date.now();

		// Read queued input at every request boundary, including retries and
		// continuations within the first iteration.
		const pendingUserMessage = await this.consumePendingUserMessage();
		if (pendingUserMessage) {
			request = {
				...request,
				messages: [...request.messages, ...cloneMessages([pendingUserMessage])],
			};
		}

		request = await this.prepareTurnForModelRequest(request, options);
		this.throwIfAborted();

		for (const hook of this.hooks.beforeModel) {
			const result = (await hook({
				snapshot: this.snapshot(),
				request,
			})) as AgentBeforeModelResult | undefined;
			this.throwIfAborted();
			this.applyStopControl(result);
			if (result?.messages) {
				request = { ...request, messages: cloneMessages(result.messages) };
			}
			if (result?.tools) {
				request = { ...request, tools: [...result.tools] };
			}
			if (result?.options) {
				request = {
					...request,
					options: mergeModelOptions(request.options, result.options),
				};
			}
		}

		this.config.logger?.debug("Agent model request diagnostics", {
			iteration: this.state.iteration,
			providerId:
				"providerId" in this.config &&
				typeof this.config.providerId === "string"
					? this.config.providerId
					: undefined,
			modelId:
				"modelId" in this.config && typeof this.config.modelId === "string"
					? this.config.modelId
					: undefined,
			...summarizeModelRequest(request),
		});

		return { request, startedAt };
	}

	/**
	 * @deprecated Part of the agentic loop — ties preparation + streaming.
	 */
	protected async generateAssistantMessageForRequest(
		_steerController: AbortController,
		_options?: { overflowRecovery?: boolean },
	): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		return this.generateAssistantMessageWithProviderRetry();
	}

	/**
	 * @deprecated Part of the agentic loop — streams a prepared LLM request.
	 */
	protected async streamPreparedRequest(
		_prepared: PreparedModelRequest,
		_steerController: AbortController,
	): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		return this.generateAssistantMessageWithProviderRetry();
	}

	/**
	 * @deprecated Part of the agentic loop — wraps model.stream() with
	 * task lifecycle telemetry.
	 */
	protected async *openTaskLifecycleStream(
		_request: AgentModelRequest,
		_getTaskLifecycleDurationMs: () => number | undefined,
	): AsyncIterable<AgentModelEvent> {
		yield* [] as AgentModelEvent[];
	}

	protected captureTaskLifecycleFailure(
		error: unknown,
		phase: string,
		durationMs: number | undefined,
	): void {
		this.captureTaskLifecycle(TASK_PROVIDER_STREAM_FAILED_EVENT, {
			durationMs,
			error,
			errorClass: classifyProviderError(error),
			phase,
		});
	}

	private captureTaskLifecycle(
		event: string,
		input: Partial<Omit<CaptureTaskLifecycleEventInput, "event">> = {},
	): void {
		const sessionId = trimNonEmpty(this.config.sessionId);
		captureTaskLifecycleEvent(this.config.telemetry, {
			event,
			modelRequestId: this.modelRequestId,
			sessionId,
			ulid: sessionId,
			agentId: this.state.agentId,
			conversationId: trimNonEmpty(this.config.conversationId),
			runId: this.state.runId,
			iteration: this.state.iteration > 0 ? this.state.iteration : undefined,
			providerId: this.getTelemetryProviderId(),
			modelId: this.getTelemetryModelId(),
			...input,
		});
	}

	private getTelemetryProviderId(): string | undefined {
		return (
			trimNonEmpty(this.config.messageModelInfo?.provider) ??
			this.telemetryProviderId
		);
	}

	private getTelemetryModelId(): string | undefined {
		return (
			trimNonEmpty(this.config.messageModelInfo?.id) ?? this.telemetryModelId
		);
	}

	protected isAbortError(error: unknown): boolean {
		return (
			error instanceof AgentRuntimeAbortError ||
			this.abortController?.signal.aborted === true
		);
	}

	protected captureUnexpectedReasoningTokens(
		request: AgentModelRequest,
		metrics: NonNullable<AgentMessage["metrics"]>,
	): void {
		if (
			!reasoningWasRequestedOff(request) ||
			(metrics.reasoningTokenCount ?? 0) <= 0
		) {
			return;
		}
		const reasoningTokenCount = metrics.reasoningTokenCount;
		if (reasoningTokenCount === undefined) {
			return;
		}

		captureAgentUnexpectedReasoningTokens(this.config.telemetry, {
			sessionId: this.config.sessionId,
			agentId: this.state.agentId,
			runId: this.state.runId,
			iteration: this.state.iteration,
			providerId: this.config.messageModelInfo?.provider,
			modelId: this.config.messageModelInfo?.id,
			requestedThinking: false,
			reasoningTokenCount,
		});
	}

	async prepareTurnForModelRequest(
		request: AgentModelRequest,
		options?: { overflowRecovery?: boolean },
	): Promise<AgentModelRequest> {
		if (!this.config.prepareTurn) {
			return request;
		}

		const overflowRecovery = options?.overflowRecovery === true;
		const result = await this.config.prepareTurn({
			agentId: this.state.agentId,
			conversationId: this.config.conversationId,
			parentAgentId: this.state.parentAgentId ?? null,
			iteration: this.state.iteration,
			messages: request.messages,
			systemPrompt: request.systemPrompt,
			tools: request.tools,
			model: {
				id: this.config.messageModelInfo?.id,
				provider: this.config.messageModelInfo?.provider,
			},
			signal: request.signal,
			overflowRecovery: overflowRecovery || undefined,
			previousRequestInputTokens:
				this.state.lastRequestInputTokens > 0
					? this.state.lastRequestInputTokens
					: undefined,
			emitStatusNotice: (message, metadata) => {
				void this.emit({
					type: "status-notice",
					snapshot: this.snapshot(),
					message,
					metadata,
				});
			},
		});
		if (overflowRecovery) {
			// Only retry a provider-rejected overflow with a request that is
			// actually smaller — anything else is guaranteed to fail again.
			//
			// Serialized length is a coarse proxy for tokens, which is all this
			// backstop needs: it answers "did anything get removed at all" for
			// arbitrary `prepareTurn` implementations, and the shared estimator
			// is itself linear in character count, so switching units would not
			// change the verdict. Authoritative token budgeting (against the
			// model's limit) happens inside the compaction pipeline.
			// TODO: have `prepareTurn` report the token estimates it already
			// computed (before/after) so this decision can use real numbers
			// instead of re-deriving a proxy here.
			const shrunk =
				result?.messages !== undefined &&
				JSON.stringify(result.messages).length <
					JSON.stringify(request.messages).length;
			if (!shrunk) {
				throw new ContextWindowOverflowError(
					CONTEXT_WINDOW_OVERFLOW_NOTHING_TO_COMPACT_MESSAGE,
					this.state.lastError,
				);
			}
		}
		if (!result) {
			return request;
		}

		let next = request;
		if (result.messages) {
			const preparedMessages = cloneMessages(result.messages);
			next = { ...next, messages: cloneMessages(preparedMessages) };
		}
		if (result.systemPrompt !== undefined) {
			next = { ...next, systemPrompt: result.systemPrompt };
		}
		return next;
	}

	private async consumePendingUserMessage(): Promise<AgentMessage | undefined> {
		const consumePendingUserMessage = this.config.consumePendingUserMessage;
		if (!consumePendingUserMessage) {
			return undefined;
		}
		const pending = (await consumePendingUserMessage())?.trim();
		if (!pending) {
			return undefined;
		}
		const message = createMessage("user", [{ type: "text", text: pending }], {
			userRunSpan: 0,
		});
		this.state.messages.push(message);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message,
		});
		return message;
	}

	async updateUsage(usage: Partial<AgentUsage>): Promise<void> {
		this.state.usage = {
			inputTokens: this.state.usage.inputTokens + (usage.inputTokens ?? 0),
			outputTokens: this.state.usage.outputTokens + (usage.outputTokens ?? 0),
			cacheReadTokens:
				this.state.usage.cacheReadTokens + (usage.cacheReadTokens ?? 0),
			cacheWriteTokens:
				this.state.usage.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
			reasoningTokenCount:
				(this.state.usage.reasoningTokenCount ?? 0) +
				(usage.reasoningTokenCount ?? 0),
			totalCost: (this.state.usage.totalCost ?? 0) + (usage.totalCost ?? 0),
		};
		await this.emit({
			type: "usage-updated",
			snapshot: this.snapshot(),
			usage: cloneUsage(this.state.usage),
		});
	}

	/**
	 * @deprecated Called only from the agentic loop. The AgentHarness is
	 * responsible for orchestrating tool execution via AgentHarnessContext.
	 * prepareToolExecution() and executePreparedTool() are still available.
	 * TODO: Replace with external AgentHarness implementation.
	 */
	public async executeToolCalls(
		toolCalls: AgentToolCallPart[],
	): Promise<AgentMessage[]> {
		const results: AgentMessage[] = [];
		for (const toolCall of toolCalls) {
			const prepared = await this.prepareToolExecution(toolCall);
			const message = await this.executePreparedTool(prepared);
			results.push(message);
		}
		return results;
	}

	public findCompletingToolMessage(
		_toolCalls: AgentToolCallPart[],
		toolMessages: AgentMessage[],
	): AgentMessage | undefined {
		for (let i = toolMessages.length - 1; i >= 0; i--) {
			const msg = toolMessages[i];
			if (msg.role === "tool" && msg.metadata?.completesTask) {
				return msg;
			}
		}
		return undefined;
	}

	async prepareToolExecution(
		toolCall: AgentToolCallPart,
	): Promise<PreparedToolExecution> {
		const tool = this.tools.get(toolCall.toolName);
		let input = toolCall.input;
		let skipReason: string | undefined;
		const metadata =
			toolCall.metadata &&
			typeof toolCall.metadata === "object" &&
			!Array.isArray(toolCall.metadata)
				? (toolCall.metadata as Record<string, unknown>)
				: undefined;

		if (typeof metadata?.inputParseError === "string") {
			skipReason = metadata.inputParseError;
		}

		const toolSource =
			metadata?.toolSource &&
			typeof metadata.toolSource === "object" &&
			!Array.isArray(metadata.toolSource)
				? (metadata.toolSource as Record<string, unknown>)
				: undefined;
		if (toolSource?.executionMode === "provider") {
			const providerId =
				typeof toolSource.providerId === "string"
					? toolSource.providerId
					: "provider";
			skipReason = `Tool execution is disabled for provider ${providerId}`;
		}

		if (tool && !skipReason) {
			input = normalizeJsonLikeStringsForSchema(input, tool.inputSchema);
		}

		let policyOverride: ToolPolicy | undefined;
		if (tool && !skipReason) {
			for (const hook of this.hooks.beforeTool) {
				const result = (await hook({
					snapshot: this.snapshot(),
					tool,
					toolCall: { ...toolCall, input },
					input,
				})) as AgentBeforeToolResult | undefined;
				if (result?.input !== undefined) {
					input = result.input;
				}
				if (result?.policy) {
					policyOverride = {
						...policyOverride,
						...result.policy,
					};
				}
				if (result?.appendContext?.trim()) {
					this.pendingHookContexts.push(
						formatHookContextBlock(
							{ source: "PreToolUse", toolCall },
							result.appendContext,
						),
					);
				}
				this.applyStopControl(result);
				if (result?.skip) {
					skipReason =
						result.reason ?? `Tool ${tool.name} was blocked by a runtime hook`;
					break;
				}
			}
		}

		if (tool && !skipReason) {
			const policy = {
				...resolveToolPolicy(
					toolCall.toolName,
					this.config.toolPolicies,
					tool.policyDependencies,
				),
				...policyOverride,
			};
			if (policy.enabled === false) {
				skipReason = `Tool "${toolCall.toolName}" is disabled by policy`;
			} else if (policy.autoApprove === false) {
				const approval = await this.requestToolApproval(
					toolCall,
					input,
					policy,
				);
				if (!approval.approved) {
					const reason = approval.reason ?? "Tool was not executed";
					skipReason = `${reason} -- ${TOOL_REJECTION_SUFFIX}`;
				}
			}
		}

		return {
			toolCall: { ...toolCall, input },
			tool,
			input,
			skipReason,
		};
	}

	private async requestToolApproval(
		toolCall: AgentToolCallPart,
		input: unknown,
		policy: ToolPolicy,
	): Promise<ToolApprovalResult> {
		const requestApproval = this.config.requestToolApproval;
		if (!requestApproval) {
			return {
				approved: false,
				reason: `Tool "${toolCall.toolName}" requires approval but no approval callback is configured`,
			};
		}
		try {
			return await requestApproval({
				sessionId:
					this.config.sessionId?.trim() ||
					this.config.conversationId?.trim() ||
					this.state.runId ||
					this.state.agentId,
				agentId: this.state.agentId,
				conversationId:
					this.config.conversationId?.trim() ||
					this.state.runId ||
					this.state.agentId,
				iteration: this.state.iteration,
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				input,
				policy,
			});
		} catch (error) {
			return {
				approved: false,
				reason: `Tool "${toolCall.toolName}" approval request failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	async executePreparedTool(
		prepared: PreparedToolExecution,
	): Promise<AgentMessage> {
		// A parallel sibling can outlive a stopped run; pushing to the buffer
		// captured here keeps its context out of whichever run is current then.
		const hookContexts = this.pendingHookContexts;
		const startedAt = new Date();
		await this.emit({
			type: "tool-started",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			toolCall: prepared.toolCall,
		});

		let result: AgentToolResult;
		if (prepared.skipReason) {
			result = {
				output: { error: prepared.skipReason },
				isError: true,
			};
		} else if (!prepared.tool) {
			result = {
				output: { error: `Unknown tool: ${prepared.toolCall.toolName}` },
				isError: true,
			};
		} else {
			try {
				const output = await prepared.tool.execute(prepared.input, {
					sessionId: this.config.sessionId,
					agentId: this.state.agentId,
					conversationId: this.config.conversationId,
					runId: this.state.runId ?? createUID("run"),
					iteration: this.state.iteration,
					toolCallId: prepared.toolCall.toolCallId,
					signal: this.abortController?.signal,
					metadata: this.config.toolContextMetadata,
					snapshot: this.snapshot(),
					emitUpdate: (update: unknown) => {
						void this.emit({
							type: "tool-updated",
							snapshot: this.snapshot(),
							iteration: this.state.iteration,
							toolCall: prepared.toolCall,
							update,
						});
					},
				});
				result = { output };
			} catch (error) {
				result = {
					output: {
						error: error instanceof Error ? error.message : String(error),
					},
					isError: true,
				};
			}
		}

		const endedAt = new Date();
		const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

		if (prepared.tool) {
			for (const hook of this.hooks.afterTool) {
				const after = (await hook({
					snapshot: this.snapshot(),
					tool: prepared.tool,
					toolCall: prepared.toolCall,
					input: prepared.input,
					result,
					startedAt,
					endedAt,
					durationMs,
				})) as AgentAfterToolResult | undefined;
				if (after?.appendContext?.trim()) {
					hookContexts.push(
						formatHookContextBlock(
							{ source: "PostToolUse", toolCall: prepared.toolCall },
							after.appendContext,
						),
					);
				}
				this.applyStopControl(after);
				if (after?.result) {
					result = after.result;
				}
			}
		}

		if (
			!prepared.skipReason &&
			!result.isError &&
			prepared.tool?.successContext?.trim()
		) {
			hookContexts.push(
				formatHookContextBlock(
					{ source: "ToolSuccess", toolCall: prepared.toolCall },
					prepared.tool.successContext,
				),
			);
		}

		const message = createMessage("tool", [
			{
				type: "tool-result",
				toolCallId: prepared.toolCall.toolCallId,
				toolName: prepared.toolCall.toolName,
				output: result.output,
				isError: result.isError,
			},
		]);

		await this.emit({
			type: "tool-finished",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			toolCall: prepared.toolCall,
			message,
		});

		return message;
	}

	finishRun(
		status: AgentRunResult["status"],
		assistantMessage?: AgentMessage,
		outputText?: string,
	): AgentRunResult {
		this.state.status = status;
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			runId: this.state.runId ?? createUID("run"),
			status,
			iterations: this.state.iteration,
			outputText:
				outputText ??
				textFromMessage(assistantMessage ?? this.findLastAssistantMessage()),
			messages: cloneMessages(this.state.messages),
			usage: cloneUsage(this.state.usage),
		};
	}

	private findLastAssistantMessage(): AgentMessage | undefined {
		return [...this.state.messages]
			.reverse()
			.find((message) => message.role === "assistant");
	}

	private throwIfAborted(): void {
		if (this.abortController?.signal.aborted) {
			throw this.normalizeAbortError();
		}
	}

	private normalizeAbortError(): Error {
		const reason = this.abortController?.signal.reason;
		if (reason instanceof Error) {
			return reason;
		}
		if (typeof reason === "string") {
			return new Error(reason);
		}
		return new Error(this.state.lastError ?? "Run aborted");
	}

	private async emit(event: AgentRuntimeEvent): Promise<void> {
		const metadata = buildEventMetadata(event);
		switch (event.type) {
			case "run-started":
				// Verbatim clinee calls `logger?.info?.(...)`. sdk-re's
				// `BasicLogger` does not declare `info` (it uses `log`), so
				// we narrow to an optional-info shape at the call site to
				// preserve the clinee runtime contract without mutating
				// shared's `BasicLogger` interface.
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent run started", metadata);
				break;
			case "tool-finished":
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent tool finished", metadata);
				break;
			case "run-failed":
				this.config.logger?.error?.("Agent run failed", {
					...metadata,
					error: event.error,
				});
				// Failures the model layer already recorded at its own error
				// boundary (`provider.stream`, carried across the stream's
				// string-flattening boundary as `finish.errorReported`) must not
				// be re-reported here — that exactly doubled `sdk.error` volume.
				// Everything else still reports: loop-originated failures, and
				// failures from model implementations that do not record their
				// own telemetry.
				if (!this.state.lastErrorReported) {
					captureSdkError(this.config.telemetry, {
						component: "agents",
						operation: "agent.run",
						error: event.error,
						severity: "error",
						handled: false,
						context: {
							...(metadata as TelemetryProperties),
							providerId: this.getTelemetryProviderId(),
							modelId: this.getTelemetryModelId(),
							modelRequestId: this.modelRequestId,
							...(this.state.lastFinishReason
								? { finishReason: this.state.lastFinishReason }
								: {}),
						},
					});
				}
				break;
			default:
				this.config.logger?.debug?.("Agent event", metadata);
				break;
		}
		switch (event.type) {
			// Per-token/per-chunk stream events are ~97% of agent.* telemetry
			// volume and are never queried, so they are not mirrored to
			// telemetry. Listeners and hooks below still receive them.
			case "assistant-text-delta":
			case "assistant-reasoning-delta":
			case "assistant-media":
			case "tool-call-delta":
			case "tool-updated":
				break;
			case "run-finished":
			case "run-failed":
				this.config.telemetry?.capture({
					event: `agent.${event.type}`,
					properties: {
						...(metadata as TelemetryProperties),
						...this.config.runEndTelemetryProperties?.(),
					},
				});
				break;
			default:
				this.config.telemetry?.capture({
					event: `agent.${event.type}`,
					properties: metadata as TelemetryProperties,
				});
				break;
		}
		for (const listener of this.listeners) {
			listener(event);
		}
		for (const hook of this.hooks.onEvent) {
			await hook(event);
		}
	}

	private applyStopControl(
		control: AgentStopControl | undefined | undefined,
	): void {
		if (!control?.stop) {
			return;
		}
		if (control.reason) {
			this.state.lastError = control.reason;
		}
		throw new ControlledStopError(control.reason);
	}
}

function buildEventMetadata(event: AgentRuntimeEvent): Record<string, unknown> {
	return {
		agentId: event.snapshot.agentId,
		agentRole: event.snapshot.agentRole,
		runId: event.snapshot.runId,
		status: event.snapshot.status,
		iteration: event.snapshot.iteration,
		eventType: event.type,
	};
}

export function mergeToolMetadata(current: unknown, patch: unknown): unknown {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		return patch;
	}
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		return patch;
	}
	return {
		...(current as Record<string, unknown>),
		...patch,
	};
}

export function parseToolInput(assembly: PendingToolAssembly): {
	input: unknown;
	parseError?: string;
	invalidInput: Record<string, unknown>;
	reason?: InvalidToolCall["reason"];
} {
	if (assembly.inputValue !== undefined) {
		return {
			input: assembly.inputValue,
			invalidInput: buildInvalidToolInput(JSON.stringify(assembly.inputValue)),
		};
	}
	if (!assembly.inputText.trim()) {
		return {
			input: {},
			invalidInput: {},
		};
	}
	const parsed = parseToolArguments(assembly.inputText);
	if (parsed.ok) {
		return {
			input: parsed.value,
			invalidInput: buildInvalidToolInput(assembly.inputText),
		};
	}
	return {
		input: {},
		invalidInput: buildInvalidToolInput(assembly.inputText, parsed.error),
		parseError: `Tool call ${assembly.toolName ?? assembly.toolCallId} emitted invalid JSON arguments: ${parsed.error}`,
		reason: "invalid_arguments",
	};
}

function buildInvalidToolInput(
	value: string,
	parseError?: string,
): Record<string, unknown> {
	const trimmed = value.trim();
	if (!trimmed) {
		return {};
	}
	return parseError
		? { rawInputText: value, parseError }
		: { rawInputText: value };
}

function parseToolArguments(
	value: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = value.trim();
	if (!trimmed) {
		return {
			ok: false,
			error: "Tool call arguments were empty.",
		};
	}

	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch {
		// Fall through to a normalized error below.
	}

	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return {
			ok: false,
			error: "Tool call arguments must be encoded as a JSON object or array.",
		};
	}

	return {
		ok: false,
		error:
			"Tool call arguments could not be parsed as JSON. Ensure the outer tool payload is valid JSON and escape embedded quotes/newlines inside string fields.",
	};
}

export function mergeToolInputText(current: string, incoming: string): string {
	if (!current) {
		return incoming;
	}
	const trimmed = incoming.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return incoming;
	}
	return current + incoming;
}

export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}

/**
 * `Agent` is the user-friendly name for `AgentRuntime`. They are the same
 * class; this alias exists so standalone callers can write:
 *
 *     const agent = new Agent({ providerId, modelId, apiKey });
 *     await agent.run("hello");
 *
 * while `@cline/core` (which owns model construction) continues to use
 * the `AgentRuntime` name with `{ model, ... }` configs.
 */
export const Agent = AgentRuntime;
export type Agent = AgentRuntime;

export function createAgent(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}
