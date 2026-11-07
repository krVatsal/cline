import type {
	GatewayProviderFactory,
	GatewayProviderRegistration,
} from "@cline/shared";
import {
	BUILTIN_PROVIDER_MANIFESTS_BY_ID,
	BUILTIN_SPECS,
	type ProviderFamily,
} from "./builtins";

async function loadFamilyFactory(
	family: ProviderFamily,
): Promise<GatewayProviderFactory> {
	// TODO: Replace with TrueFoundry / external harness integration.
	throw new Error(
		`Direct model provider calls are disabled in this skeleton. No direct connection to '${family}' is permitted. All model interactions must route through an external gateway.`,
	);
}

function resolveRuntimeFamily(
	spec: (typeof BUILTIN_SPECS)[number],
): ProviderFamily {
	if (
		spec.family === "openai" ||
		spec.protocol === "openai-responses" ||
		spec.client === "openai"
	) {
		return "openai";
	}
	return spec.family;
}

export const BUILTIN_PROVIDER_REGISTRATIONS: GatewayProviderRegistration[] =
	BUILTIN_SPECS.map((spec) => ({
		manifest: BUILTIN_PROVIDER_MANIFESTS_BY_ID[spec.id],
		defaults: {
			...spec.defaults,
			apiKeyEnv: spec.apiKeyEnv,
			baseUrl: spec.defaults?.baseUrl,
			// Surface the regional endpoint facts as a default option so the
			// registry can resolve a base URL from a caller-selected
			// `options.apiLine` (see GatewayRegistry.createProvider).
			...(spec.apiLineBaseUrls
				? {
						options: {
							...(spec.defaults?.options ?? {}),
							apiLineBaseUrls: spec.apiLineBaseUrls,
						},
					}
				: {}),
		},
		loadProvider: async () => ({
			createProvider: await loadFamilyFactory(resolveRuntimeFamily(spec)),
		}),
	}));
