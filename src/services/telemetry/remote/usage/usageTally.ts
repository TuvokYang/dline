import {
    USAGE_ERROR_CLASSES,
    type UsageErrorClass,
    type UsageServedModel,
    type UsageSettlement,
} from "@/core/task/telemetry/UsageSettlement"
import { countToolCallOutcomes, namesTool, USAGE_TOOL_CALL_OUTCOMES } from "@/core/task/telemetry/UsageToolCalls"
import {
    USAGE_HISTOGRAM_BOUNDS_MS,
    USAGE_HISTOGRAM_BUCKETS,
    type UsageDistributionWire,
    type UsageRequestOutcomeWire,
    type UsageSummaryWire,
    type UsageTokensWire,
    type UsageTurnOutcomeWire,
} from "../contracts/usageBody"
import {
    type ExecutionSummary,
    foldToolsToBound,
    isEmptyTaskAttempts,
    isEmptyTodos,
    isEmptyTools,
    MAX_TOOL_NAMES_PER_FACT,
    type RoundsDistribution,
    type ToolOutcomeCounts,
    type UsageTaskAttemptsWire,
    type UsageTodosWire,
    type UsageToolsWire,
    validateTaskAttempts,
    validateTodos,
    validateTools,
} from "../contracts/usageExecution"
import {
    normalizeRole,
    resolveUsageIdentity,
    UNKNOWN_USAGE_ID,
    type UsageFactIdentity,
    type UsageRole,
    usageFactKey,
} from "../contracts/usageIdentity"
import { applyTodoObservation, createMemoryTodoLedger, createTodoCounters, sealTodos } from "./todoProjection"

/**
 * Usage of one fact, one second, or any set of them, in the sections of the
 * body. Tallies add up exactly, so a second is the sum of its requests and a
 * batch the sum of its seconds.
 *
 * A fact carries its own counters and nothing is kept per model or per provider
 * beside them: those marginals could not be deleted independently, so they would
 * go wrong the moment one model had to be dropped.
 */
export interface UsageFactTally extends UsageFactIdentity {
    readonly requests: UsageRequestOutcomeWire
    readonly tokens: UsageTokensWire
    readonly duration_ms: UsageDistributionWire
    readonly turns?: UsageTurnOutcomeWire
    readonly turn_duration_ms?: UsageSummaryWire
    readonly tools?: UsageToolsWire
    readonly ttft_ms?: UsageDistributionWire
    readonly generation_ms?: UsageDistributionWire
    readonly errors: Readonly<Partial<Record<UsageErrorClass, number>>>
    readonly retries: number
    readonly retry_wait_ms?: UsageSummaryWire
    readonly todos?: UsageTodosWire
    readonly task_attempts?: UsageTaskAttemptsWire
}

export interface UsageTally {
    readonly sessions_started: number
    readonly facts: readonly UsageFactTally[]
}

export const EMPTY_USAGE_TALLY: UsageTally = { sessions_started: 0, facts: [] }

const MAX_PROVIDER_LENGTH = 32
const MAX_MODEL_LENGTH = 64

/** A provider and model reduced to the contract's vocabulary. */
export interface UsageModelKey {
    readonly provider: string
    readonly model: string
    readonly custom?: boolean
}

/**
 * The provider and model name diagnostics report.
 *
 * This is the diagnostics vocabulary, not the usage fact identity: a diagnostic
 * record must name the failing model in a single normalized attribute, while a
 * usage fact must never merge two models. They deliberately use different rules,
 * and `usageModelKey` therefore keeps substituting characters while
 * `resolveUsageIdentity` refuses to.
 */
export function usageModelKey(servedBy: UsageServedModel): UsageModelKey {
    const provider = usageProviderId(servedBy.provider)
    return { provider, model: usageModelId(servedBy.model), ...(servedBy.custom ? { custom: true } : {}) }
}

export function usageProviderId(provider: string): string {
    return normalizeId(provider, /[^a-z0-9_-]+/g, MAX_PROVIDER_LENGTH)
}

export function usageModelId(model: string): string {
    return normalizeId(model, /[^a-z0-9_.-]+/g, MAX_MODEL_LENGTH)
}

function normalizeId(value: string, disallowed: RegExp, maxLength: number): string {
    const id = value.trim().toLowerCase().replace(disallowed, "_").slice(0, maxLength)
    return id.length > 0 ? id : UNKNOWN_USAGE_ID
}

/** Whether a tally holds anything worth a batch: a request or an activation. */
export function hasUsageActivity(tally: UsageTally): boolean {
    return tally.sessions_started > 0 || tally.facts.length > 0
}

/** The tally one extension activation contributes. */
export function sessionStartedTally(): UsageTally {
    return { ...EMPTY_USAGE_TALLY, sessions_started: 1 }
}

/** Project one settled request into the fact it belongs to. */
export function projectUsageSettlement(settlement: UsageSettlement): UsageTally {
    const identity = factIdentityOf(settlement)
    const duration = milliseconds(settlement.durationMs)
    const tokens: UsageTokensWire = {
        input: count(settlement.inputTokens),
        output: count(settlement.outputTokens),
        cache_read: count(settlement.cacheReadTokens),
        cache_write: count(settlement.cacheWriteTokens),
        ...reasoningTokens(settlement, count(settlement.outputTokens)),
    }
    const fact: UsageFactTally = {
        ...identity,
        requests: {
            completed: settlement.outcome === "completed" ? 1 : 0,
            cancelled: settlement.outcome === "cancelled" ? 1 : 0,
            failed: settlement.outcome === "failed" ? 1 : 0,
        },
        tokens,
        duration_ms: histogramOf([duration]),
        ...(settlement.streamTiming
            ? {
                  ttft_ms: histogramOf([milliseconds(settlement.streamTiming.ttftMs)]),
                  generation_ms: histogramOf([milliseconds(settlement.streamTiming.generationMs)]),
              }
            : {}),
        errors: failureOf(settlement),
        retries: settlement.retries?.waitsMs.length ?? 0,
        ...retryWaits(settlement),
        ...toolsOf(settlement),
        ...todosOf(settlement),
        ...attemptsOf(settlement),
    }
    return { sessions_started: 0, facts: [fact] }
}

/**
 * The checklist work one settlement reported, folded into the fact's counters.
 *
 * A report is only counted where it describes this fact: an item declared or
 * completed while the task ran on this model belongs here, and its rounds are
 * measured on the request ordinal the same fact already counts.
 */
function todosOf(settlement: UsageSettlement): Pick<UsageFactTally, "todos"> {
    const changes = settlement.checklistChanges ?? []
    if (changes.length === 0) return {}
    const counters = createTodoCounters()
    const ledger = createMemoryTodoLedger()
    const round = 1
    for (const change of changes) {
        applyTodoObservation(counters, ledger, {
            itemId: change.itemId,
            transition: change.transition,
            round,
            at: settlement.durationMs,
        })
    }
    const todos = sealTodos(counters)
    return todos === undefined ? {} : { todos }
}

/**
 * The tool calls one settlement reported, grouped by name under the outcome
 * totals they already account for.
 *
 * The totals are computed from the same calls, so every settlement lands in
 * exactly one of `by_name` or `unlisted`: a call with no resolvable identity
 * still counts toward the total it settled under.
 */
function toolsOf(settlement: UsageSettlement): Pick<UsageFactTally, "tools"> {
    const calls = settlement.toolCalls ?? []
    if (calls.length === 0) return {}
    const totals = countToolCallOutcomes(calls)
    const byName: Record<string, ToolOutcomeCounts> = {}
    for (const call of calls) {
        if (!namesTool(call)) continue
        const name = call.toolName as string
        const current = byName[name] ?? { completed: 0, failed: 0, cancelled: 0 }
        byName[name] = { ...current, [call.outcome]: current[call.outcome] + 1 }
    }
    const unlisted: Record<keyof ToolOutcomeCounts, number> = { completed: 0, failed: 0, cancelled: 0 }
    for (const outcome of USAGE_TOOL_CALL_OUTCOMES) {
        unlisted[outcome] = totals[outcome] - sumNamed(byName, outcome)
    }
    const tools = foldToolsToBound({
        completed: totals.completed,
        failed: totals.failed,
        cancelled: totals.cancelled,
        by_name: byName,
        unlisted,
    })
    return isEmptyTools(tools) ? {} : { tools }
}

/**
 * How many attempts this logical request needed.
 *
 * The retry ledger already records every backoff the request waited through, and
 * a request that waited through N backoffs was sent N + 1 times. Counting the
 * ledger keeps one source of truth: a separate attempt counter could disagree
 * with the retry count beside it in the same fact.
 */
function attemptsOf(settlement: UsageSettlement): Pick<UsageFactTally, "task_attempts"> {
    const retries = settlement.retries?.waitsMs.length ?? 0
    const attempts = retries + 1
    return { task_attempts: { count: 1, sum: attempts, min: attempts, max: attempts } }
}

function sumNamed(byName: Readonly<Record<string, ToolOutcomeCounts>>, outcome: keyof ToolOutcomeCounts): number {
    let sum = 0
    for (const counts of Object.values(byName)) sum += counts[outcome]
    return sum
}

function reasoningTokens(settlement: UsageSettlement, output: number): Pick<UsageTokensWire, "reasoning"> {
    if (settlement.reasoningTokens === undefined) return {}
    // Reasoning is a subset of output, so it never exceeds the output it explains.
    return { reasoning: Math.min(count(settlement.reasoningTokens), output) }
}

function failureOf(settlement: UsageSettlement): Readonly<Partial<Record<UsageErrorClass, number>>> {
    if (settlement.outcome !== "failed") return {}
    const errorClass: UsageErrorClass =
        settlement.failureClass && (USAGE_ERROR_CLASSES as readonly string[]).includes(settlement.failureClass)
            ? settlement.failureClass
            : "other"
    return { [errorClass]: 1 }
}

function retryWaits(settlement: UsageSettlement): Pick<UsageFactTally, "retry_wait_ms"> {
    const waits = (settlement.retries?.waitsMs ?? []).map(milliseconds)
    return waits.length === 0 ? {} : { retry_wait_ms: summaryOf(waits) }
}

/**
 * The fact identity of a settlement.
 *
 * A purpose outside the role catalog is reported as `other`, matching how an
 * unknown generation kind has always been reported. An unusable provider or
 * model becomes `_unknown` inside the identity resolver, so the request keeps
 * its totals instead of disappearing from every sum.
 */
function factIdentityOf(settlement: UsageSettlement): UsageFactIdentity {
    const servedBy = settlement.servedBy
    const resolved = resolveUsageIdentity({
        role: settlement.purpose,
        provider: servedBy?.provider ?? "",
        model: servedBy?.model ?? "",
        custom: servedBy?.custom === true,
    })
    if (resolved.ok) return resolved.identity
    // The purpose was not a registered role; keep the counters under `other`.
    const fallback = resolveUsageIdentity({
        role: "other",
        provider: servedBy?.provider ?? "",
        model: servedBy?.model ?? "",
        custom: servedBy?.custom === true,
    })
    return fallback.ok
        ? fallback.identity
        : { role: "other" as UsageRole, provider: UNKNOWN_USAGE_ID, model: UNKNOWN_USAGE_ID, custom: false }
}

/** Add two tallies; every counter saturates at the largest safe integer instead of losing precision. */
export function mergeUsageTallies(left: UsageTally, right: UsageTally): UsageTally {
    return {
        sessions_started: add(left.sessions_started, right.sessions_started),
        facts: mergeFacts(left.facts, right.facts),
    }
}

/** Merge fact lists by identity; the same fact in both is added up. */
export function mergeFacts(left: readonly UsageFactTally[], right: readonly UsageFactTally[]): UsageFactTally[] {
    const merged = new Map(left.map((fact) => [usageFactKey(fact), fact]))
    for (const fact of right) {
        const key = usageFactKey(fact)
        const existing = merged.get(key)
        merged.set(key, existing ? mergeFact(existing, fact) : fact)
    }
    return [...merged.values()]
}

/** Merge two tallies of the same fact; both must already share one identity. */
export function mergeFact(left: UsageFactTally, right: UsageFactTally): UsageFactTally {
    const reasoning = mergeOptional(left.tokens.reasoning, right.tokens.reasoning, add)
    const { reasoning: _leftReasoning, ...leftTokens } = left.tokens
    const { reasoning: _rightReasoning, ...rightTokens } = right.tokens
    const duration = mergeDistribution(left.duration_ms, right.duration_ms)
    const ttft = mergeOptionalDistribution(left.ttft_ms, right.ttft_ms)
    const generation = mergeOptionalDistribution(left.generation_ms, right.generation_ms)
    const turnDuration = mergeOptional(left.turn_duration_ms, right.turn_duration_ms, mergeSummary)
    const retryWait = mergeOptional(left.retry_wait_ms, right.retry_wait_ms, mergeSummary)
    const turns = mergeOptional(left.turns, right.turns, mergeTurnOutcomes)
    const tools = mergeOptional(left.tools, right.tools, mergeTools)
    const todos = mergeOptional(left.todos, right.todos, mergeTodos)
    const taskAttempts = mergeOptional(left.task_attempts, right.task_attempts, mergeAttemptSamples)
    return foldFactTools({
        role: left.role,
        provider: left.provider,
        model: left.model,
        custom: left.custom,
        requests: addRequestOutcomes(left.requests, right.requests),
        tokens: { ...addCounts(leftTokens, rightTokens), ...(reasoning === undefined ? {} : { reasoning }) },
        duration_ms: duration,
        errors: addCounts(left.errors, right.errors),
        retries: add(left.retries, right.retries),
        ...(turns ? { turns } : {}),
        ...(turnDuration ? { turn_duration_ms: turnDuration } : {}),
        ...(tools ? { tools } : {}),
        ...(ttft ? { ttft_ms: ttft } : {}),
        ...(generation ? { generation_ms: generation } : {}),
        ...(retryWait ? { retry_wait_ms: retryWait } : {}),
        ...(todos ? { todos } : {}),
        ...(taskAttempts ? { task_attempts: taskAttempts } : {}),
    })
}

function addRequestOutcomes(left: UsageRequestOutcomeWire, right: UsageRequestOutcomeWire): UsageRequestOutcomeWire {
    return {
        completed: add(left.completed, right.completed),
        cancelled: add(left.cancelled, right.cancelled),
        failed: add(left.failed, right.failed),
    }
}

function mergeTurnOutcomes(left: UsageTurnOutcomeWire, right: UsageTurnOutcomeWire): UsageTurnOutcomeWire {
    return {
        completed: add(left.completed, right.completed),
        cancelled: add(left.cancelled, right.cancelled),
        failed: add(left.failed, right.failed),
        aborted: add(left.aborted, right.aborted),
    }
}

/**
 * Merge tool counters, keeping the per-name limit the reader enforces.
 *
 * A name that stops fitting is folded into `unlisted` rather than dropped, so
 * `by_name + unlisted` still equals the totals of the merged fact.
 */
function mergeTools(left: UsageToolsWire, right: UsageToolsWire): UsageToolsWire {
    const grouped = new Map<string, ToolOutcomeCounts>(Object.entries(left.by_name ?? {}))
    for (const [name, counts] of Object.entries(right.by_name ?? {})) {
        const existing = grouped.get(name)
        grouped.set(name, existing ? addToolOutcomes(existing, counts) : counts)
    }
    return foldToolsToBound({
        completed: add(left.completed, right.completed),
        failed: add(left.failed, right.failed),
        cancelled: add(left.cancelled, right.cancelled),
        by_name: Object.fromEntries(grouped),
        unlisted: addToolOutcomes(left.unlisted ?? EMPTY_TOOL_OUTCOMES, right.unlisted ?? EMPTY_TOOL_OUTCOMES),
    })
}

/** Fold an over-bound tools object produced before it reached a merge. */
export function foldFactTools(fact: UsageFactTally): UsageFactTally {
    if (fact.tools === undefined || Object.keys(fact.tools.by_name ?? {}).length <= MAX_TOOL_NAMES_PER_FACT) return fact
    return { ...fact, tools: foldToolsToBound(fact.tools) }
}

const EMPTY_TOOL_OUTCOMES: ToolOutcomeCounts = { completed: 0, failed: 0, cancelled: 0 }

function addToolOutcomes(left: ToolOutcomeCounts, right: ToolOutcomeCounts): ToolOutcomeCounts {
    return {
        completed: add(left.completed, right.completed),
        failed: add(left.failed, right.failed),
        cancelled: add(left.cancelled, right.cancelled),
    }
}

/**
 * Merge TODO counters.
 *
 * `declared` is the size of the union of declared items, not the sum: the same
 * item declared in two seconds is one declaration. Counting it twice would
 * inflate the denominator of every completion rate.
 */
function mergeTodos(left: UsageTodosWire, right: UsageTodosWire): UsageTodosWire {
    const declared = Math.max(left.declared, right.declared)
    const completed = add(left.completed, right.completed)
    const reopened = add(left.reopened, right.reopened)
    const abandoned = add(left.abandoned, right.abandoned)
    const rounds = mergeOptional(left.rounds_to_complete, right.rounds_to_complete, mergeRounds)
    const active = mergeOptional(left.active_ms_to_complete, right.active_ms_to_complete, mergeSummary)
    return {
        declared,
        completed,
        reopened,
        abandoned,
        ...(rounds ? { rounds_to_complete: rounds } : {}),
        ...(active ? { active_ms_to_complete: active } : {}),
    }
}

function mergeRounds(left: RoundsDistribution, right: RoundsDistribution): RoundsDistribution {
    return {
        ...mergeSummary(left, right),
        buckets: left.buckets.map((bucket, index) => add(bucket, right.buckets[index] ?? 0)),
    }
}

function mergeAttemptSamples(left: ExecutionSummary, right: ExecutionSummary): ExecutionSummary {
    return mergeSummary(left, right)
}

function mergeSummary(left: UsageSummaryWire, right: UsageSummaryWire): UsageSummaryWire {
    return {
        count: add(left.count, right.count),
        sum: add(left.sum, right.sum),
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
    }
}

function mergeDistribution(left: UsageDistributionWire, right: UsageDistributionWire): UsageDistributionWire {
    return {
        ...mergeSummary(left, right),
        buckets: left.buckets.map((bucket, index) => add(bucket, right.buckets[index] ?? 0)),
    }
}

function mergeOptionalDistribution(
    left: UsageDistributionWire | undefined,
    right: UsageDistributionWire | undefined,
): UsageDistributionWire | undefined {
    if (left === undefined) return right
    if (right === undefined) return left
    return mergeDistribution(left, right)
}

function mergeOptional<T>(left: T | undefined, right: T | undefined, merge: (a: T, b: T) => T): T | undefined {
    if (left === undefined) return right
    if (right === undefined) return left
    return merge(left, right)
}

function addCounts<T extends Readonly<Partial<Record<string, number>>>>(left: T, right: T): T {
    const sum: Record<string, number> = { ...left } as Record<string, number>
    for (const [key, value] of Object.entries(right)) {
        if (value !== undefined) sum[key] = add(sum[key] ?? 0, value)
    }
    return sum as T
}

function add(left: number, right: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function count(value: number): number {
    const rounded = Math.round(value)
    return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : 0
}

function milliseconds(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function summaryOf(values: readonly number[]): UsageSummaryWire {
    const sum = values.reduce((total, value) => total + value, 0)
    return { count: values.length, sum, min: Math.min(...values), max: Math.max(...values) }
}

/** One sample in the first bucket whose upper bound holds it; the last bucket holds what exceeds every bound. */
function histogramOf(values: readonly number[]): UsageDistributionWire {
    const buckets = new Array<number>(USAGE_HISTOGRAM_BUCKETS).fill(0)
    for (const value of values) {
        const index = USAGE_HISTOGRAM_BOUNDS_MS.findIndex((bound) => value <= bound)
        buckets[index === -1 ? USAGE_HISTOGRAM_BOUNDS_MS.length : index] += 1
    }
    return { ...summaryOf(values), buckets }
}

/** One persisted fact, read back for the outbox. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseFact(value: unknown): UsageFactTally | undefined {
    if (!isRecord(value)) return undefined
    const role = typeof value.role === "string" ? normalizeRole(value.role) : undefined
    if (role === undefined) return undefined
    if (typeof value.provider !== "string" || typeof value.model !== "string") return undefined
    if (!isRequestOutcomes(value.requests) || !isTokens(value.tokens) || !isDistribution(value.duration_ms)) return undefined
    if (!isRecord(value.errors) || !isCountValue(value.retries)) return undefined

    const turns = readOptional(value.turns, isTurnOutcomes)
    const turnDuration = readOptional(value.turn_duration_ms, isSummary)
    const tools = readOptional(value.tools, isUsableTools)
    const ttft = readOptional(value.ttft_ms, isDistribution)
    const generation = readOptional(value.generation_ms, isDistribution)
    const retryWait = readOptional(value.retry_wait_ms, isSummary)
    const todos = readOptional(value.todos, isUsableTodos)
    const attempts = readOptional(value.task_attempts, isUsableTaskAttempts)
    if (
        turns === undefined ||
        turnDuration === undefined ||
        tools === undefined ||
        ttft === undefined ||
        generation === undefined ||
        retryWait === undefined ||
        todos === undefined ||
        attempts === undefined
    ) {
        return undefined
    }

    return {
        role,
        provider: value.provider,
        model: value.model,
        custom: value.custom === true,
        requests: value.requests,
        tokens: value.tokens,
        duration_ms: value.duration_ms,
        errors: value.errors as Readonly<Partial<Record<UsageErrorClass, number>>>,
        retries: value.retries,
        ...(turns === null ? {} : { turns }),
        ...(turnDuration === null ? {} : { turn_duration_ms: turnDuration }),
        ...(tools === null ? {} : { tools }),
        ...(ttft === null ? {} : { ttft_ms: ttft }),
        ...(generation === null ? {} : { generation_ms: generation }),
        ...(retryWait === null ? {} : { retry_wait_ms: retryWait }),
        ...(todos === null ? {} : { todos }),
        ...(attempts === null ? {} : { task_attempts: attempts }),
    }
}

/**
 * Read an optional section: `null` for absent, `undefined` for damaged.
 *
 * The two outcomes must stay distinguishable, because an absent section is a
 * role that does not report it while a damaged one makes the record unreadable.
 */
function readOptional<T>(value: unknown, accept: (entry: unknown) => entry is T): T | null | undefined {
    if (value === undefined) return null
    return accept(value) ? value : undefined
}

function isCountValue(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isSummary(value: unknown): value is UsageSummaryWire {
    if (!isRecord(value)) return false
    const { count, sum, min, max } = value
    if (!isCountValue(count)) return false
    if (!isFiniteNumber(sum) || !isFiniteNumber(min) || !isFiniteNumber(max)) return false
    if (count === 0) return sum === 0 && min === 0 && max === 0
    return min <= max && min * count <= sum && sum <= max * count
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isRequestOutcomes(value: unknown): value is UsageRequestOutcomeWire {
    if (!isRecord(value)) return false
    return ["completed", "cancelled", "failed"].every((key) => isCountValue(value[key]))
}

function isTurnOutcomes(value: unknown): value is UsageTurnOutcomeWire {
    if (!isRecord(value)) return false
    return ["completed", "cancelled", "failed", "aborted"].every((key) => isCountValue(value[key]))
}

function isTokens(value: unknown): value is UsageTokensWire {
    if (!isRecord(value)) return false
    if (!["input", "output", "cache_read", "cache_write"].every((key) => isCountValue(value[key]))) return false
    return value.reasoning === undefined || isCountValue(value.reasoning)
}

function isDistribution(value: unknown): value is UsageDistributionWire {
    if (!isRecord(value)) return false
    if (!isCountValue(value.count) || !isSummaryNumbers(value)) return false
    const buckets = value.buckets
    return Array.isArray(buckets) && buckets.length === USAGE_HISTOGRAM_BUCKETS && buckets.every(isCountValue)
}

function isSummaryNumbers(value: Record<string, unknown>): boolean {
    return ["sum", "min", "max"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
}

function isUsableTools(value: unknown): value is UsageToolsWire {
    return isRecord(value) && validateTools(value as unknown as UsageToolsWire).length === 0
}

function isUsableTodos(value: unknown): value is UsageTodosWire {
    return isRecord(value) && validateTodos(value as unknown as UsageTodosWire).length === 0
}

function isUsableTaskAttempts(value: unknown): value is UsageTaskAttemptsWire {
    return isRecord(value) && validateTaskAttempts(value as unknown as UsageTaskAttemptsWire).length === 0
}

/**
 * Read a persisted tally. Any fact the contract would refuse makes the whole
 * tally unreadable, so a damaged record is skipped instead of poisoning the
 * batch it would join.
 */
export function parseUsageTally(value: unknown): UsageTally | undefined {
    if (!isRecord(value)) return undefined
    const sessions = value.sessions_started
    if (!isCountValue(sessions)) return undefined
    if (!Array.isArray(value.facts)) return undefined
    const facts: UsageFactTally[] = []
    for (const entry of value.facts) {
        const fact = parseFact(entry)
        if (!fact) return undefined
        facts.push(fact)
    }
    return { sessions_started: sessions, facts }
}

/** Whether a fact holds nothing worth sending. */
export function isEmptyFactTally(fact: UsageFactTally): boolean {
    const requests = fact.requests
    const tokens = fact.tokens
    return (
        requests.completed + requests.cancelled + requests.failed === 0 &&
        tokens.input + tokens.output + tokens.cache_read + tokens.cache_write === 0 &&
        fact.retries === 0 &&
        (fact.tools === undefined || isEmptyTools(fact.tools)) &&
        (fact.todos === undefined || isEmptyTodos(fact.todos)) &&
        (fact.task_attempts === undefined || isEmptyTaskAttempts(fact.task_attempts))
    )
}
