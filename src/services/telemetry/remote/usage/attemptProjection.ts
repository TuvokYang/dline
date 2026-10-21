/**
 * Attempt distribution of the logical requests behind a canonical Usage fact (WS-111).
 *
 * A logical request keeps one identity across recursive retries, and each retry
 * reports a higher `taskAttempt`. The sample is therefore `taskAttempt + 1`: how
 * many attempts that request needed in total. This is what makes a model's
 * "gets it right first time" rate measurable, which the request counters alone
 * cannot answer.
 */

import { EMPTY_EXECUTION_SUMMARY, type ExecutionSummary, type UsageTaskAttemptsWire } from "../contracts/usageExecution"

/** Mutable accumulator of attempt samples for one fact. */
export interface AttemptAccumulator {
    count: number
    sum: number
    min: number
    max: number
}

export function createAttemptAccumulator(): AttemptAccumulator {
    return { count: 0, sum: 0, min: 0, max: 0 }
}

/**
 * Record one logical request's attempt count.
 *
 * `taskAttempt` is zero-based, so a request that succeeded on its first try
 * contributes one. A negative or non-integer value is a producer bug and throws
 * rather than silently skewing the distribution.
 */
export function observeAttempt(accumulator: AttemptAccumulator, taskAttempt: number): void {
    if (!Number.isSafeInteger(taskAttempt) || taskAttempt < 0) {
        throw new Error("taskAttempt must be a non-negative safe integer")
    }
    const attempts = taskAttempt + 1
    accumulator.count += 1
    accumulator.sum += attempts
    if (accumulator.count === 1) {
        accumulator.min = attempts
        accumulator.max = attempts
        return
    }
    if (attempts < accumulator.min) accumulator.min = attempts
    if (attempts > accumulator.max) accumulator.max = attempts
}

/**
 * Freeze the accumulator for the wire.
 *
 * `expectedRequests` is the fact's request total. When it is known the count must
 * match, because every request settles exactly one attempt sample; a mismatch
 * means a settlement was missed or double-counted. Passing `undefined` skips the
 * check for callers that emit before the request total is final.
 */
export function sealAttempts(accumulator: AttemptAccumulator, expectedRequests?: number): UsageTaskAttemptsWire {
    if (expectedRequests !== undefined && expectedRequests !== accumulator.count) {
        throw new Error(`Attempt samples (${accumulator.count}) must equal the fact request total (${expectedRequests})`)
    }
    if (accumulator.count === 0) return EMPTY_EXECUTION_SUMMARY
    return { count: accumulator.count, sum: accumulator.sum, min: accumulator.min, max: accumulator.max }
}

/**
 * Merge two accumulators, which happens when two minutes of the same fact are
 * combined into one batch.
 */
export function mergeAttempts(left: AttemptAccumulator, right: AttemptAccumulator): AttemptAccumulator {
    if (right.count === 0) return { ...left }
    if (left.count === 0) return { ...right }
    return {
        count: left.count + right.count,
        sum: left.sum + right.sum,
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
    }
}

/** Whether the accumulator holds no samples and must not be sent. */
export function isEmptyAttempts(accumulator: AttemptAccumulator | ExecutionSummary): boolean {
    return accumulator.count === 0
}
