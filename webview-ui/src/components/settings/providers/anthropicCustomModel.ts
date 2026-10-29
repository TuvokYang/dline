import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"

export interface BuildCustomModelInfoOptions {
    modelId: string
    defaults: Partial<ModelInfo>
    current?: ModelInfo
    capabilities?: ModelCapabilities
    pricing?: ModelPricing
}

/**
 * Builds model metadata for Anthropic custom model profiles.
 *
 * @param options Custom model ID, defaults, existing model info, and provider overrides.
 * @returns ModelInfo that preserves the custom model ID and selected metadata.
 */
export function buildCustomModelInfo(options: BuildCustomModelInfoOptions): ModelInfo {
    const modelId = options.modelId
    return {
        ...options.defaults,
        ...options.current,
        id: modelId,
        name: options.current?.name ?? options.defaults.name ?? modelId,
        capabilities: options.capabilities ?? options.current?.capabilities ?? options.defaults.capabilities,
        pricing: options.pricing ?? options.current?.pricing ?? options.defaults.pricing,
    }
}
