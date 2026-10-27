/**
 * Attempt distribution of the logical requests behind a canonical Usage fact (WS-111).
 *
 * A logical request keeps one identity across recursive retries, and each retry
 * reports a higher `taskAttempt`. The sample is therefore `taskAttempt + 1`: how
 * many attempts that request needed in total. This is what makes a model's
 * "gets it right first time" rate measurable, which the request counters alone
 * cannot answer.
 */

import type { ProviderAttemptThinking } from "@shared/provider-attempt-observer"
import type { ApiRequestRoundHandle, ProviderAttemptRole } from "@/core/task/performance/api-request-round-tracker"
import type { ApiRequestRoundRecord } from "@/core/task/performance/api-request-round-types"
import type { ApiResponseExecutionRecord } from "@/core/task/performance/api-response-execution-types"
import type { UsageToolCall } from "@/core/task/telemetry/UsageToolCalls"
import { isUsageModelId, USAGE_MODEL_UNKNOWN } from "../contracts/modelIdentity"
import { isUsageThinking } from "../contracts/thinking"
import type { UsageFailureClass } from "../contracts/usageBodySchema"
import {
    EMPTY_EXECUTION_SUMMARY,
    type ExecutionSummary,
    foldToolsToBound,
    isRegisteredToolName,
    type ToolOutcomeCounts,
    type UsageTaskAttemptsWire,
    type UsageToolsWire,
} from "../contracts/usageExecution"

export interface UsageAttemptIdentity {
    readonly role: ProviderAttemptRole
    readonly provider: string
    readonly modelId: string
    readonly thinking: ProviderAttemptThinking
}

export interface UsageAttemptTokens {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly reasoning: number
}

export interface UsageLogicalExecutionObservation {
    readonly logicalRequests: {
        readonly completed: number
        readonly failed: number
        readonly cancelled: number
        readonly aborted: number
    }
    readonly turnDurationMs: ExecutionSummary
    readonly tools?: UsageToolsWire
    readonly taskAttempts: UsageTaskAttemptsWire
}

export interface UsageAttemptObservation {
    readonly attemptObservationId: string
    readonly logicalRequestId: string
    readonly identity: UsageAttemptIdentity
    readonly policyGeneration: number
    readonly admittedAt: number
    readonly outcome: ApiRequestRoundRecord["status"]
    readonly durationMs: number
    readonly tokens: UsageAttemptTokens
    readonly tokenUsageReported: boolean
    /** Present exactly when `outcome` is `failed` (usage-contract §5). */
    readonly failureClass?: UsageFailureClass
    readonly ttftMs?: number
    /** Generation timing and output exist only as a pair, and only with reported tokens. */
    readonly generationMs?: number
    readonly generationOutputTokens?: number
    /** Present when the logical request settled before this attempt's tokens were final. */
    readonly logicalExecution?: UsageLogicalExecutionObservation
}

/** Convert one revision of a terminal attempt into the schema 4 observation for that handle. */
export function projectFinalizedAttempt(
    handle: ApiRequestRoundHandle,
    record: ApiRequestRoundRecord,
    execution?: ApiResponseExecutionRecord,
    logicalToolCalls?: readonly UsageToolCall[],
): UsageAttemptObservation {
    if (handle.roundId !== record.roundId || handle.logicalRequestId !== record.logicalRequestId) {
        throw new Error("Attempt handle and revision identity do not match")
    }
    const identity = readIdentity(handle)
    const policyGeneration = requireCount(handle.policyGeneration, "policy generation")
    const admittedAt = requireCount(handle.startedAtMs, "admittedAt")
    // Every real send lasts at least 1 ms; timer resolution may report 0 (usage-contract §5).
    const durationMs = Math.max(1, requireCount(Math.round(record.providerDurationMs ?? 0), "duration"))
    const tokenUsageReported = record.usageQuality === "exact"
    const tokens: UsageAttemptTokens = tokenUsageReported
        ? {
              input: requireCount(record.inputTokens, "input tokens"),
              output: requireCount(record.outputTokens, "output tokens"),
              cacheRead: requireCount(record.cacheReadTokens ?? 0, "cache read tokens"),
              cacheWrite: requireCount(record.cacheWriteTokens ?? 0, "cache write tokens"),
              reasoning: requireCount(record.thoughtsTokens ?? 0, "reasoning tokens"),
          }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    if (tokens.reasoning > tokens.output) throw new Error("Attempt reasoning tokens exceed output tokens")
    return {
        attemptObservationId: handle.roundId,
        logicalRequestId: handle.logicalRequestId,
        identity,
        policyGeneration,
        admittedAt,
        outcome: record.status,
        durationMs,
        tokens,
        tokenUsageReported,
        ...(execution ? { logicalExecution: projectLogicalExecution(handle, execution, logicalToolCalls) } : {}),
    }
}

/** Project the settled execution of the logical request whose result-producing attempt is `handle`. */
export function projectLogicalExecution(
    handle: ApiRequestRoundHandle,
    execution: ApiResponseExecutionRecord,
    logicalToolCalls?: readonly UsageToolCall[],
): UsageLogicalExecutionObservation {
    if (execution.roundId !== handle.roundId || execution.logicalRequestId !== handle.logicalRequestId) {
        throw new Error("Logical execution does not match finalized attempt")
    }
    const duration = requireCount(Math.round(execution.executionDurationMs), "logical execution duration")
    const attempts = requireCount(handle.taskAttempt + 1, "logical task attempts")
    const logicalRequests = { completed: 0, failed: 0, cancelled: 0, aborted: 0 }
    logicalRequests[execution.status] = 1
    const tools = projectLogicalTools(execution, logicalToolCalls)
    return {
        logicalRequests,
        turnDurationMs: { count: 1, sum: duration, min: duration, max: duration },
        ...(tools ? { tools } : {}),
        taskAttempts: { count: 1, sum: attempts, min: attempts, max: attempts },
    }
}

function projectLogicalTools(
    execution: ApiResponseExecutionRecord,
    logicalToolCalls?: readonly UsageToolCall[],
): UsageToolsWire | undefined {
    const toolCount = requireCount(execution.toolCount, "logical tool count")
    const totals: ToolOutcomeCounts = {
        completed: requireCount(execution.completedToolCount, "completed logical tools"),
        failed: requireCount(execution.failedToolCount, "failed logical tools"),
        cancelled: requireCount(execution.cancelledToolCount, "cancelled logical tools"),
    }
    if (totals.completed + totals.failed + totals.cancelled !== toolCount) {
        throw new Error("Logical tool outcomes do not conserve")
    }
    if (toolCount === 0) {
        if (logicalToolCalls && logicalToolCalls.length > 0)
            throw new Error("Provider-only logical execution cannot carry tool calls")
        return undefined
    }
    if (!logicalToolCalls) return { ...totals, by_name: {}, unlisted: totals }
    if (logicalToolCalls.length !== toolCount) throw new Error("Logical tool call count does not match execution")

    const byName = new Map<string, MutableToolOutcomeCounts>()
    const unlisted: MutableToolOutcomeCounts = { completed: 0, failed: 0, cancelled: 0 }
    const observed: MutableToolOutcomeCounts = { completed: 0, failed: 0, cancelled: 0 }
    for (const call of logicalToolCalls) {
        observed[call.outcome] = incrementCount(observed[call.outcome], "logical tool outcome")
        if (!call.toolName || !isRegisteredToolName(call.toolName)) {
            unlisted[call.outcome] = incrementCount(unlisted[call.outcome], "logical unlisted tool")
            continue
        }
        const counts = byName.get(call.toolName) ?? { completed: 0, failed: 0, cancelled: 0 }
        counts[call.outcome] = incrementCount(counts[call.outcome], `logical tool ${call.toolName}`)
        byName.set(call.toolName, counts)
    }
    if (observed.completed !== totals.completed || observed.failed !== totals.failed || observed.cancelled !== totals.cancelled) {
        throw new Error("Logical named tool outcomes do not match execution totals")
    }
    const orderedByName = Object.fromEntries([...byName.entries()].sort(([left], [right]) => left.localeCompare(right)))
    const unlistedTotal = unlisted.completed + unlisted.failed + unlisted.cancelled
    return foldToolsToBound({
        ...totals,
        by_name: orderedByName,
        ...(unlistedTotal > 0 ? { unlisted } : {}),
    })
}

type MutableToolOutcomeCounts = { -readonly [K in keyof ToolOutcomeCounts]: ToolOutcomeCounts[K] }

function incrementCount(value: number, label: string): number {
    const next = value + 1
    if (!Number.isSafeInteger(next)) throw new Error(`Attempt ${label} overflow`)
    return next
}

function readIdentity(handle: ApiRequestRoundHandle): UsageAttemptIdentity {
    const { role, provider, modelId, thinking } = handle
    if (!role || !provider || !modelId || thinking === undefined)
        throw new Error("Complete schema 4 attempt identity is required")
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(provider)) throw new Error("Attempt provider identity is invalid")
    if (!isUsageThinking(thinking)) throw new Error("Attempt thinking identity is invalid")
    // The admission boundary already projected the model; anything else never leaves as a raw value.
    return { role, provider, modelId: isUsageModelId(modelId) ? modelId : USAGE_MODEL_UNKNOWN, thinking }
}

function requireCount(value: number | undefined, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw new Error(`Attempt ${label} must be a non-negative safe integer`)
    return value as number
}

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
