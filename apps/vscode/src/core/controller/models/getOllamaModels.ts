import { StringArray, StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

export async function getOllamaModels(_controller: Controller, _request: StringRequest): Promise<StringArray> {
	// Direct model provider queries are disabled. All requests route via TrueFoundry harness.
	return StringArray.create({ values: [] })
}
