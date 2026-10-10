import { resolveSavedCredentials } from "@core/model-registry/remote/model-credentials"
import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { EmptyRequest } from "@shared/proto/dline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { toProtobufModels } from "@/shared/proto-conversions/models/typeConversion"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const REQUESTY_PROVIDER_ID = "requesty"

/**
 * Refreshes the Requesty models and returns the updated model list
 * @param controller The controller instance
 * @param request Empty request object
 * @returns Response containing the Requesty models
 */
export async function refreshRequestyModels(controller: Controller, _: EmptyRequest): Promise<OpenRouterCompatibleModelInfo> {
    // Requesty keeps its router URL in global settings rather than on the profile.
    const baseUrl = controller.stateManager.getGlobalSettingsKey("requestyBaseUrl") as string | undefined
    const credentials = { ...resolveSavedCredentials(REQUESTY_PROVIDER_ID), baseUrl }
    const models = await discoverProviderModels(REQUESTY_PROVIDER_ID, credentials, { persist: true })

    if (Object.keys(models).length === 0) {
        Logger.error("Invalid response from Requesty API")
    }

    return OpenRouterCompatibleModelInfo.create({ models: toProtobufModels(models) })
}
