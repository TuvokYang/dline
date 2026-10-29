import { StringArray, StringRequest } from "@shared/proto/dline/common"
import { discoverProviderModels } from "@/core/model-registry/remote/model-refresh"
import { Controller } from ".."

const OLLAMA_PROVIDER_ID = "ollama"

/**
 * Fetches available models from Ollama and persists them to the provider catalog.
 * @param controller The controller instance
 * @param request The request containing the base URL (optional)
 * @returns Array of model names
 */
export async function getOllamaModels(_controller: Controller, request: StringRequest): Promise<StringArray> {
    const baseUrl = request.value || undefined
    if (baseUrl && !URL.canParse(baseUrl)) {
        return StringArray.create({ values: [] })
    }

    const models = await discoverProviderModels(OLLAMA_PROVIDER_ID, { baseUrl }, { persist: true })
    return StringArray.create({ values: Object.keys(models).sort() })
}
