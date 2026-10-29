import { findEnabledProfiles } from "@core/controller/file/getApiProfiles"
import { liteLlmModelSource } from "@core/model-registry/remote/vendors/litellm"
import * as SecretsManager from "@core/storage/secrets"
import type { ModelInfo } from "@shared/api"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { StateManager } from "@/core/storage/StateManager"
import { toProtobufModels } from "@/shared/proto-conversions/models/typeConversion"
import { Logger } from "@/shared/services/Logger"
import { sendLiteLlmModelsEvent } from "./subscribeToLiteLlmModels"

const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000"

/**
 * Resolve the deployment to query, preferring an enabled profile and falling
 * back to the legacy apiConfiguration fields.
 */
function resolveLiteLlmCredentials(): { apiKey?: string; baseUrl: string } {
    for (const profile of findEnabledProfiles("litellm")) {
        const apiKey = SecretsManager.getApiKey(profile.id)
        if (apiKey) {
            return { apiKey, baseUrl: profile.baseUrl || DEFAULT_LITELLM_BASE_URL }
        }
    }

    const apiConfiguration = StateManager.get().getApiConfiguration()
    return {
        apiKey: (apiConfiguration as any).liteLlmApiKey,
        baseUrl: (apiConfiguration as any).liteLlmBaseUrl || DEFAULT_LITELLM_BASE_URL,
    }
}

/**
 * Core function: Refreshes the LiteLLM models and returns application types
 * @param controller The controller instance
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshLiteLlmModels(): Promise<Record<string, ModelInfo>> {
    let models: Record<string, ModelInfo> = {}

    try {
        const { apiKey, baseUrl } = resolveLiteLlmCredentials()
        if (!apiKey) {
            throw new Error("LiteLLM API key is not configured or is invalid")
        }

        // Callers rely on failures surfacing, so this bypasses the swallowing
        // discovery entry point and drives the vendor source directly.
        models = await liteLlmModelSource.fetchModels({ apiKey, baseUrl })
    } catch (error) {
        Logger.error("Error fetching LiteLLM models:", error)
        throw error
    }

    // Send event to subscribers
    try {
        await sendLiteLlmModelsEvent(
            OpenRouterCompatibleModelInfo.create({
                models: toProtobufModels(models),
            }),
        )
    } catch (error) {
        Logger.error("Error sending LiteLLM models event:", error)
    }

    return models
}
