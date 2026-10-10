import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { EmptyRequest } from "@shared/proto/dline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { toProtobufModels } from "@/shared/proto-conversions/models/typeConversion"
import { Controller } from ".."

const HICAP_PROVIDER_ID = "hicap"

/**
 * Refreshes the Hicap models and returns the updated model list
 * @param controller The controller instance
 * @param request Empty request object
 * @returns Response containing the Hicap models
 */
export async function refreshHicapModels(
    _controller: Controller,
    _request: EmptyRequest,
): Promise<OpenRouterCompatibleModelInfo> {
    const models = await discoverProviderModels(HICAP_PROVIDER_ID, undefined, { persist: true })
    return OpenRouterCompatibleModelInfo.create({ models: toProtobufModels(models) })
}
