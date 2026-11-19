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

export function normalizeProviderId(id: string): string {
	return id || "";
}

export function resolveGatewayProviderRegistrationSync(...args: any[]): any {
	return undefined;
}

export function toGatewayModelCapabilities(...args: any[]): any {
	return {};
}

export const GENERATED_CLINE_RECOMMENDED_MODELS: any[] = [];

export function getGeneratedProviderModels(...args: any[]): any[] {
	return [];
}

export const VERCEL_OPENROUTER_MODEL_ID_ALIAS_RULES: any[] = [];

export const BUILT_IN_PROVIDER_IDS: string[] = [];

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
