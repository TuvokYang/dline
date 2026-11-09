/**
 * Low-cardinality attribution for StateManager persistence flushes.
 *
 * `flushPendingState` reports a single `settings.state_flush` duration, which cannot
 * say whether a slow flush came from the settings document, per-task documents, or a
 * value store such as secrets. These helpers turn the batch costs captured while
 * writing into dimensions an operator can group by, without exposing per-write
 * timings or counts that would make the metric cardinality grow with usage.
 */

/**
 * Conversation length bucket for `turn_prepare.history_update`.
 *
 * The span wraps a synchronous projection that walks the whole message list, so a
 * duration alone cannot separate "slow projection" from "long conversation". A
 * bucket keeps the correlation without making message counts a metric dimension.
 */
export type MessageCountBucket = "<1000" | "<5000" | ">=5000"

/** Bucket a message count; thresholds mirror the decision boundary for session length. */
export function bucketMessageCount(count: number): MessageCountBucket {
    if (count < 1000) return "<1000"
    if (count < 5000) return "<5000"
    return ">=5000"
}

/** Storage store a persistence batch wrote through, as reported to telemetry. */
export type PersistenceStore = "global" | "settings" | "secrets" | "workspace" | "task"

/** One store's cost inside a single persistence batch. */
export interface StoreCostSample {
    batch: number
    durationMs: number
}

/** Costs of one persistence batch, complete only when every store reported. */
export type BatchStoreCosts = Partial<Record<PersistenceStore, StoreCostSample>> & { batch: number }

/**
 * Per-store cost summed over every batch one flush drained.
 *
 * A flush drains until nothing is pending, so it can write several batches and
 * each batch publishes only its own complete sample. Attributing a flush to the
 * batch that settled last would name the wrong store: a 240 ms task batch
 * followed by a 15 ms settings batch would report `settings`. Summing per store
 * over the drained batches keeps the attribution tied to the work the flush did.
 */
export type FlushStoreCosts = Partial<Record<PersistenceStore, number>>

/** Dirty-set shape of one flush, reported as a low-cardinality dimension. */
export type FlushDirtyScope = "none" | "settings" | "task" | "mixed"

/** Attribution of the slowest store in a flush, reported as a low-cardinality dimension. */
export type FlushSlowestStore = PersistenceStore | "unknown" | "not_applicable"

/** Wall-clock cost above which a flush is worth attributing to one store. */
export const SLOW_FLUSH_THRESHOLD_MS = 200

/** Stores every persistence batch writes in parallel. */
export const PERSISTENCE_STORES: readonly PersistenceStore[] = ["global", "settings", "secrets", "workspace", "task"]

/** Pending key counts per store, as read before a flush starts draining. */
export interface PendingStoreCounts {
    settings: number
    secrets: number
    workspace: number
    tasks: number
}

/**
 * Classify which dirty categories a flush drained. `settings` covers the canonical
 * settings document plus secrets and workspace state, because all three are plain
 * value stores; `task` covers per-task settings documents.
 */
export function classifyDirtyScope(pending: PendingStoreCounts): FlushDirtyScope {
    const valueStoresDirty = pending.settings > 0 || pending.secrets > 0 || pending.workspace > 0
    const taskStoresDirty = pending.tasks > 0
    if (valueStoresDirty && taskStoresDirty) return "mixed"
    if (valueStoresDirty) return "settings"
    if (taskStoresDirty) return "task"
    return "none"
}

/**
 * Name the store that dominated a slow flush.
 *
 * A fast flush is not attributed at all, and a slow one without a complete batch
 * sample reports `unknown` rather than guessing, so the dimension stays an
 * attribution signal instead of a source of false confidence.
 */
export function attributeSlowestStore(durationMs: number, costs: FlushStoreCosts | undefined): FlushSlowestStore {
    if (durationMs < SLOW_FLUSH_THRESHOLD_MS) return "not_applicable"
    if (!costs) return "unknown"
    let slowestStore: PersistenceStore | undefined
    let slowestMs = -1
    for (const store of PERSISTENCE_STORES) {
        const duration = costs[store] ?? -1
        if (duration > slowestMs) {
            slowestMs = duration
            slowestStore = store
        }
    }
    return slowestStore ?? "unknown"
}
