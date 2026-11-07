import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { wrapLanguageModel } from "ai";
import { resolveApiKey } from "../http";
import {
	createMiniMaxThinkingFetch,
	miniMaxThinkingDisabledMiddleware,
} from "./minimax-thinking";
import type { ProviderFactoryResult } from "./types";

export async function createAnthropicProviderModule(
	_config: GatewayResolvedProviderConfig,
	_context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// TODO: Replace with TrueFoundry / external harness integration.
	throw new Error(
		"Direct model provider calls are disabled in this skeleton. Direct connection to Anthropic is not permitted.",
	);
	const apiKey = await resolveApiKey(_config);
	const isMiniMax = context.provider.id === "minimax";
	const provider = createAnthropic({
		apiKey,
		baseURL: config.baseUrl,
		headers: config.headers,
		fetch: isMiniMax ? createMiniMaxThinkingFetch(config.fetch) : config.fetch,
		name: context.provider.id,
	});
	return {
		buildModelTools: (tools) => {
			const result: ReturnType<
				NonNullable<ProviderFactoryResult["buildModelTools"]>
			> = {};
			for (const tool of tools) {
				if (tool.name === "web_search") {
					result.web_search = {
						tool: provider.tools.webSearch_20250305({
							maxUses: tool.maxUses,
							allowedDomains: tool.allowedDomains,
							blockedDomains: tool.blockedDomains,
							userLocation: tool.userLocation
								? { type: "approximate", ...tool.userLocation }
								: undefined,
						}),
					};
				}
			}
			return result;
		},
		operations: {
			language: (modelId) => {
				const model = provider(modelId);
				return isMiniMax
					? wrapLanguageModel({
							model: model as LanguageModelV4,
							middleware: miniMaxThinkingDisabledMiddleware,
						})
					: model;
			},
		},
	};
}
