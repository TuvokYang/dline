import type { ClineRulesToggles } from "@shared/cline-rules"

/**
 * Inputs a prune decision depends on.
 *
 * `discoveredIds` must already be normalized through `capabilityResourceId`,
 * because comparing a stored override against a raw scan path is exactly how
 * an override gets mistaken for an orphan.
 */
export interface OrphanPruneInput {
    /** Stored sparse overrides for one capability kind in one scope. */
    readonly overrides: Readonly<ClineRulesToggles>
    /** Normalized ids the discovery scan actually found. */
    readonly discoveredIds: ReadonlySet<string>
    /** True only when every source directory was read successfully. */
    readonly scanComplete: boolean
    /** True once stored keys use the normalized form. */
    readonly keysNormalized: boolean
}

export interface OrphanPruneResult {
    /** Undefined when nothing should be written. */
    readonly pruned?: ClineRulesToggles
    /** Ids removed by this decision, in stored order. */
    readonly removedIds: readonly string[]
}

/**
 * Decide which overrides no longer refer to an existing resource.
 *
 * Pruning is only safe when the scan is authoritative. Three guards must all
 * hold, because each one alone has produced a real failure mode:
 *
 * - An incomplete scan (an unreadable directory) would report live resources as
 *   missing and silently discard the user's decisions.
 * - An empty result usually means the workspace is not ready yet, not that every
 *   capability was deleted.
 * - Un-normalized stored keys would never match a normalized scan id, so every
 *   override would look orphaned.
 *
 * Remote entries are never pruned: they are not produced by the local scan, so
 * their absence carries no information.
 */
export function pruneOrphanOverrides(input: OrphanPruneInput): OrphanPruneResult {
    if (!input.scanComplete || !input.keysNormalized || input.discoveredIds.size === 0) {
        return { removedIds: [] }
    }

    const removedIds: string[] = []
    const pruned: ClineRulesToggles = {}

    for (const [id, enabled] of Object.entries(input.overrides)) {
        if (id.startsWith("remote:") || input.discoveredIds.has(id)) {
            pruned[id] = enabled
            continue
        }
        removedIds.push(id)
    }

    if (removedIds.length === 0) {
        return { removedIds: [] }
    }

    return { pruned, removedIds }
}
