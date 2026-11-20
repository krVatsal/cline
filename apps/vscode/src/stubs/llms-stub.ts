/**
 * Stub for @cline/llms in the VS Code extension bundle.
 * Direct model provider calls are stripped in favor of TrueForge client.
 */

export const MODEL_COLLECTIONS_BY_PROVIDER_ID: Record<string, any> = new Proxy({}, {
	get: (_target, prop) => ({
		id: String(prop),
		models: {},
		provider: {
			defaultModelId: "",
			baseUrl: "",
			modelsSourceUrl: "",
		},
	}),
});

export function getGeneratedModelsForProvider(): Record<string, any> {
	return {};
}

export async function getModelsForProvider(): Promise<Record<string, any>> {
	return {};
}

export function getProviderCollectionSync(): any {
	return {
		models: {},
		provider: {
			defaultModelId: "",
			baseUrl: "",
		},
	};
}

export function isProviderApiLine(): boolean {
	return false;
}

export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 4096;

export function resolveProviderUsageCostDisplay(): any {
	return undefined;
}

export function resolveProviderRequestHeaders(): Record<string, string> {
	return {};
}

export function createHandler(): any {
	return {};
}

export function registerHandler(): void {}
export function registerProvider(): void {}
export function resetRegistry(): void {}

export function getClineOrgIndividualInferenceSubscriptionMessage(): string {
	return "";
}

export function classifyProviderError(error: any): any {
	return "generic";
}

export function isRetryableProviderError(error: any): boolean {
	return false;
}

export function createGateway(...args: any[]): any {
	return {};
}

export class LangfuseAttributesSpanProcessor {
	onStart() {}
	onEnd() {}
	shutdown() {
		return Promise.resolve();
	}
	forceFlush() {
		return Promise.resolve();
	}
}

export function buildClineClientHeaders(...args: any[]): Record<string, string> {
	return {};
}

export class ClineFreeModelLimitError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "ClineFreeModelLimitError";
	}
}

export class ClineNotSubscribedError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "ClineNotSubscribedError";
	}
}

export class ClineOrgIndividualInferenceSubscriptionError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "ClineOrgIndividualInferenceSubscriptionError";
	}
}

export class ClinePassLimitError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "ClinePassLimitError";
	}
}

export function extractClineFreeModelLimitResetTime(): any {
	return undefined;
}

export function extractClinePassLimitMessage(): string {
	return "";
}

export function getClineNotSubscribedMessage(): string {
	return "";
}

export function getClinePassSubscriptionUrl(): string {
	return "";
}

export function isClineFreeModelLimitError(err: any): boolean {
	return false;
}

export function isClineFreeModelLimitMessage(msg: any): boolean {
	return false;
}

export function isClineModelNotFoundMessage(msg: any): boolean {
	return false;
}

export function isClineNotSubscribedMessage(msg: any): boolean {
	return false;
}

export function isClineOrgIndividualInferenceSubscriptionMessage(msg: any): boolean {
	return false;
}

export function isClinePassLimitMessage(msg: any): boolean {
	return false;
}

export function isClineNotSubscribedError(err: any): boolean {
	return false;
}

export function isClineOrgIndividualInferenceSubscriptionError(err: any): boolean {
	return false;
}

export function isClinePassLimitError(err: any): boolean {
	return false;
}

export function supportsModelTool(...args: any[]): boolean {
	return true;
}

export async function createHandlerAsync(...args: any[]): Promise<any> {
	return {};
}

export function hasRegisteredHandler(...args: any[]): boolean {
	return false;
}

export const BUILT_IN_PROVIDER: Record<string, string> = new Proxy(
	{
		ANTHROPIC: "anthropic",
		CLAUDE_CODE: "claude-code",
		CLINE: "cline",
		CLINE_PASS: "cline-pass",
		ELEVENLABS: "elevenlabs",
		OPENAI_COMPATIBLE: "openai-compatible",
		OPENAI_NATIVE: "openai-native",
		OPENAI_CODEX: "openai-codex",
		OPENAI_CODEX_CLI: "openai-codex-cli",
		OPENCODE: "opencode",
		BEDROCK: "bedrock",
		VERTEX: "vertex",
		GEMINI: "gemini",
		OLLAMA: "ollama",
		LMSTUDIO: "lmstudio",
		DEEPSEEK: "deepseek",
		XAI: "xai",
		TOGETHER: "together",
		FIREWORKS: "fireworks",
		GROQ: "groq",
		POOLSIDE: "poolside",
		CEREBRAS: "cerebras",
		SAMBANOVA: "sambanova",
		NEBIUS: "nebius",
		CRUSOE: "crusoe",
		WALLY: "wally",
		BASETEN: "baseten",
		REQUESTY: "requesty",
		LITELLM: "litellm",
		HUGGINGFACE: "huggingface",
		VERCEL_AI_GATEWAY: "vercel-ai-gateway",
		V0: "v0",
		AIAND: "aiand",
		AIHUBMIX: "aihubmix",
		HICAP: "hicap",
		NOUS_RESEARCH: "nousResearch",
		HUAWEI_CLOUD_MAAS: "huawei-cloud-maas",
		WANDB: "wandb",
		XIAOMI: "xiaomi",
		TENCENT_TOKENHUB: "tencent-tokenhub",
		KILO: "kilo",
		ZAI: "zai",
		ZAI_CODING_PLAN: "zai-coding-plan",
		QWEN: "qwen",
		QWEN_CODE: "qwen-code",
		DOUBAO: "doubao",
		MISTRAL: "mistral",
		MOONSHOT: "moonshot",
		ASKSAGE: "asksage",
		MINIMAX: "minimax",
		DIFY: "dify",
		OCA: "oca",
		SAPAICORE: "sapaicore",
		OPENROUTER: "openrouter",
	},
	{
		get: (target, prop) => {
			if (typeof prop === "string" && prop in target) {
				return (target as any)[prop];
			}
			return typeof prop === "string" ? prop.toLowerCase().replace(/_/g, "-") : undefined;
		},
	},
);

export const PROVIDER_ID_ALIASES: Record<string, string> = {
	openai: BUILT_IN_PROVIDER.OPENAI_COMPATIBLE,
	togetherai: BUILT_IN_PROVIDER.TOGETHER,
	"sap-ai-core": BUILT_IN_PROVIDER.SAPAICORE,
};

export const BUILT_IN_PROVIDER_IDS: string[] = Object.values(BUILT_IN_PROVIDER);

export function isBuiltInProviderId(id: string): boolean {
	return Boolean(id);
}

export function normalizeProviderId(id: string): string {
	if (!id) return "";
	const normalized = id.trim();
	return PROVIDER_ID_ALIASES[normalized] ?? normalized;
}

export function resolveProviderModelCatalogKeys(id: string): string[] {
	return [id];
}

export function getGeneratedModelsForRuntimeProvider(...args: any[]): Record<string, any> {
	return {};
}

export function getModelOverridesForProvider(...args: any[]): Record<string, any> {
	return {};
}

export function getProviderIds(): string[] {
	return BUILT_IN_PROVIDER_IDS;
}

export async function getAllProviders(): Promise<any[]> {
	return [];
}

export async function getProvider(...args: any[]): Promise<any> {
	return undefined;
}

export function unregisterModel(...args: any[]): void {}
export function unregisterProvider(...args: any[]): void {}

export async function fetchLiveProviderModels(...args: any[]): Promise<any> {
	return {};
}

export async function fetchVercelTranscriptionModels(...args: any[]): Promise<any> {
	return {};
}

export function filterImageOutputModels(models: any): any {
	return models;
}

export function filterOpenAICodexModels(models: any): any {
	return models;
}

export function sortModelsByReleaseDate(models: any): any {
	return models;
}

export function preferCanonicalModelIds(models: any): any {
	return models;
}

export function providerOffersModelTool(...args: any[]): boolean {
	return false;
}

export function builtinProviderSupportsModelOperation(...args: any[]): boolean {
	return false;
}

export function resolveAudioTranscriptionRoute(...args: any[]): any {
	return undefined;
}

export function resolveProviderApiLineBaseUrl(...args: any[]): string {
	return "";
}

export function getBuiltinStreamingTranscriptionModels(...args: any[]): any[] {
	return [];
}

export function withLangfuseTraceAttributes(...args: any[]): any {
	return args[0];
}

export async function transcribeAudio(...args: any[]): Promise<any> {
	return { text: "" };
}

export async function createStreamingAudioTranscriptionSession(...args: any[]): Promise<any> {
	return {};
}

export function resolveGatewayProviderRegistrationSync(...args: any[]): any {
	return undefined;
}

export function toGatewayModelCapabilities(...args: any[]): any {
	return {};
}

export const GENERATED_CLINE_RECOMMENDED_MODELS: any = {};

export function getGeneratedProviderModels(...args: any[]): any[] {
	return [];
}

export const VERCEL_OPENROUTER_MODEL_ID_ALIAS_RULES: any[] = [];

export async function getProviderCollection(...args: any[]): Promise<any> {
	return {
		models: {},
		provider: {
			defaultModelId: "",
			baseUrl: "",
		},
	};
}

export function hasProvider(...args: any[]): boolean {
	return false;
}

export function registerAsyncHandler(...args: any[]): void {}

export function registerModel(...args: any[]): void {}
