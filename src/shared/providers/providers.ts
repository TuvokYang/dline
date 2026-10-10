// Relative import: the webview build resolves `@shared` but not `@core`, so the
// registry is reached the same way the sibling `model-infos.ts` reaches it.
import { allProviderModels } from "../../core/api/providers/models/index"
import type { ApiProvider } from "../api"
import type { ProviderModelsConfig, ProviderTier } from "./types"

/** One selectable API provider: its stored identifier and its display label. */
export interface ProviderOption {
    readonly value: ApiProvider
    readonly label: string
}

/** Group order in the selector; entries without a tier fall back to `standard`. */
const TIER_ORDER: Record<ProviderTier, number> = {
    frontier: 0,
    aggregator: 1,
    standard: 2,
}

function tierOf(config: ProviderModelsConfig): ProviderTier {
    return config.tier ?? "standard"
}

/**
 * Order two providers for the selector.
 *
 * Groups come first, then `frontier` sorts by its curated rank while the other
 * groups sort alphabetically. A `frontier` entry without a rank falls to the end
 * of its own group rather than jumping ahead of ranked ones.
 */
function compareProviders(left: ProviderModelsConfig, right: ProviderModelsConfig): number {
    const tierDelta = TIER_ORDER[tierOf(left)] - TIER_ORDER[tierOf(right)]
    if (tierDelta !== 0) {
        return tierDelta
    }
    if (tierOf(left) === "frontier") {
        const rankDelta = (left.frontierRank ?? Number.MAX_SAFE_INTEGER) - (right.frontierRank ?? Number.MAX_SAFE_INTEGER)
        if (rankDelta !== 0) {
            return rankDelta
        }
    }
    return left.providerName.localeCompare(right.providerName)
}

/**
 * Providers offered by the settings selector, derived from the model registry.
 *
 * Region variants are excluded: they carry their own catalog but are reached
 * through the parent provider's region option, not as separate entries. Adding a
 * provider therefore requires only a new registry entry — nothing here changes.
 */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = Object.values(allProviderModels)
    .filter((config) => config.regionVariantOf === undefined)
    .sort(compareProviders)
    .map((config) => ({ value: config.provider as ApiProvider, label: config.providerName }))

/**
 * Resolve a provider's display label.
 *
 * @param provider Stored provider identifier.
 * @returns The registered display name, or the identifier when it is unknown.
 */
export function getProviderLabel(provider: ApiProvider): string {
    return allProviderModels[provider]?.providerName ?? provider
}
