import type { ClineRulesToggles } from "@shared/cline-rules"
import { capabilityResourceId } from "./capability-resource-id"

/**
 * Inputs a prune decision depends on.
 *
 * `discoveredIds` holds ids normalized through `capabilityResourceId`.
 */
export interface OrphanPruneInput {
    /** Stored sparse overrides for one capability kind in one scope. */
    readonly overrides: Readonly<ClineRulesToggles>
    /** Normalized ids the discovery scan actually found. */
    readonly discoveredIds: ReadonlySet<string>
    /** True only when every source directory was read successfully. */
    readonly scanComplete: boolean
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
 * Pruning is only safe when the scan is authoritative. Two guards must both
 * hold, because each one alone has produced a real failure mode:
 *
 * - An incomplete scan (an unreadable directory) would report live resources as
 *   missing and silently discard the user's decisions.
 * - An empty result usually means the workspace is not ready yet, not that every
 *   capability was deleted.
 *
 * Each remaining key is matched individually instead of trusting one stored-key
 * format. Keys reach these maps from several writers, and the scopes are
 * persisted by different documents: the global map is written with raw scan
 * paths, task maps carry whatever resource id the webview received, while only
 * the workspace document went through the key-normalization migration. A single
 * "keys are normalized" flag could therefore describe one scope and be applied
 * to three, deleting every `false` the user set at another scope. Resolving each
 * key to the resource it names removes that assumption: a key is kept when it
 * resolves to a discovered id, either literally or through normalization.
 *
 * Remote entries are never pruned: they are not produced by the local scan, so
 * their absence carries no information.
 */
export function pruneOrphanOverrides(input: OrphanPruneInput): OrphanPruneResult {
    if (!input.scanComplete || input.discoveredIds.size === 0) {
        return { removedIds: [] }
    }

    const removedIds: string[] = []
    const pruned: ClineRulesToggles = {}

    for (const [id, enabled] of Object.entries(input.overrides)) {
        if (id.startsWith("remote:") || resolvesToDiscovered(id, input.discoveredIds)) {
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

/**
 * True when a stored key names one of the discovered resources.
 *
 * A literal hit covers both forms already in use. Normalizing covers a key
 * stored before the migration and a key stored by a writer that still records
 * the raw path, without requiring either writer to change what it persists.
 */
function resolvesToDiscovered(id: string, discoveredIds: ReadonlySet<string>): boolean {
    if (discoveredIds.has(id)) return true
    const normalized = capabilityResourceId(id)
    return normalized !== "" && discoveredIds.has(normalized)
}
