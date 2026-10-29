import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { ModelInfo } from "@shared/api"
import { groqModels } from "../../../shared/api"
import { Controller } from ".."

export function resolveGroqSupportsTools(rawModel: any, staticModelInfo?: ModelInfo): boolean | undefined {
    const supportedFeatures = rawModel?.supportedFeatures ?? rawModel?.supported_features
    if (Array.isArray(supportedFeatures)) {
        return supportedFeatures.includes("tools")
    }
    if (supportedFeatures && typeof supportedFeatures.tools === "boolean") {
        return supportedFeatures.tools
    }
    return staticModelInfo?.capabilities?.supportsTools
}

/**
 * Refresh the Groq catalog from the vendor listing.
 *
 * Falls back to the built-in models when the listing is unavailable, so the
 * picker still offers something usable without a working key.
 *
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshGroqModels(_controller: Controller): Promise<Record<string, ModelInfo>> {
    const models = await discoverProviderModels("groq", undefined, { persist: true })
    return Object.keys(models).length > 0 ? models : groqModels
}
