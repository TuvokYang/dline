import { isGlobalStateKey, isSettingsKey } from "@shared/storage/state-keys"
import { Logger } from "@/shared/services/Logger"
import type { ClineFileStorage } from "@/shared/storage/ClineFileStorage"

/**
 * Marker recording the highest cleanup generation already applied to
 * globalState.json.
 *
 * A plain boolean could never repair a store that a later defect polluted
 * again, so the marker carries a generation and the sweep reruns whenever
 * GLOBAL_STATE_CLEANUP_GENERATION is raised.
 */
export const GLOBAL_STATE_CLEANUP_GENERATION_KEY = "__globalStateCleanupGeneration"

/** Raise this when a new defect makes another sweep necessary. */
export const GLOBAL_STATE_CLEANUP_GENERATION = 1

/**
 * Legacy keys whose value must be carried over to a renamed key before the
 * sweep removes them.
 *
 * Dropping such a value outright is not a cosmetic loss: the version tracker
 * would read as "first launch" and replay the update announcement.
 */
const RENAMED_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [["clineVersion", "version"]]

/**
 * Keys that are not declared in GLOBAL_STATE_FIELDS but must survive the sweep.
 *
 * Migration markers describe the store itself rather than application state, so
 * removing them would make every migration run again on the next launch.
 */
const PRESERVED_INTERNAL_KEYS = new Set([
    GLOBAL_STATE_CLEANUP_GENERATION_KEY,
    "__vscodeMigrationVersion",
    "__settingsMigrationVersion",
    "cline.generatedMachineId",
])

export interface GlobalStateCleanupResult {
    /** False when the store was already at the current generation. */
    readonly performed: boolean
    /** Keys removed by this sweep, in discovery order. */
    readonly removedKeys: readonly string[]
}

/** A key survives only when it is a declared GlobalState field or an internal marker. */
function shouldRemoveKey(key: string): boolean {
    if (PRESERVED_INTERNAL_KEYS.has(key)) return false
    if (isSettingsKey(key)) return true
    return !isGlobalStateKey(key)
}

/**
 * Remove entries that no longer belong in the global state document.
 *
 * Three groups accumulated there over time: Settings that an older build
 * projected into global state, fields that were dropped from the schema, and
 * provider configuration that now lives in API profiles. All of them are
 * unreadable through the current key partition, so they only inflate the file
 * and confuse diagnostics.
 *
 * The sweep is idempotent and guarded by a generation marker. A failed write
 * leaves the marker untouched so the next launch retries.
 */
export async function cleanupLegacyGlobalState(store: ClineFileStorage): Promise<GlobalStateCleanupResult> {
    const appliedGeneration = store.get(GLOBAL_STATE_CLEANUP_GENERATION_KEY)
    if (typeof appliedGeneration === "number" && appliedGeneration >= GLOBAL_STATE_CLEANUP_GENERATION) {
        return { performed: false, removedKeys: [] }
    }

    const removedKeys = store.keys().filter(shouldRemoveKey)

    const entries: Record<string, unknown> = {}
    for (const key of removedKeys) {
        entries[key] = undefined
    }

    // Carry renamed values forward. An existing current value wins, because it
    // was written by a build that already knows the new key.
    for (const [legacy, current] of RENAMED_KEYS) {
        const legacyValue = store.get(legacy)
        if (legacyValue !== undefined && store.get(current) === undefined) {
            entries[current] = legacyValue
        }
    }

    entries[GLOBAL_STATE_CLEANUP_GENERATION_KEY] = GLOBAL_STATE_CLEANUP_GENERATION

    await store.setBatchAsync(entries)

    if (removedKeys.length > 0) {
        Logger.debug(`[GlobalStateCleanup] Removed ${removedKeys.length} legacy keys: ${removedKeys.join(", ")}`)
    }

    return { performed: true, removedKeys }
}
