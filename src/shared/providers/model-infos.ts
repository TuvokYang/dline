/**
 * Unified model access layer.
 * Imports from individual provider model files via models/index.ts.
 * Used by seed-initializer.ts for JSON export to ~/.dline/providers/.
 */

import { allProviderModels } from "../../core/api/providers/models/index"
import type { ProviderModelsConfig } from "./types"

export { allProviderModels }

export function getProviderSeedConfig(providerId: string): ProviderModelsConfig | undefined {
    return allProviderModels[providerId]
}

export function getSeedProviderIds(): string[] {
    return Object.keys(allProviderModels)
}
