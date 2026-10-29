import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { ModelInfo } from "@shared/api"
import { basetenModels } from "../../../shared/api"
import { Controller } from ".."

export function resolveBasetenSupportsTools(rawModel: any, staticModelInfo?: ModelInfo): boolean | undefined {
    const supportedFeatures = rawModel?.supported_features
    return Array.isArray(supportedFeatures) ? supportedFeatures.includes("tools") : staticModelInfo?.capabilities?.supportsTools
}

/**
 * Refresh the Baseten catalog from the vendor listing.
 *
 * Falls back to the built-in models when the listing is unavailable, so the
 * picker still offers something usable without a working key.
 *
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshBasetenModels(_controller: Controller): Promise<Record<string, ModelInfo>> {
    const models = await discoverProviderModels("baseten", undefined, { persist: true })
    return Object.keys(models).length > 0 ? models : basetenModels
}
