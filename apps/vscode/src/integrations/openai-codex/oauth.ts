/**
 * Stub for OpenAI Codex OAuth.
 * Model traffic is routed exclusively through TrueForge.
 */

export const openAiCodexOAuthManager = {
	init: () => {},
	startAuthorizationFlow: async () => {},
	cancelAuthorizationFlow: () => {},
	getCredentials: () => null,
	isConfigured: () => false,
	forceRefreshToken: async () => null,
	getValidToken: async () => null,
	clearStoredCredentials: () => {},
} as any
