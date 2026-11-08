import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import type { ProviderFactoryResult } from "./types";

export function withMaxCompletionTokensForReasoningModels(
	_modelId: string,
	options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	return options;
}

export function createSuccessDataResponseFetch(
	upstreamFetch: typeof fetch,
): typeof fetch {
	return upstreamFetch;
}

export async function createOpenAICompatibleProviderModule(
	_config: GatewayResolvedProviderConfig,
	_context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	throw new Error(
		"Direct model provider calls are disabled in this skeleton. Direct connection to OpenAI-compatible endpoints is not permitted.",
	);
}
