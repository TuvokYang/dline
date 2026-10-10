import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { StringArray } from "@shared/proto/dline/common"
import { OpenAiModelsRequest } from "@shared/proto/dline/models"
import { Controller } from ".."

/**
 * List the models an OpenAI-compatible gateway exposes.
 *
 * The settings form calls this while the user is still editing, so the request
 * carries its own credentials and the result is not persisted.
 *
 * @param request Request containing the base URL and API key
 * @returns Array of model ids
 */
export async function refreshOpenAiModels(_controller: Controller, request: OpenAiModelsRequest): Promise<StringArray> {
    if (!request.baseUrl) {
        return StringArray.create({ values: [] })
    }

    const models = await discoverProviderModels("openai", {
        baseUrl: request.baseUrl,
        apiKey: request.apiKey || undefined,
    })

    return StringArray.create({ values: Object.keys(models) })
}
