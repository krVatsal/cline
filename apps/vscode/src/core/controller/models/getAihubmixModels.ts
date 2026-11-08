import { EmptyRequest } from "@shared/proto/cline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/cline/models"
import { Controller } from ".."

/**
 * Fetches available models from AIhubmix (disabled - all routing goes through TrueFoundry)
 */
export async function getAihubmixModels(_controller: Controller, _request: EmptyRequest): Promise<OpenRouterCompatibleModelInfo> {
	return OpenRouterCompatibleModelInfo.create({ models: {} })
}
