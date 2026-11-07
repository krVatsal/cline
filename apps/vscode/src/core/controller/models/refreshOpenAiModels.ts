import { StringArray } from "@shared/proto/cline/common"
import { OpenAiModelsRequest } from "@shared/proto/cline/models"
import { Controller } from ".."

/**
 * Fetches available models from the OpenAI API
 * @param controller The controller instance
 * @param request Request containing the base URL and API key
 * @returns Array of model names
 */
export async function refreshOpenAiModels(_controller: Controller, _request: OpenAiModelsRequest): Promise<StringArray> {
	// Direct model provider queries are disabled. All requests route via TrueFoundry harness.
	return StringArray.create({ values: [] })
}
