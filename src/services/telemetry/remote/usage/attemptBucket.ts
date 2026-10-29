import { isUsageModelId } from "../contracts/modelIdentity"
import { isUsageThinking } from "../contracts/thinking"
import {
    histogramBucket,
    USAGE_DURATION_BUCKET_THRESHOLD_MS,
    USAGE_EVENT_WINDOW_MS,
    USAGE_HARD_LIMITS,
    USAGE_HISTOGRAM_BUCKETS,
} from "../contracts/usageBodySchema"
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

export const ATTEMPT_BUCKET_DURATION_THRESHOLD_MS = USAGE_DURATION_BUCKET_THRESHOLD_MS
export const ATTEMPT_BUCKET_MAX_FACTS = USAGE_HARD_LIMITS.maxFacts
export const ATTEMPT_EVENT_WINDOW_MS = USAGE_EVENT_WINDOW_MS
/** Failure-class catalog token: built-in classes and versioned extensions share it (usage-contract §5). */
const FAILURE_CLASS_PATTERN = /^[a-z][a-z0-9_.-]{0,31}$/u
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
    /** Attempts that carried a generation pair; the timing and output below cover exactly them. */
    readonly generationCoverage: AttemptCoverage
    readonly generationOutputTokens: number
    readonly duration: AttemptDistribution
    readonly ttft?: AttemptDistribution
    readonly generation?: AttemptDistribution
    /** One count per failed attempt, by failure class; it sums to `requests.failed`. */
    readonly errors: Readonly<Record<string, number>>
    readonly logicalExecution?: UsageLogicalExecutionObservation
    /**
     * Result-producing logical requests of this fact: `reported` carry their
     * execution in `logicalExecution`, `unreported` had not settled when the
     * bucket sealed (usage-client-lifecycle §9).
     */
    readonly logicalExecutionCoverage: AttemptCoverage
}

/** The latest attempt of a logical request inside an open bucket, waiting for its execution claim. */
export interface LogicalCandidate {
    readonly attemptObservationId: string
    readonly factIndex: number
}

/** A logical execution that settled after its result-producing attempt was already final. */
export interface LogicalExecutionClaim {
    readonly logicalRequestId: string
    readonly attemptObservationId: string
    readonly execution: UsageLogicalExecutionObservation
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
    /** Open buckets only: unclaimed logical requests by ID; sealing counts them as unreported. */
    readonly logicalCandidates?: Readonly<Record<string, LogicalCandidate>>
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
    /** This observation is its local session's first: the receiving bucket counts that session once. */
    readonly startsSession?: boolean
    /** The logical request already claimed coverage: this attempt neither claims nor waits for a claim. */
    readonly logicalClaimed?: boolean
    /**
     * Whether a bucket, once sealed, still fits one request under the effective
     * grant. An append that would break it seals the open bucket first, so no
     * sealed bucket is unsendable for capacity (usage-client-interface §9).
     */
    readonly fits?: (sealed: AttemptBucket) => boolean
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

    let appended = appendToBucket(open ?? createBucket(options.newBucketId(), observation, eventWindowMs), observation, options)
    if (open && options.fits && !options.fits(seal(appended, Math.max(options.sealedAt(), appended.lastAttemptAt)))) {
        sealed.push(seal(open, options.sealedAt()))
        appended = appendToBucket(createBucket(options.newBucketId(), observation, eventWindowMs), observation, options)
    }
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

export interface ClaimedLogicalExecution {
    readonly state: AttemptBucketState
    /** The open bucket that received the execution; absent when the request stays unreported. */
    readonly bucketId?: string
}

/**
 * Attach a logical execution that settled after its attempt was final. Only the
 * open bucket still waiting for that exact attempt accepts it; a sealed bucket
 * already counted the request as unreported, so a late claim changes nothing.
 */
export function claimLogicalExecution(state: AttemptBucketState, claim: LogicalExecutionClaim): ClaimedLogicalExecution {
    validateLogicalExecutionClaim(claim)
    const open = state.open
    const candidate = open?.logicalCandidates?.[claim.logicalRequestId]
    if (!open || !candidate || candidate.attemptObservationId !== claim.attemptObservationId) return { state }
    const facts = [...open.facts]
    const fact = facts[candidate.factIndex]
    facts[candidate.factIndex] = {
        ...fact,
        logicalExecution: mergeLogicalExecution(fact.logicalExecution, claim.execution),
        logicalExecutionCoverage: {
            ...fact.logicalExecutionCoverage,
            reported: checkedAdd(fact.logicalExecutionCoverage.reported, 1, "logical coverage"),
        },
    }
    const { [claim.logicalRequestId]: _claimed, ...waiting } = open.logicalCandidates ?? {}
    return { state: { ...state, open: withCandidates({ ...open, facts }, waiting) }, bucketId: open.bucketId }
}

function appendToBucket(
    bucket: AttemptBucket,
    observation: UsageAttemptObservation,
    options: AppendAttemptOptions,
): AttemptBucket {
    const key = identityKey(observation.identity)
    const index = bucket.facts.findIndex((fact) => identityKey(fact.identity) === key)
    const claimsNow = observation.logicalExecution !== undefined && options.logicalClaimed !== true
    const attempt = claimsNow ? observation : withoutLogicalExecution(observation)
    const facts = [...bucket.facts]
    const factIndex = index < 0 ? facts.length : index
    if (index < 0) facts.push(createFact(attempt))
    else facts[index] = appendToFact(facts[index], attempt)
    // A later attempt of the same logical request supersedes an earlier one: early retries never count.
    const { [observation.logicalRequestId]: _superseded, ...waiting } = bucket.logicalCandidates ?? {}
    const candidates =
        claimsNow || options.logicalClaimed === true
            ? waiting
            : {
                  ...waiting,
                  [observation.logicalRequestId]: { attemptObservationId: observation.attemptObservationId, factIndex },
              }
    return withCandidates(
        {
            ...bucket,
            firstAttemptAt: Math.min(bucket.firstAttemptAt, observation.admittedAt),
            lastAttemptAt: Math.max(bucket.lastAttemptAt, observation.admittedAt),
            durationMs: checkedAdd(bucket.durationMs, observation.durationMs, "bucket duration"),
            sessionsStarted: checkedAdd(bucket.sessionsStarted, options.startsSession === true ? 1 : 0, "sessions started"),
            facts,
        },
        candidates,
    )
}

function withCandidates(bucket: AttemptBucket, candidates: Readonly<Record<string, LogicalCandidate>>): AttemptBucket {
    const { logicalCandidates: _previous, ...rest } = bucket
    return Object.keys(candidates).length > 0 ? { ...rest, logicalCandidates: candidates } : rest
}

function withoutLogicalExecution(observation: UsageAttemptObservation): UsageAttemptObservation {
    const { logicalExecution: _execution, ...rest } = observation
    return rest
}

const NO_SAMPLES: Pick<AttemptFactAggregate, "tokenCoverage" | "generationCoverage" | "generationOutputTokens" | "errors"> = {
    tokenCoverage: { reported: 0, unreported: 0 },
    generationCoverage: { reported: 0, unreported: 0 },
    generationOutputTokens: 0,
    errors: {},
}

function createFact(observation: UsageAttemptObservation): AttemptFactAggregate {
    return {
        identity: observation.identity,
        requests: incrementOutcome(emptyOutcomes(), observation.outcome),
        tokens: observation.tokenUsageReported ? observation.tokens : emptyTokens(),
        ...observeAttemptSamples(NO_SAMPLES, observation),
        duration: observeDistribution(undefined, observation.durationMs),
        ...(observation.ttftMs !== undefined ? { ttft: observeDistribution(undefined, observation.ttftMs) } : {}),
        ...(observation.generationMs !== undefined
            ? { generation: observeDistribution(undefined, observation.generationMs) }
            : {}),
        ...(observation.logicalExecution ? { logicalExecution: observation.logicalExecution } : {}),
        logicalExecutionCoverage: { reported: observation.logicalExecution ? 1 : 0, unreported: 0 },
    }
}

function appendToFact(fact: AttemptFactAggregate, observation: UsageAttemptObservation): AttemptFactAggregate {
    const logicalExecution = mergeLogicalExecution(fact.logicalExecution, observation.logicalExecution)
    const ttft = observeOptionalDistribution(fact.ttft, observation.ttftMs)
    const generation = observeOptionalDistribution(fact.generation, observation.generationMs)
    return {
        ...fact,
        requests: incrementOutcome(fact.requests, observation.outcome),
        tokens: observation.tokenUsageReported ? addTokens(fact.tokens, observation.tokens) : fact.tokens,
        ...observeAttemptSamples(fact, observation),
        duration: observeDistribution(fact.duration, observation.durationMs),
        ...(ttft ? { ttft } : {}),
        ...(generation ? { generation } : {}),
        ...(logicalExecution ? { logicalExecution } : {}),
        logicalExecutionCoverage: {
            ...fact.logicalExecutionCoverage,
            reported: checkedAdd(
                fact.logicalExecutionCoverage.reported,
                observation.logicalExecution ? 1 : 0,
                "logical coverage",
            ),
        },
    }
}

/**
 * Coverage, generation output and error counters of one more attempt. A
 * validated observation carries its generation pair only with reported tokens,
 * and a failure class exactly when it failed.
 */
function observeAttemptSamples(
    fact: Pick<AttemptFactAggregate, "tokenCoverage" | "generationCoverage" | "generationOutputTokens" | "errors">,
    observation: UsageAttemptObservation,
): Pick<AttemptFactAggregate, "tokenCoverage" | "generationCoverage" | "generationOutputTokens" | "errors"> {
    const generated = observation.generationMs !== undefined
    const failureClass = observation.failureClass
    return {
        tokenCoverage: observeCoverage(fact.tokenCoverage, observation.tokenUsageReported, "token coverage"),
        generationCoverage: observeCoverage(fact.generationCoverage, generated, "generation coverage"),
        generationOutputTokens: checkedAdd(
            fact.generationOutputTokens,
            generated ? (observation.generationOutputTokens ?? 0) : 0,
            "generation output tokens",
        ),
        errors:
            failureClass === undefined
                ? fact.errors
                : { ...fact.errors, [failureClass]: checkedAdd(fact.errors[failureClass] ?? 0, 1, `error ${failureClass}`) },
    }
}

function observeCoverage(coverage: AttemptCoverage, reported: boolean, label: string): AttemptCoverage {
    return reported
        ? { ...coverage, reported: checkedAdd(coverage.reported, 1, label) }
        : { ...coverage, unreported: checkedAdd(coverage.unreported, 1, label) }
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

/** Sealing ends the wait: every logical request still unclaimed becomes unreported for its fact. */
function seal(bucket: AttemptBucket, sealedAt: number): AttemptBucket {
    if (!Number.isSafeInteger(sealedAt) || sealedAt < 0) throw new Error("Attempt bucket sealedAt is invalid")
    const { logicalCandidates, ...rest } = bucket
    const facts = [...rest.facts]
    for (const candidate of Object.values(logicalCandidates ?? {})) {
        const fact = facts[candidate.factIndex]
        facts[candidate.factIndex] = {
            ...fact,
            logicalExecutionCoverage: {
                ...fact.logicalExecutionCoverage,
                unreported: checkedAdd(fact.logicalExecutionCoverage.unreported, 1, "logical coverage"),
            },
        }
    }
    return { ...rest, facts, sealedAt }
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

function observeOptionalDistribution(
    current: AttemptDistribution | undefined,
    sample: number | undefined,
): AttemptDistribution | undefined {
    return sample === undefined ? current : observeDistribution(current, sample)
}

function observeDistribution(current: AttemptDistribution | undefined, sample: number): AttemptDistribution {
    const buckets = current ? [...current.buckets] : Array.from({ length: USAGE_HISTOGRAM_BUCKETS }, () => 0)
    const index = histogramBucket(sample)
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

export function validateLogicalExecutionClaim(claim: LogicalExecutionClaim): void {
    if (typeof claim.logicalRequestId !== "string" || !claim.logicalRequestId)
        throw new Error("Logical claim identity is required")
    if (typeof claim.attemptObservationId !== "string" || !claim.attemptObservationId) {
        throw new Error("Logical claim attempt identity is required")
    }
    if (validateLogicalExecution(claim.execution) !== 1) throw new Error("Logical claim must carry exactly one logical request")
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
    if (observation.durationMs < 1) throw new Error("Attempt duration must be at least one millisecond")
    validateFailureClass(observation)
    validateGenerationPair(observation)
    if (observation.logicalExecution && validateLogicalExecution(observation.logicalExecution) !== 1) {
        throw new Error("Attempt observation must carry exactly one logical request")
    }
}

/** A failed attempt names exactly one catalog class; any other outcome names none (usage-contract §5). */
function validateFailureClass(observation: UsageAttemptObservation): void {
    const { failureClass } = observation
    if (observation.outcome !== "failed") {
        if (failureClass !== undefined) throw new Error("Only a failed attempt carries a failure class")
        return
    }
    if (typeof failureClass !== "string" || !FAILURE_CLASS_PATTERN.test(failureClass)) {
        throw new Error("A failed attempt requires a catalog failure class")
    }
}

/** Generation timing and output exist only together, on reported tokens, within the reported output. */
function validateGenerationPair(observation: UsageAttemptObservation): void {
    if (observation.ttftMs !== undefined) requireCount(observation.ttftMs, "time to first token")
    const { generationMs, generationOutputTokens } = observation
    if (generationMs === undefined && generationOutputTokens === undefined) return
    if (generationMs === undefined || generationOutputTokens === undefined) {
        throw new Error("Attempt generation timing and output must be reported together")
    }
    requireCount(generationMs, "generation duration")
    requireCount(generationOutputTokens, "generation output tokens")
    if (!observation.tokenUsageReported) throw new Error("Attempt generation requires reported token usage")
    if (generationOutputTokens > observation.tokens.output) throw new Error("Attempt generation output exceeds output tokens")
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
    // A session is counted only by the bucket that receives its first attempt, so every bucket has a fact.
    if (!Array.isArray(bucket.facts) || bucket.facts.length === 0 || bucket.facts.length > ATTEMPT_BUCKET_MAX_FACTS) {
        throw new Error("Attempt bucket facts are invalid")
    }
    const waitingByFact = validateLogicalCandidates(bucket)

    const identities = new Set<string>()
    let durationSum = 0
    let attemptTotal = 0
    for (const [factIndex, fact] of bucket.facts.entries()) {
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
        for (const value of requests) requireCount(value, "request count")
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
        if (coverageTotal(fact.tokenCoverage, "token coverage") !== requestTotal) {
            throw new Error("Attempt token coverage does not match requests")
        }
        validateFactGeneration(fact, requestTotal)
        validateDistribution(fact.duration)
        if (fact.duration.count !== requestTotal) throw new Error("Attempt duration count does not match requests")
        if (fact.duration.min < 1) throw new Error("Attempt duration must be at least one millisecond")
        if (fact.ttft !== undefined) {
            validateDistribution(fact.ttft)
            if (fact.ttft.count > requestTotal) throw new Error("Attempt time-to-first-token count exceeds requests")
        }
        durationSum = checkedAdd(durationSum, fact.duration.sum, "bucket duration")
        attemptTotal = checkedAdd(attemptTotal, requestTotal, "bucket attempts")
        const reportedLogical = fact.logicalExecution ? validateLogicalExecution(fact.logicalExecution) : 0
        const coverage = fact.logicalExecutionCoverage
        if (requireCount(coverage?.reported, "reported logical coverage") !== reportedLogical) {
            throw new Error("Logical coverage does not match the attached executions")
        }
        const logicalTotal = checkedAdd(
            checkedAdd(reportedLogical, requireCount(coverage.unreported, "unreported logical coverage"), "logical coverage"),
            waitingByFact[factIndex] ?? 0,
            "logical coverage",
        )
        if (logicalTotal > requestTotal) throw new Error("Logical request count exceeds Provider attempt count")
        validateFactErrors(fact)
    }
    if (durationSum !== bucket.durationMs) throw new Error("Attempt bucket duration does not match fact sums")
    if (bucket.sessionsStarted > attemptTotal) throw new Error("Attempt bucket counts more sessions than attempts")
}

function coverageTotal(coverage: AttemptCoverage, label: string): number {
    return checkedAdd(
        requireCount(coverage?.reported, `reported ${label}`),
        requireCount(coverage?.unreported, `unreported ${label}`),
        label,
    )
}

/** The generation subset is covered, timed and counted as one (usage-contract §7). */
function validateFactGeneration(fact: AttemptFactAggregate, requestTotal: number): void {
    if (coverageTotal(fact.generationCoverage, "generation coverage") !== requestTotal) {
        throw new Error("Attempt generation coverage does not match requests")
    }
    const reported = fact.generationCoverage.reported
    requireCount(fact.generationOutputTokens, "generation output tokens")
    if (fact.generation !== undefined) validateDistribution(fact.generation)
    if ((fact.generation?.count ?? 0) !== reported) throw new Error("Attempt generation timing does not match its coverage")
    if (reported === 0 && fact.generationOutputTokens > 0) throw new Error("Unreported generation cannot carry output")
    if (reported > fact.tokenCoverage.reported) throw new Error("Attempt generation requires reported token usage")
    if (fact.generationOutputTokens > fact.tokens.output) throw new Error("Attempt generation output exceeds output tokens")
}

/** Every failed attempt adds exactly one error of its class, and nothing else does. */
function validateFactErrors(fact: AttemptFactAggregate): void {
    let total = 0
    for (const [name, value] of Object.entries(fact.errors) as [string, number][]) {
        if (!FAILURE_CLASS_PATTERN.test(name)) throw new Error("Attempt error class is invalid")
        if (requireCount(value, "error count") < 1) throw new Error("Attempt error class without failures must be omitted")
        total = checkedAdd(total, value, "error total")
    }
    if (total !== fact.requests.failed) throw new Error("Attempt errors do not match failed requests")
}

/** Candidates exist only while a bucket is open and each points at one of its facts. */
function validateLogicalCandidates(bucket: AttemptBucket): Record<number, number> {
    const waitingByFact: Record<number, number> = {}
    const candidates = bucket.logicalCandidates
    if (candidates === undefined) return waitingByFact
    if (bucket.sealedAt !== undefined) throw new Error("A sealed attempt bucket cannot wait for logical claims")
    if (typeof candidates !== "object" || candidates === null) throw new Error("Attempt bucket logical candidates are invalid")
    for (const [logicalRequestId, candidate] of Object.entries(candidates)) {
        if (
            !logicalRequestId ||
            typeof candidate?.attemptObservationId !== "string" ||
            !candidate.attemptObservationId ||
            !Number.isSafeInteger(candidate.factIndex) ||
            candidate.factIndex < 0 ||
            candidate.factIndex >= bucket.facts.length
        ) {
            throw new Error("Attempt bucket logical candidate is invalid")
        }
        waitingByFact[candidate.factIndex] = checkedAdd(waitingByFact[candidate.factIndex] ?? 0, 1, "logical candidates")
    }
    return waitingByFact
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
    // One vocabulary with the projector (usage-contract §3.1, §3.2), so a projected identity is always storable.
    if (!isUsageModelId(modelId)) throw new Error("Attempt model identity is invalid")
    if (!isUsageThinking(thinking)) throw new Error("Attempt thinking identity is invalid")
}

function validateDistribution(distribution: AttemptDistribution): void {
    requireCount(distribution.count, "duration count")
    requireCount(distribution.sum, "duration sum")
    requireCount(distribution.min, "duration min")
    requireCount(distribution.max, "duration max")
    if (distribution.count < 1 || distribution.min > distribution.max) throw new Error("Attempt duration distribution is invalid")
    const average = distribution.sum / distribution.count
    if (average < distribution.min || average > distribution.max) throw new Error("Attempt duration summary is inconsistent")
    if (!Array.isArray(distribution.buckets) || distribution.buckets.length !== USAGE_HISTOGRAM_BUCKETS) {
        throw new Error("Attempt duration buckets are invalid")
    }
    const count = distribution.buckets.reduce(
        (sum, value) => checkedAdd(sum, requireCount(value, "duration bucket"), "duration buckets"),
        0,
    )
    if (count !== distribution.count) throw new Error("Attempt duration buckets do not match count")
    // The populated histogram range must agree with min and max, as the service checks.
    const first = distribution.buckets.findIndex((value) => value > 0)
    const last = distribution.buckets.length - 1 - [...distribution.buckets].reverse().findIndex((value) => value > 0)
    if (histogramBucket(distribution.min) !== first || histogramBucket(distribution.max) !== last) {
        throw new Error("Attempt duration buckets do not match min and max")
    }
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
