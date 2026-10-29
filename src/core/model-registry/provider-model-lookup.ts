/**
 * Reads a single model from the persisted provider catalog.
 *
 * Providers whose catalog is discovered at runtime use this as the first step
 * of their model resolution, ahead of the profile's stored `modelInfo` and the
 * built-in default.
 */
import type { ModelInfo } from "@shared/providers/types"
import { ModelRegistry } from "./ModelRegistry"

export function findCatalogModel(providerId: string, modelId: string): ModelInfo | undefined {
    return ModelRegistry.getInstance().getProviderModels(providerId)?.models[modelId]
}
