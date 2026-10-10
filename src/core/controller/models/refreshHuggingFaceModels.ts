import { EmptyRequest } from "@shared/proto/dline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { discoverProviderModels } from "@/core/model-registry/remote/model-refresh"
import { toProtobufModels } from "@/shared/proto-conversions/models/typeConversion"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const HUGGINGFACE_PROVIDER_ID = "huggingface"

/**
 * Refreshes the Hugging Face models and returns the updated model list.
 *
 * The listing overlays the built-in catalog, so seeded models keep their
 * static context window and prices while the discovery adds newly routed ids.
 */
export async function refreshHuggingFaceModels(
    _controller: Controller,
    _request: EmptyRequest,
): Promise<OpenRouterCompatibleModelInfo> {
    const models = await discoverProviderModels(HUGGINGFACE_PROVIDER_ID, undefined, { persist: true })
    if (Object.keys(models).length === 0) {
        Logger.error("Invalid response from Hugging Face API")
    }
    return OpenRouterCompatibleModelInfo.create({ models: toProtobufModels(models) })
}
