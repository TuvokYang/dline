import { USAGE_HISTOGRAM_BOUNDS_MS } from "../contracts/usageBody"
import {
    type ExecutionSummary,
    foldToolsToBound,
    type ToolOutcomeCounts,
    type UsageToolsWire,
    validateTaskAttempts,
    validateTools,
} from "../contracts/usageExecution"
import type {
    UsageAttemptIdentity,
    UsageAttemptObservation,
    UsageAttemptTokens,
    UsageLogicalExecutionObservation,
} from "./attemptProjection"

export const ATTEMPT_BUCKET_DURATION_THRESHOLD_MS = 60_000
export const ATTEMPT_BUCKET_MAX_FACTS = 32
export const ATTEMPT_EVENT_WINDOW_MS = 600_000
/** A low-frequency bucket is durably sealed even when no later attempt arrives. */
export const ATTEMPT_BUCKET_MAX_OPEN_AGE_MS = ATTEMPT_EVENT_WINDOW_MS

export interface AttemptOutcomeCounts {
    readonly completed: number
    readonly failed: number
    readonly cancelled: number
    readonly aborted: number
}

export interface AttemptCoverage {
    readonly reported: number
    readonly unreported: number
}

export interface AttemptDistribution {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
    readonly buckets: readonly number[]
}

export interface AttemptFactAggregate {
    readonly identity: UsageAttemptIdentity
    readonly requests: AttemptOutcomeCounts
    readonly tokens: UsageAttemptTokens
    readonly tokenCoverage: AttemptCoverage
    readonly generationOutputTokens: number
    readonly duration: AttemptDistribution
    readonly errors: Readonly<Record<string, number>>
    readonly logicalExecution?: UsageLogicalExecutionObservation
}

export interface AttemptBucket {
    readonly bucketId: string
    readonly policyGeneration: number
    readonly windowStartedAt: number
    readonly windowEndedAt: number
    readonly firstAttemptAt: number
    readonly lastAttemptAt: number
    readonly sealedAt?: number
    readonly durationMs: number
    readonly sessionsStarted: number
    readonly facts: readonly AttemptFactAggregate[]
}

export interface AttemptBucketState {
    readonly open?: AttemptBucket
    readonly sealed: readonly AttemptBucket[]
}

export interface AppendAttemptOptions {
    readonly newBucketId: () => string
    readonly sealedAt: () => number
    readonly durationThresholdMs?: number
    readonly maxFacts?: number
    readonly eventWindowMs?: number
}

export function emptyAttemptBucketState(): AttemptBucketState {
    return { sealed: [] }
}

export interface AppendedAttemptBucketState {
    readonly state: AttemptBucketState
    readonly bucketId: string
}

/** Add one complete attempt atomically, sealing before capacity and after duration-threshold overshoot. */
export function appendAttemptToBuckets(
    state: AttemptBucketState,
    observation: UsageAttemptObservation,
    options: AppendAttemptOptions,
): AttemptBucketState {
    return appendAttemptToBucketsWithTarget(state, observation, options).state
}

/** The detailed reducer result lets the durable checkpoint follow the bucket that now owns this attempt. */
export function appendAttemptToBucketsWithTarget(
    state: AttemptBucketState,
    observation: UsageAttemptObservation,
    options: AppendAttemptOptions,
): AppendedAttemptBucketState {
    validateUsageAttemptObservation(observation)
    const threshold = options.durationThresholdMs ?? ATTEMPT_BUCKET_DURATION_THRESHOLD_MS
    const maxFacts = options.maxFacts ?? ATTEMPT_BUCKET_MAX_FACTS
    const eventWindowMs = options.eventWindowMs ?? ATTEMPT_EVENT_WINDOW_MS
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("Attempt bucket duration threshold is invalid")
    if (!Number.isSafeInteger(maxFacts) || maxFacts < 1) throw new Error("Attempt bucket fact limit is invalid")
    if (!Number.isSafeInteger(eventWindowMs) || eventWindowMs < 1) throw new Error("Attempt event window is invalid")

    const sealed = [...state.sealed]
    let open = state.open
    const observationWindowStart = Math.floor(observation.admittedAt / eventWindowMs) * eventWindowMs
    if (open && (open.policyGeneration !== observation.policyGeneration || open.windowStartedAt !== observationWindowStart)) {
        sealed.push(seal(open, options.sealedAt()))
        open = undefined
    }

    const key = identityKey(observation.identity)
    const hasIdentity = open?.facts.some((fact) => identityKey(fact.identity) === key) === true
    if (open && !hasIdentity && open.facts.length >= maxFacts) {
        sealed.push(seal(open, options.sealedAt()))
        open = undefined
    }

    const current = open ?? createBucket(options.newBucketId(), observation, eventWindowMs)
    const appended = appendToBucket(current, observation)
    if (appended.durationMs >= threshold) {
        sealed.push(seal(appended, options.sealedAt()))
        return { state: { sealed }, bucketId: appended.bucketId }
    }
    return { state: { sealed, open: appended }, bucketId: appended.bucketId }
}

/** Seal a low-frequency bucket once either its fixed event window or maximum open age has ended. */
export function sealOpenAttemptBucketIfDue(
    state: AttemptBucketState,
    sealedAt: number,
    maxOpenAgeMs = ATTEMPT_BUCKET_MAX_OPEN_AGE_MS,
): AttemptBucketState {
    const open = state.open
    if (!open) return state
    if (!Number.isSafeInteger(maxOpenAgeMs) || maxOpenAgeMs < 1) throw new Error("Attempt bucket open age is invalid")
    const dueAt = Math.min(open.windowEndedAt, open.firstAttemptAt + maxOpenAgeMs)
    return sealedAt < dueAt ? state : sealOpenAttemptBucket(state, sealedAt)
}

/** Seal the current open bucket for a durable capacity, shutdown or maintenance boundary. */
export function sealOpenAttemptBucket(state: AttemptBucketState, sealedAt: number): AttemptBucketState {
    const open = state.open
    if (!open) return state
    return { sealed: [...state.sealed, seal(open, sealedAt)] }
}

function createBucket(bucketId: string, observation: UsageAttemptObservation, eventWindowMs: number): AttemptBucket {
    if (!bucketId) throw new Error("Attempt bucket ID is required")
    const windowStartedAt = Math.floor(observation.admittedAt / eventWindowMs) * eventWindowMs
    return {
        bucketId,
        policyGeneration: observation.policyGeneration,
        windowStartedAt,
        windowEndedAt: windowStartedAt + eventWindowMs,
        firstAttemptAt: observation.admittedAt,
        lastAttemptAt: observation.admittedAt,
        durationMs: 0,
        sessionsStarted: 0,
        facts: [],
    }
}

function appendToBucket(bucket: AttemptBucket, observation: UsageAttemptObservation): AttemptBucket {
    const key = identityKey(observation.identity)
    const index = bucket.facts.findIndex((fact) => identityKey(fact.identity) === key)
    const facts = [...bucket.facts]
    if (index < 0) facts.push(createFact(observation))
    else facts[index] = appendToFact(facts[index], observation)
    return {
        ...bucket,
        firstAttemptAt: Math.min(bucket.firstAttemptAt, observation.admittedAt),
        lastAttemptAt: Math.max(bucket.lastAttemptAt, observation.admittedAt),
        durationMs: checkedAdd(bucket.durationMs, observation.durationMs, "bucket duration"),
        sessionsStarted: checkedAdd(bucket.sessionsStarted, observation.sessionsStarted ?? 0, "sessions started"),
        facts,
    }
}

function createFact(observation: UsageAttemptObservation): AttemptFactAggregate {
    return {
        identity: observation.identity,
        requests: incrementOutcome(emptyOutcomes(), observation.outcome),
        tokens: observation.tokenUsageReported ? observation.tokens : emptyTokens(),
        tokenCoverage: observation.tokenUsageReported ? { reported: 1, unreported: 0 } : { reported: 0, unreported: 1 },
        generationOutputTokens: observation.generationOutputTokens ?? 0,
        duration: observeDistribution(undefined, observation.durationMs),
        errors: {},
        ...(observation.logicalExecution ? { logicalExecution: observation.logicalExecution } : {}),
    }
}

function appendToFact(fact: AttemptFactAggregate, observation: UsageAttemptObservation): AttemptFactAggregate {
    return {
        ...fact,
        requests: incrementOutcome(fact.requests, observation.outcome),
        tokens: observation.tokenUsageReported ? addTokens(fact.tokens, observation.tokens) : fact.tokens,
        tokenCoverage: {
            reported: fact.tokenCoverage.reported + (observation.tokenUsageReported ? 1 : 0),
            unreported: fact.tokenCoverage.unreported + (observation.tokenUsageReported ? 0 : 1),
        },
        generationOutputTokens: checkedAdd(
            fact.generationOutputTokens,
            observation.generationOutputTokens ?? 0,
            "generation output tokens",
        ),
        duration: observeDistribution(fact.duration, observation.durationMs),
        logicalExecution: mergeLogicalExecution(fact.logicalExecution, observation.logicalExecution),
    }
}

function mergeLogicalExecution(
    left: UsageLogicalExecutionObservation | undefined,
    right: UsageLogicalExecutionObservation | undefined,
): UsageLogicalExecutionObservation | undefined {
    if (!right) return left
    if (!left) return right
    const tools = mergeTools(left.tools, right.tools)
    return {
        logicalRequests: {
            completed: checkedAdd(left.logicalRequests.completed, right.logicalRequests.completed, "logical completed"),
            failed: checkedAdd(left.logicalRequests.failed, right.logicalRequests.failed, "logical failed"),
            cancelled: checkedAdd(left.logicalRequests.cancelled, right.logicalRequests.cancelled, "logical cancelled"),
            aborted: checkedAdd(left.logicalRequests.aborted, right.logicalRequests.aborted, "logical aborted"),
        },
        turnDurationMs: addSummary(left.turnDurationMs, right.turnDurationMs, "logical turn duration"),
        ...(tools ? { tools } : {}),
        taskAttempts: addSummary(left.taskAttempts, right.taskAttempts, "logical task attempts"),
    }
}

function addSummary(left: ExecutionSummary, right: ExecutionSummary, label: string): ExecutionSummary {
    return {
        count: checkedAdd(left.count, right.count, `${label} count`),
        sum: checkedAdd(left.sum, right.sum, `${label} sum`),
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
    }
}

function mergeTools(left: UsageToolsWire | undefined, right: UsageToolsWire | undefined): UsageToolsWire | undefined {
    if (!right) return left
    if (!left) return right
    const byName = new Map<string, ToolOutcomeCounts>()
    for (const tools of [left, right]) {
        for (const [name, counts] of Object.entries(tools.by_name ?? {})) {
            byName.set(name, addToolOutcomes(byName.get(name), counts, `logical tool ${name}`))
        }
    }
    const unlisted = addToolOutcomes(left.unlisted, right.unlisted, "logical unlisted tools")
    const orderedByName = Object.fromEntries(
        [...byName.entries()].sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
    )
    const includeBreakdown = byName.size > 0 || toolOutcomeTotal(unlisted) > 0
    return foldToolsToBound({
        completed: checkedAdd(left.completed, right.completed, "logical tools completed"),
        failed: checkedAdd(left.failed, right.failed, "logical tools failed"),
        cancelled: checkedAdd(left.cancelled, right.cancelled, "logical tools cancelled"),
        ...(includeBreakdown ? { by_name: orderedByName } : {}),
        ...(toolOutcomeTotal(unlisted) > 0 ? { unlisted } : {}),
    })
}

function addToolOutcomes(
    left: ToolOutcomeCounts | undefined,
    right: ToolOutcomeCounts | undefined,
    label: string,
): ToolOutcomeCounts {
    return {
        completed: checkedAdd(left?.completed ?? 0, right?.completed ?? 0, `${label} completed`),
        failed: checkedAdd(left?.failed ?? 0, right?.failed ?? 0, `${label} failed`),
        cancelled: checkedAdd(left?.cancelled ?? 0, right?.cancelled ?? 0, `${label} cancelled`),
    }
}

function toolOutcomeTotal(counts: ToolOutcomeCounts): number {
    return checkedAdd(checkedAdd(counts.completed, counts.failed, "tool outcome total"), counts.cancelled, "tool outcome total")
}

function seal(bucket: AttemptBucket, sealedAt: number): AttemptBucket {
    if (!Number.isSafeInteger(sealedAt) || sealedAt < 0) throw new Error("Attempt bucket sealedAt is invalid")
    return { ...bucket, sealedAt }
}

function identityKey(identity: UsageAttemptIdentity): string {
    return JSON.stringify([identity.role, identity.provider, identity.modelId, identity.thinking])
}

function emptyOutcomes(): AttemptOutcomeCounts {
    return { completed: 0, failed: 0, cancelled: 0, aborted: 0 }
}

function incrementOutcome(counts: AttemptOutcomeCounts, outcome: UsageAttemptObservation["outcome"]): AttemptOutcomeCounts {
    return { ...counts, [outcome]: checkedAdd(counts[outcome], 1, `request ${outcome}`) }
}

function emptyTokens(): UsageAttemptTokens {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

function addTokens(left: UsageAttemptTokens, right: UsageAttemptTokens): UsageAttemptTokens {
    return {
        input: checkedAdd(left.input, right.input, "input tokens"),
        output: checkedAdd(left.output, right.output, "output tokens"),
        cacheRead: checkedAdd(left.cacheRead, right.cacheRead, "cache read tokens"),
        cacheWrite: checkedAdd(left.cacheWrite, right.cacheWrite, "cache write tokens"),
        reasoning: checkedAdd(left.reasoning, right.reasoning, "reasoning tokens"),
    }
}

function observeDistribution(current: AttemptDistribution | undefined, sample: number): AttemptDistribution {
    const buckets = current ? [...current.buckets] : Array.from({ length: USAGE_HISTOGRAM_BOUNDS_MS.length + 1 }, () => 0)
    const bucket = USAGE_HISTOGRAM_BOUNDS_MS.findIndex((bound) => sample <= bound)
    const index = bucket < 0 ? buckets.length - 1 : bucket
    buckets[index] = checkedAdd(buckets[index], 1, "duration bucket")
    if (!current) return { count: 1, sum: sample, min: sample, max: sample, buckets }
    return {
        count: checkedAdd(current.count, 1, "duration count"),
        sum: checkedAdd(current.sum, sample, "duration sum"),
        min: Math.min(current.min, sample),
        max: Math.max(current.max, sample),
        buckets,
    }
}

export function validateUsageAttemptObservation(observation: UsageAttemptObservation): void {
    for (const [label, value] of [
        ["policy generation", observation.policyGeneration],
        ["admittedAt", observation.admittedAt],
        ["duration", observation.durationMs],
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Attempt ${label} must be a non-negative safe integer`)
    }
    if (!observation.attemptObservationId || !observation.logicalRequestId)
        throw new Error("Attempt observation identity is required")
    validateAttemptIdentity(observation.identity)
    for (const [label, value] of Object.entries(observation.tokens)) {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error(`Attempt ${label} tokens must be a non-negative safe integer`)
    }
    if (observation.tokens.reasoning > observation.tokens.output) throw new Error("Attempt reasoning tokens exceed output tokens")
    requireCount(observation.sessionsStarted ?? 0, "sessions started")
    if ((observation.sessionsStarted ?? 0) > 0 && !observation.logicalExecution) {
        throw new Error("Session starts require a final logical execution")
    }
    if (observation.logicalExecution && validateLogicalExecution(observation.logicalExecution) !== 1) {
        throw new Error("Attempt observation must carry exactly one logical request")
    }
}

/** Validate a durable open or sealed bucket before it becomes repository authority. */
export function validateAttemptBucket(bucket: AttemptBucket): void {
    if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(bucket.bucketId)) throw new Error("Attempt bucket ID is invalid")
    for (const [label, value] of [
        ["policy generation", bucket.policyGeneration],
        ["window start", bucket.windowStartedAt],
        ["window end", bucket.windowEndedAt],
        ["first attempt time", bucket.firstAttemptAt],
        ["last attempt time", bucket.lastAttemptAt],
        ["duration", bucket.durationMs],
        ["sessions started", bucket.sessionsStarted],
    ] as const) {
        requireCount(value, `bucket ${label}`)
    }
    if (bucket.windowEndedAt <= bucket.windowStartedAt) throw new Error("Attempt bucket event window is invalid")
    if (
        bucket.lastAttemptAt < bucket.firstAttemptAt ||
        bucket.firstAttemptAt < bucket.windowStartedAt ||
        bucket.lastAttemptAt >= bucket.windowEndedAt
    ) {
        throw new Error("Attempt bucket event range is invalid")
    }
    if (bucket.sealedAt !== undefined) requireCount(bucket.sealedAt, "bucket sealed time")
    if (!Array.isArray(bucket.facts) || bucket.facts.length > ATTEMPT_BUCKET_MAX_FACTS) {
        throw new Error("Attempt bucket facts are invalid")
    }
    if (bucket.facts.length === 0 && bucket.sessionsStarted === 0) throw new Error("Attempt bucket has no activity")

    const identities = new Set<string>()
    let durationSum = 0
    for (const fact of bucket.facts) {
        validateAttemptIdentity(fact.identity)
        const key = identityKey(fact.identity)
        if (identities.has(key)) throw new Error("Attempt bucket contains duplicate identity")
        identities.add(key)
        const requests: readonly number[] = [
            fact.requests.completed,
            fact.requests.failed,
            fact.requests.cancelled,
            fact.requests.aborted,
        ]
        requests.forEach((value) => requireCount(value, "request count"))
        const requestTotal = requests.reduce((sum, value) => checkedAdd(sum, value, "request total"), 0)
        const tokens: readonly (readonly [string, number])[] = [
            ["input", fact.tokens.input],
            ["output", fact.tokens.output],
            ["cache read", fact.tokens.cacheRead],
            ["cache write", fact.tokens.cacheWrite],
            ["reasoning", fact.tokens.reasoning],
        ]
        for (const [label, value] of tokens) requireCount(value, `${label} tokens`)
        if (fact.tokens.reasoning > fact.tokens.output) throw new Error("Attempt reasoning tokens exceed output tokens")
        requireCount(fact.tokenCoverage.reported, "reported coverage")
        requireCount(fact.tokenCoverage.unreported, "unreported coverage")
        if (checkedAdd(fact.tokenCoverage.reported, fact.tokenCoverage.unreported, "coverage") !== requestTotal) {
            throw new Error("Attempt token coverage does not match requests")
        }
        requireCount(fact.generationOutputTokens, "generation output tokens")
        validateDistribution(fact.duration)
        if (fact.duration.count !== requestTotal) throw new Error("Attempt duration count does not match requests")
        durationSum = checkedAdd(durationSum, fact.duration.sum, "bucket duration")
        if (fact.logicalExecution && validateLogicalExecution(fact.logicalExecution) > requestTotal) {
            throw new Error("Logical request count exceeds Provider attempt count")
        }
        for (const [name, value] of Object.entries(fact.errors) as [string, number][]) {
            if (!/^[a-z][a-z0-9_]{0,31}$/u.test(name)) throw new Error("Attempt error class is invalid")
            requireCount(value, "error count")
        }
    }
    if (durationSum !== bucket.durationMs) throw new Error("Attempt bucket duration does not match fact sums")
}

function validateLogicalExecution(execution: UsageLogicalExecutionObservation): number {
    const requests = execution.logicalRequests
    const logicalTotal = [requests.completed, requests.failed, requests.cancelled, requests.aborted].reduce(
        (sum, value) => checkedAdd(sum, requireCount(value, "logical request count"), "logical request total"),
        0,
    )
    if (logicalTotal < 1) throw new Error("Logical execution must contain a request")
    validateExecutionSummary(execution.turnDurationMs, "logical turn duration")
    if (execution.turnDurationMs.count !== logicalTotal) {
        throw new Error("Logical turn duration count does not match requests")
    }
    if (validateTaskAttempts(execution.taskAttempts).length > 0 || execution.taskAttempts.count !== logicalTotal) {
        throw new Error("Logical task attempts do not match requests")
    }
    if (execution.tools) {
        if (validateTools(execution.tools).length > 0) throw new Error("Logical tool outcomes do not conserve")
        if (toolOutcomeTotal(execution.tools) < 1) throw new Error("Empty logical tools must be omitted")
    }
    return logicalTotal
}

function validateExecutionSummary(summary: ExecutionSummary, label: string): void {
    requireCount(summary.count, `${label} count`)
    requireCount(summary.sum, `${label} sum`)
    requireCount(summary.min, `${label} min`)
    requireCount(summary.max, `${label} max`)
    if (summary.count < 1 || summary.min > summary.max) throw new Error(`Attempt ${label} summary is invalid`)
    const average = summary.sum / summary.count
    if (average < summary.min || average > summary.max) throw new Error(`Attempt ${label} summary is inconsistent`)
}

function validateAttemptIdentity(identity: UsageAttemptIdentity): void {
    const { role, provider, modelId, thinking } = identity
    if (!(["task", "subagent", "compaction", "reviewer", "other"] as const).includes(role)) {
        throw new Error("Attempt role is invalid")
    }
    if (!/^[a-z0-9_-]{1,32}$/u.test(provider)) throw new Error("Attempt provider is invalid")
    if (!/^(?:catalog:[a-z0-9][a-z0-9_.:/-]{0,95}|state:(?:private|unknown))$/u.test(modelId)) {
        throw new Error("Attempt model identity is invalid")
    }
    if (
        !(
            (typeof thinking === "number" &&
                Number.isSafeInteger(thinking) &&
                !Object.is(thinking, -0) &&
                (thinking === -1 || thinking >= 0)) ||
            (typeof thinking === "string" &&
                /^(?:level:[a-z0-9_.-]{1,32}|state:(?:enabled|disabled|off|dynamic|default|unknown))$/u.test(thinking))
        )
    ) {
        throw new Error("Attempt thinking identity is invalid")
    }
}

function validateDistribution(distribution: AttemptDistribution): void {
    requireCount(distribution.count, "duration count")
    requireCount(distribution.sum, "duration sum")
    requireCount(distribution.min, "duration min")
    requireCount(distribution.max, "duration max")
    if (distribution.count < 1 || distribution.min > distribution.max) throw new Error("Attempt duration distribution is invalid")
    const average = distribution.sum / distribution.count
    if (average < distribution.min || average > distribution.max) throw new Error("Attempt duration summary is inconsistent")
    if (!Array.isArray(distribution.buckets) || distribution.buckets.length !== USAGE_HISTOGRAM_BOUNDS_MS.length + 1) {
        throw new Error("Attempt duration buckets are invalid")
    }
    const count = distribution.buckets.reduce(
        (sum, value) => checkedAdd(sum, requireCount(value, "duration bucket"), "duration buckets"),
        0,
    )
    if (count !== distribution.count) throw new Error("Attempt duration buckets do not match count")
}

function requireCount(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Attempt ${label} must be a non-negative safe integer`)
    return value
}

function checkedAdd(left: number, right: number, label: string): number {
    const value = left + right
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Attempt ${label} overflow`)
    return value
}
