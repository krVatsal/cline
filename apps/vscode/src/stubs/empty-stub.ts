/**
 * Empty stub to exclude provider-specific controller files from bundle.
 */
export default {};
export const openAiCodexSignIn = async () => ({});
export const openAiCodexSignOut = async () => ({});
export const refreshOpenAiModels = async () => ({});
export const refreshOpenAiModelsRpc = async () => ({});
export const migrateOpenAiBaseUrl = async () => ({});
export const migrateOpenAiCompatibleBaseUrlToV1 = async () => ({});
export const openAiCodexOAuthManager = {
	getCredentials: async () => undefined,
	login: async () => {},
	logout: async () => {},
};
export const resolveBedrockAuthentication = () => "iam";
export const buildBedrockProviderConfig = () => ({});
export const getOllamaModels = async () => [];
export const refreshGroqModels = async () => ({});
export const refreshGroqModelsRpc = async () => ({});
