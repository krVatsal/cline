export {
	getGeneratedModelsForRuntimeProvider,
	isProviderApiLine,
	OLLAMA_DEFAULT_CONTEXT_WINDOW,
	type ProviderApiLine,
	resolveProviderApiLineBaseUrl,
} from "./providers/builtins";
export {
	type ApiHandler,
	BUILT_IN_PROVIDER,
	BUILT_IN_PROVIDER_IDS,
	type BuiltInProviderId,
	type HandlerFactory,
	isBuiltInProviderId,
	type LazyHandlerFactory,
	normalizeProviderId,
	type ProviderCapability,
	type ProviderConfig,
	type ProviderId,
} from "./providers/types";

export {
	resolveGatewayProviderRegistration,
	resolveGatewayProviderRegistrationSync,
} from "./providers/compat";
import type { ApiHandler, ProviderConfig } from "./providers/types";

export {
	classifyProviderError,
	isRetryableProviderError,
} from "./providers/error-classification";
export {
	ClineFreeModelLimitError,
	ClineNotSubscribedError,
	ClineOrgIndividualInferenceSubscriptionError,
	ClinePassLimitError,
	extractClineFreeModelLimitResetTime,
	extractClinePassLimitMessage,
	getClineNotSubscribedMessage,
	getClineOrgIndividualInferenceSubscriptionMessage,
	getClinePassSubscriptionUrl,
	isClineFreeModelLimitError,
	isClineFreeModelLimitMessage,
	isClineModelNotFoundMessage,
	isClineNotSubscribedError,
	isClineNotSubscribedMessage,
	isClineOrgIndividualInferenceSubscriptionError,
	isClineOrgIndividualInferenceSubscriptionMessage,
	isClinePassLimitError,
	isClinePassLimitMessage,
} from "./providers/errors";
export {
	getRegisteredHandler,
	getRegisteredHandlerAsync,
	hasRegisteredHandler,
	isRegisteredHandlerAsync,
	registerAsyncHandler,
	registerHandler,
} from "./providers/factory-registry";
export type {
	ApiStreamChunk,
	ContentBlock,
	FileContent,
	HandlerModelInfo,
	ImageContent,
	Message,
	MessageRole,
	MessageWithMetadata,
	RedactedThinkingContent,
	TextContent,
	ThinkingContent,
	ToolDefinition,
	ToolResultContent,
	ToolUseContent,
} from "./providers/types";

export function createHandler(_config: ProviderConfig): ApiHandler {
	throw new Error("Direct model provider calls are disabled. All requests must route via TrueFoundry.");
}

export async function createHandlerAsync(
	_config: ProviderConfig,
): Promise<ApiHandler> {
	throw new Error("Direct model provider calls are disabled. All requests must route via TrueFoundry.");
}
