import { EmptyRequest } from "@shared/proto/dline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { discoverProviderModels } from "@/core/model-registry/remote/model-refresh"
import { toProtobufModels } from "@/shared/proto-conversions/models/typeConversion"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const AIHUBMIX_PROVIDER_ID = "aihubmix"

/**
 * Fetches available models from AIhubmix and persists them to the provider catalog.
 * @param controller The controller instance
 * @param request Empty request object
 * @returns Response containing the AIhubmix models
 */
export async function getAihubmixModels(_controller: Controller, _request: EmptyRequest): Promise<OpenRouterCompatibleModelInfo> {
    const models = await discoverProviderModels(AIHUBMIX_PROVIDER_ID, undefined, { persist: true })
    if (Object.keys(models).length === 0) {
        Logger.error("Invalid response from AIhubmix API")
    }
    return OpenRouterCompatibleModelInfo.create({ models: toProtobufModels(models) })
}
