/**
 * TODO efficiency of a canonical Usage fact (WS-111).
 *
 * A checklist item is identified by its own text, so "the same item" means the
 * same line the model reported, not the same index. The ledger keeps only what
 * the counters need: when the item was first seen and in which logical request.
 * The text itself never leaves the machine.
 *
 * A completion may arrive long after the item was first declared — after a seal
 * batch, or after a restart. When the first-seen record is gone the completion
 * is still counted, but it contributes no round sample: an invented round count
 * would make the distribution describe something that never happened.
 */

import {
    EMPTY_EXECUTION_SUMMARY,
    type ExecutionSummary,
    type RoundsDistribution,
    TODO_ROUND_BUCKETS,
    type TodoTransition,
    todoRoundBucket,
    type UsageTodosWire,
} from "../contracts/usageExecution"

/** Where and when an item was first reported. */
export interface TodoOccurrence {
    /** Monotonic logical-request ordinal at first sight; the round scale. */
    readonly firstRound: number
    /** Active-minute timestamp at first sight, used for the duration sample. */
    readonly firstSeenAt: number
}

/** What the caller knows about one reported checklist change. */
export interface TodoObservation {
    /** Stable identity of the item; a hash of its text, never the text itself. */
    readonly itemId: string
    readonly transition: TodoTransition
    /** Monotonic logical-request ordinal of the request that reported it. */
    readonly round: number
    /** Active-minute timestamp of the report. */
    readonly at: number
}

export interface TodoLedgerPort {
    read(itemId: string): TodoOccurrence | undefined
    write(itemId: string, occurrence: TodoOccurrence): void
    forget(itemId: string): void
}

export interface MutableTodoCounters {
    declared: number
    completed: number
    reopened: number
    abandoned: number
    rounds: { count: number; sum: number; min: number; max: number; buckets: number[] }
    activeMs: { count: number; sum: number; min: number; max: number }
    /**
     * Items this fact has already accounted for as existing.
     *
     * `declared` is the size of this set, not a count of declaration reports. An
     * item declared in an earlier batch and completed here is still an item this
     * fact knows about, so it must be declared here too; otherwise
     * `completed <= declared + reopened` would fail for a legitimate completion.
     */
    readonly declaredItems: Set<string>
}

export function createTodoCounters(): MutableTodoCounters {
    return {
        declared: 0,
        completed: 0,
        reopened: 0,
        abandoned: 0,
        rounds: { count: 0, sum: 0, min: 0, max: 0, buckets: Array(TODO_ROUND_BUCKETS).fill(0) },
        activeMs: { count: 0, sum: 0, min: 0, max: 0 },
        declaredItems: new Set<string>(),
    }
}

/** Count an item as known to this fact at most once. */
function markDeclared(counters: MutableTodoCounters, itemId: string): boolean {
    if (counters.declaredItems.has(itemId)) return false
    counters.declaredItems.add(itemId)
    counters.declared += 1
    return true
}

/** Items the current checklist still holds, so a later report can be matched. */
export interface TodoApplyResult {
    /** Whether a round sample was recorded for this completion. */
    readonly sampled: boolean
    /** Whether the ledger had no record and the caller must not treat it as zero. */
    readonly unknownFirstSeen: boolean
}

/**
 * Apply one reported transition to the counters and the ledger.
 *
 * The caller decides which fact the observation belongs to; this function only
 * maintains the relations the wire contract states.
 */
export function applyTodoObservation(
    counters: MutableTodoCounters,
    ledger: TodoLedgerPort,
    observation: TodoObservation,
): TodoApplyResult {
    const existing = ledger.read(observation.itemId)

    switch (observation.transition) {
        case "declared": {
            // Re-declaring an item the ledger already knows is the same declaration.
            if (existing !== undefined) return { sampled: false, unknownFirstSeen: false }
            markDeclared(counters, observation.itemId)
            ledger.write(observation.itemId, { firstRound: observation.round, firstSeenAt: observation.at })
            return { sampled: false, unknownFirstSeen: false }
        }
        case "completed": {
            // The item exists in this fact even if its declaration was reported in
            // an earlier batch: the declaration is what the completion refers to,
            // so it must be counted here for the counters to stay consistent.
            markDeclared(counters, observation.itemId)
            counters.completed += 1
            // The ledger keeps the occurrence across the completion: a later
            // reopen still needs the original first-seen identity.
            return recordCompletion(counters, existing, observation)
        }
        case "reopened": {
            markDeclared(counters, observation.itemId)
            counters.reopened += 1
            return { sampled: false, unknownFirstSeen: existing === undefined }
        }
        case "abandoned": {
            markDeclared(counters, observation.itemId)
            counters.abandoned += 1
            ledger.forget(observation.itemId)
            return { sampled: false, unknownFirstSeen: false }
        }
        default: {
            // A transition outside the catalog is a producer bug, not a silent no-op.
            throw new Error(`Unknown TODO transition: ${String(observation.transition)}`)
        }
    }
}

function recordCompletion(
    counters: MutableTodoCounters,
    existing: TodoOccurrence | undefined,
    observation: TodoObservation,
): TodoApplyResult {
    if (existing === undefined) {
        // A completion whose first sight is gone is still a completion. Inventing
        // a round count would make the distribution claim a measurement it lacks.
        return { sampled: false, unknownFirstSeen: true }
    }
    const rounds = Math.max(1, observation.round - existing.firstRound + 1)
    const activeMs = Math.max(0, observation.at - existing.firstSeenAt)
    observeRounds(counters, rounds)
    observeActive(counters, activeMs)
    return { sampled: true, unknownFirstSeen: false }
}

function observeRounds(counters: MutableTodoCounters, rounds: number): void {
    const distribution = counters.rounds
    distribution.count += 1
    distribution.sum += rounds
    distribution.min = distribution.count === 1 ? rounds : Math.min(distribution.min, rounds)
    distribution.max = distribution.count === 1 ? rounds : Math.max(distribution.max, rounds)
    distribution.buckets[todoRoundBucket(rounds)] += 1
}

function observeActive(counters: MutableTodoCounters, activeMs: number): void {
    const summary = counters.activeMs
    summary.count += 1
    summary.sum += activeMs
    summary.min = summary.count === 1 ? activeMs : Math.min(summary.min, activeMs)
    summary.max = summary.count === 1 ? activeMs : Math.max(summary.max, activeMs)
}

/**
 * Freeze the counters for the wire.
 *
 * Nothing is emitted when the fact saw no checklist activity at all, because an
 * absent `todos` object means "not reported" and a zero object would claim a
 * measured zero.
 */
export function sealTodos(counters: MutableTodoCounters): UsageTodosWire | undefined {
    if (counters.declared === 0 && counters.completed === 0 && counters.reopened === 0 && counters.abandoned === 0) {
        return undefined
    }
    const rounds: RoundsDistribution =
        counters.rounds.count === 0
            ? { ...EMPTY_EXECUTION_SUMMARY, buckets: Array(TODO_ROUND_BUCKETS).fill(0) }
            : {
                  count: counters.rounds.count,
                  sum: counters.rounds.sum,
                  min: counters.rounds.min,
                  max: counters.rounds.max,
                  buckets: [...counters.rounds.buckets],
              }
    const active: ExecutionSummary =
        counters.activeMs.count === 0
            ? EMPTY_EXECUTION_SUMMARY
            : {
                  count: counters.activeMs.count,
                  sum: counters.activeMs.sum,
                  min: counters.activeMs.min,
                  max: counters.activeMs.max,
              }
    return {
        declared: counters.declared,
        completed: counters.completed,
        reopened: counters.reopened,
        abandoned: counters.abandoned,
        rounds_to_complete: rounds,
        active_ms_to_complete: active,
    }
}

/**
 * Merge two counter sets of the same fact, as two accumulated minutes do.
 *
 * `declared` is not summed: an item declared in both minutes is one item, so the
 * merged declaration count is the size of the union. Summing would inflate the
 * denominator of every completion rate.
 */
export function mergeTodoCounters(left: MutableTodoCounters, right: MutableTodoCounters): MutableTodoCounters {
    const merged = createTodoCounters()
    for (const itemId of left.declaredItems) merged.declaredItems.add(itemId)
    for (const itemId of right.declaredItems) merged.declaredItems.add(itemId)
    merged.declared = merged.declaredItems.size
    merged.completed = left.completed + right.completed
    merged.reopened = left.reopened + right.reopened
    merged.abandoned = left.abandoned + right.abandoned
    merged.rounds = mergeDistribution(left.rounds, right.rounds)
    merged.activeMs = mergeSummary(left.activeMs, right.activeMs)
    return merged
}

function mergeDistribution(
    left: MutableTodoCounters["rounds"],
    right: MutableTodoCounters["rounds"],
): MutableTodoCounters["rounds"] {
    if (right.count === 0) return { ...left, buckets: [...left.buckets] }
    if (left.count === 0) return { ...right, buckets: [...right.buckets] }
    return {
        count: left.count + right.count,
        sum: left.sum + right.sum,
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
        buckets: left.buckets.map((value, index) => value + (right.buckets[index] ?? 0)),
    }
}

function mergeSummary(
    left: MutableTodoCounters["activeMs"],
    right: MutableTodoCounters["activeMs"],
): MutableTodoCounters["activeMs"] {
    if (right.count === 0) return { ...left }
    if (left.count === 0) return { ...right }
    return {
        count: left.count + right.count,
        sum: left.sum + right.sum,
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
    }
}

/** An in-memory ledger for one task; persistence is the caller's boundary. */
export function createMemoryTodoLedger(initial?: Iterable<readonly [string, TodoOccurrence]>): TodoLedgerPort & {
    snapshot(): ReadonlyMap<string, TodoOccurrence>
} {
    const entries = new Map<string, TodoOccurrence>(initial)
    return {
        read: (itemId) => entries.get(itemId),
        write: (itemId, occurrence) => {
            entries.set(itemId, occurrence)
        },
        forget: (itemId) => {
            entries.delete(itemId)
        },
        snapshot: () => new Map(entries),
    }
}
