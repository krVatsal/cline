import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import type { ProviderFactoryResult } from "./types";

export async function createVertexProviderModule(
	_config: GatewayResolvedProviderConfig,
	_context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	throw new Error(
		"Direct model provider calls are disabled in this skeleton. Direct connection to Vertex AI is not permitted.",
	);
}
