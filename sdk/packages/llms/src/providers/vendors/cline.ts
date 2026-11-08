import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import type { ProviderFactoryResult } from "./types";

export type ClineProvider = any;
export type ClineProviderOptions = any;
export type ClineWebSearchOptions = any;

export interface ClineWebSearchInput {
	query: string;
	allowed_domains?: string[];
	blocked_domains?: string[];
}

export interface ClineWebSearchResult {
	results: Array<{ title?: string; url?: string }>;
}

export function createCline(_options?: any): any {
	throw new Error(
		"Direct model provider calls are disabled in this skeleton. Direct connection to Cline provider is not permitted.",
	);
}

export async function createClineProviderModule(
	_config: GatewayResolvedProviderConfig,
	_context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	throw new Error(
		"Direct model provider calls are disabled in this skeleton. Direct connection to Cline provider is not permitted.",
	);
}
