import { StringArray, type StringRequest } from "@shared/proto/dline/common"
import { discoverProviderModels } from "@/core/model-registry/remote/model-refresh"
import type { Controller } from ".."

const LMSTUDIO_PROVIDER_ID = "lmstudio"

/**
 * Fetches available models from LM Studio and persists them to the provider catalog.
 * @param controller The controller instance
 * @param request The request containing the base URL (optional)
 * @returns Array of model ids
 */
export async function getLmStudioModels(_controller: Controller, request: StringRequest): Promise<StringArray> {
    const baseUrl = request.value || undefined
    if (baseUrl && !URL.canParse(baseUrl)) {
        return StringArray.create({ values: [] })
    }

    const models = await discoverProviderModels(LMSTUDIO_PROVIDER_ID, { baseUrl }, { persist: true })
    return StringArray.create({ values: Object.keys(models).sort() })
}
