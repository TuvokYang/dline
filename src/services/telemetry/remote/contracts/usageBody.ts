/**
 * The `/usage` request body.
 *
 * The body carries one numerical source of truth: a list of facts keyed by
 * `(role, provider, model, custom)`. There are no purpose/model/provider marginal
 * totals, because those cannot be deleted independently: removing one model would
 * leave the marginal totals holding tokens nobody can attribute.
 *
 * Two bounds are structural rather than advisory. A batch holds at most 32 facts
 * and 64 KiB of UTF-8, and a batch that reaches a bound is sealed and a new one
 * is started. Folding a real identity into a placeholder to stay inside the bound
 * is forbidden, because it makes a later per-model deletion silently wrong.
 */

import { USAGE_ERROR_CLASSES, type UsageErrorClass } from "@/core/task/telemetry/UsageSettlement"
import {
    EMPTY_EXECUTION_SUMMARY,
    isCount,
    isEmptyTaskAttempts,
    isEmptyTodos,
    isEmptyTools,
    isOutcomeCounts,
    isRegisteredToolName,
    MAX_TOOL_NAMES_PER_FACT,
    roleCarriesTodos,
    TOOL_OUTCOMES,
    type UsageTaskAttemptsWire,
    type UsageTodosWire,
    type UsageToolsWire,
    validateTaskAttempts,
    validateTodos,
    validateTools,
} from "./usageExecution"
import {
    resolveUsageIdentity,
    roleCarriesChecklist,
    UNKNOWN_USAGE_ID,
    type UsageRole,
    usageModelIdentityKey,
} from "./usageIdentity"

export const USAGE_SCHEMA_VERSION = 3
export const USAGE_BODY_LIMIT_BYTES = 64 * 1024
/** One batch may hold at most this many facts. */
export const USAGE_MAX_FACTS = 32
export const USAGE_MAX_ROLES = 8
export const USAGE_MAX_PROVIDERS = 8
export const USAGE_MAX_MODEL_IDENTITIES = 8

/** The wire window is second-aligned; every instant it names is a multiple of this. */
export const USAGE_SECOND_MS = 1_000
export const USAGE_MINUTE_MS = 60_000
/** The longest `ended_at - started_at` the service accepts; the seconds inside need not be contiguous. */
export const USAGE_MAX_SPAN_MS = 60 * USAGE_MINUTE_MS
/**
 * Active seconds one batch may carry, and the most the client keeps waiting locally.
 *
 * The unit is seconds rather than minutes because a minute count is a coarse
 * claim: a device active for 20 seconds and one active for 59 both counted as
 * one minute, which misstates the denominator of every per-active-time rate by
 * up to 3x. Seconds bound the same window without that loss, and one minute of
 * span admits at most 60 of them, so 3600 is the structural maximum.
 */
export const USAGE_MAX_ACTIVE_SECONDS = 3600

/** Upper bounds, in milliseconds, of every latency histogram; the eleventh bucket counts what exceeds them. */
export const USAGE_HISTOGRAM_BOUNDS_MS: readonly number[] = [250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000]
export const USAGE_HISTOGRAM_BUCKETS = USAGE_HISTOGRAM_BOUNDS_MS.length + 1

export const USAGE_HOST_EDITORS = ["vscode", "cursor", "vscodium", "windsurf", "other"] as const
export type UsageHostEditor = (typeof USAGE_HOST_EDITORS)[number]
export const USAGE_RELEASE_CHANNELS = ["stable", "insiders"] as const
export type UsageReleaseChannel = (typeof USAGE_RELEASE_CHANNELS)[number]

const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/
const CLIENT_FIELD_PATTERN = /^[A-Za-z0-9_.+ -]{1,64}$/

export interface UsageSummaryWire {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
}

export interface UsageDistributionWire extends UsageSummaryWire {
    readonly buckets: readonly number[]
}

export interface UsageRequestOutcomeWire {
    readonly completed: number
    readonly cancelled: number
    readonly failed: number
}

export interface UsageTurnOutcomeWire {
    readonly completed: number
    readonly cancelled: number
    readonly failed: number
    readonly aborted: number
}

export interface UsageTokensWire {
    readonly input: number
    readonly output: number
    readonly cache_read: number
    readonly cache_write: number
    /** The reasoning share of `output`; absent when the provider never reported it. */
    readonly reasoning?: number
}

/**
 * One fact.
 *
 * `turns`, `turn_duration_ms` and `tools` describe the complete response
 * execution. A role without such data omits them, and the reader must report
 * "not reported" rather than a zero-tool, zero-duration turn.
 */
export interface UsageFactWire {
    readonly role: UsageRole
    readonly provider: string
    readonly model: string
    readonly custom: boolean
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

export interface UsageClientWire {
    readonly version: string
    readonly platform?: string
    readonly architecture?: string
    readonly host_version?: string
    readonly host_editor?: UsageHostEditor
    readonly channel?: UsageReleaseChannel
    readonly is_dev?: boolean
}

/**
 * The batch window.
 *
 * `active_seconds` counts the distinct seconds of activity in this window. It is
 * the delta the service de-duplicates across batches, and the denominator of
 * every per-active-time rate. `dropped_seconds` names what could not be claimed:
 * a local validation failure, a 422, the backlog cap or an abandoned batch.
 */
export interface UsageWindowWire {
    readonly started_at: number
    readonly ended_at: number
    readonly active_seconds: number
    readonly dropped_seconds: number
}

export interface UsageBodyWire {
    readonly schema_version: typeof USAGE_SCHEMA_VERSION
    readonly client: UsageClientWire
    readonly window: UsageWindowWire
    readonly sessions_started: number
    readonly facts: readonly UsageFactWire[]
}

export type UsageBodyViolation =
    | "schema_version"
    | "client"
    | "window"
    | "sessions_started"
    | "facts"
    | "fact_identity"
    | "fact_counters"
    | "fact_distribution"
    | "fact_turns"
    | "fact_tools"
    | "fact_todos"
    | "fact_attempts"
    | "fact_errors"
    | "role_cardinality"
    | "provider_cardinality"
    | "model_cardinality"
    | "body_size"

/** Keep only the client fields the service accepts; an odd host value is left out instead of refusing every batch. */
export function sanitizeUsageClient(
    client: {
        readonly [K in keyof UsageClientWire]?: unknown
    },
): UsageClientWire | undefined {
    if (typeof client.version !== "string" || !CLIENT_VERSION_PATTERN.test(client.version)) return undefined
    const text = (value: unknown) => (typeof value === "string" && CLIENT_FIELD_PATTERN.test(value) ? value : undefined)
    const platform = text(client.platform)
    const architecture = text(client.architecture)
    const hostVersion = text(client.host_version)
    const hostEditor = USAGE_HOST_EDITORS.find((editor) => editor === client.host_editor)
    const channel = USAGE_RELEASE_CHANNELS.find((name) => name === client.channel)
    return {
        version: client.version,
        ...(platform ? { platform } : {}),
        ...(architecture ? { architecture } : {}),
        ...(hostVersion ? { host_version: hostVersion } : {}),
        ...(hostEditor ? { host_editor: hostEditor } : {}),
        ...(channel ? { channel } : {}),
        ...(typeof client.is_dev === "boolean" ? { is_dev: client.is_dev } : {}),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isConsistentSummary(value: unknown): value is UsageSummaryWire {
    if (!isRecord(value)) return false
    const { count, sum, min, max } = value
    if (!isCount(count) || count < 1) return false
    if (![sum, min, max].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)) return false
    const [total, low, high] = [sum, min, max] as number[]
    return low <= high && low * count <= total && total <= high * count
}

export function isConsistentDistribution(value: unknown): value is UsageDistributionWire {
    if (!isConsistentSummary(value)) return false
    const buckets = (value as { buckets?: unknown }).buckets
    if (!Array.isArray(buckets) || buckets.length !== USAGE_HISTOGRAM_BUCKETS || !buckets.every(isCount)) return false
    return buckets.reduce((total: number, count: number) => total + count, 0) === value.count
}

/**
 * Window rules.
 *
 * `active_seconds` may be zero because a batch that only reports an activation
 * has nothing to claim. The batch as a whole must still carry something: the
 * caller checks `active_seconds + sessions_started > 0` instead of requiring an
 * active second, so an activation-only batch is not dropped on the floor.
 *
 * A dropped count is not part of that test: it reports a loss, not an activity.
 */
export function isValidWindow(window: UsageWindowWire): boolean {
    if (!isRecord(window)) return false
    const { started_at: start, ended_at: end, active_seconds: active, dropped_seconds: dropped } = window
    if (![start, end, active, dropped].every(isCount)) return false
    if (start % USAGE_SECOND_MS !== 0 || end % USAGE_SECOND_MS !== 0 || end <= start) return false
    if (end - start > USAGE_MAX_SPAN_MS) return false
    if (active > USAGE_MAX_ACTIVE_SECONDS || dropped > USAGE_MAX_ACTIVE_SECONDS) return false
    // Distinct seconds inside the span cannot exceed the span itself.
    return active * USAGE_SECOND_MS <= end - start
}

function validateFactCounters(fact: UsageFactWire): UsageBodyViolation[] {
    const violations: UsageBodyViolation[] = []
    const requests = fact.requests
    if (!isRecord(requests) || !["completed", "cancelled", "failed"].every((key) => isCount(requests[key]))) {
        violations.push("fact_counters")
    }
    const tokens = fact.tokens
    if (!isRecord(tokens) || !["input", "output", "cache_read", "cache_write"].every((key) => isCount(tokens[key]))) {
        violations.push("fact_counters")
    } else if (tokens.reasoning !== undefined) {
        // Reasoning is a subset of output; counting it again would inflate the total.
        if (!isCount(tokens.reasoning) || tokens.reasoning > tokens.output) violations.push("fact_counters")
    }
    if (!isConsistentDistribution(fact.duration_ms)) violations.push("fact_distribution")
    for (const timing of [fact.ttft_ms, fact.generation_ms]) {
        if (timing !== undefined && !isConsistentDistribution(timing)) violations.push("fact_distribution")
    }
    if (fact.retry_wait_ms !== undefined && !isConsistentSummary(fact.retry_wait_ms)) violations.push("fact_distribution")
    if (!isCount(fact.retries)) violations.push("fact_counters")
    return violations
}

function requestTotalOf(fact: UsageFactWire): number | undefined {
    const requests = fact.requests
    if (!isRecord(requests)) return undefined
    const keys = ["completed", "cancelled", "failed"] as const
    if (!keys.every((key) => isCount(requests[key]))) return undefined
    return requests.completed + requests.cancelled + requests.failed
}

function validateFactExecution(fact: UsageFactWire): UsageBodyViolation[] {
    const violations: UsageBodyViolation[] = []
    const requestTotal = requestTotalOf(fact)

    if (fact.turns !== undefined) {
        const turns = fact.turns
        const keys = ["completed", "cancelled", "failed", "aborted"] as const
        if (!isRecord(turns) || !keys.every((key) => isCount(turns[key]))) {
            violations.push("fact_turns")
        } else {
            const total = keys.reduce((sum, key) => sum + turns[key], 0)
            if (fact.turn_duration_ms !== undefined) {
                // A turn duration must describe exactly the turns that were counted.
                if (!isConsistentSummary(fact.turn_duration_ms) || fact.turn_duration_ms.count !== total) {
                    violations.push("fact_turns")
                }
            }
        }
    } else if (fact.turn_duration_ms !== undefined) {
        // A turn duration without a turn outcome would describe a turn that was never counted.
        violations.push("fact_turns")
    }

    if (fact.tools !== undefined && validateTools(fact.tools).length > 0) violations.push("fact_tools")

    if (fact.todos !== undefined) {
        // A role without a checklist must not carry one; its absence is expected.
        if (!roleCarriesTodos(fact.role) || !roleCarriesChecklist(fact.role)) violations.push("fact_todos")
        else if (validateTodos(fact.todos).length > 0) violations.push("fact_todos")
    }

    if (fact.task_attempts !== undefined) {
        if (validateTaskAttempts(fact.task_attempts).length > 0) violations.push("fact_attempts")
        // Every request settles one sample, so the counts must agree.
        else if (requestTotal !== undefined && fact.task_attempts.count !== requestTotal) {
            violations.push("fact_attempts")
        }
    }

    if (fact.errors !== undefined) {
        if (!isRecord(fact.errors)) violations.push("fact_errors")
        else {
            for (const [key, value] of Object.entries(fact.errors)) {
                if (!(USAGE_ERROR_CLASSES as readonly string[]).includes(key) || !isCount(value)) {
                    violations.push("fact_errors")
                    break
                }
            }
        }
    }

    return violations
}

/**
 * Identity rules, applied to what the producer actually sent.
 *
 * A value this reader would have to repair means the producer and the contract
 * disagree about identity, and the fact it would produce is not the one that
 * ran. Rejecting is the only safe answer: accepting a repaired value merges two
 * distinct models, which makes every later per-model deletion wrong.
 */
function validateFactIdentity(fact: UsageFactWire): UsageBodyViolation[] {
    if (typeof fact.role !== "string" || typeof fact.provider !== "string" || typeof fact.model !== "string") {
        return ["fact_identity"]
    }
    if (fact.custom !== undefined && typeof fact.custom !== "boolean") return ["fact_identity"]
    const resolved = resolveUsageIdentity({
        role: fact.role,
        provider: fact.provider,
        model: fact.model,
        custom: fact.custom === true,
    })
    if (!resolved.ok) return ["fact_identity"]
    const { identity } = resolved
    const matches =
        identity.role === fact.role &&
        identity.provider === fact.provider &&
        identity.model === fact.model &&
        identity.custom === (fact.custom === true)
    return matches ? [] : ["fact_identity"]
}

/**
 * Every rule the service would apply, checked before a batch enters the outbox.
 *
 * A batch the service answers with 422 is a permanent loss, so the client
 * refuses it locally and records the loss instead of sending bytes it already
 * knows are wrong.
 */
export function validateUsageBody(body: UsageBodyWire): UsageBodyViolation[] {
    const violations: UsageBodyViolation[] = []

    if (body.schema_version !== USAGE_SCHEMA_VERSION) violations.push("schema_version")
    if (!isRecord(body.client) || !isValidClient(body.client)) violations.push("client")
    if (!isValidWindow(body.window)) violations.push("window")
    if (!isCount(body.sessions_started)) violations.push("sessions_started")
    if (!Array.isArray(body.facts)) return [...violations, "facts"]
    if (body.facts.length > USAGE_MAX_FACTS) violations.push("facts")

    const roles = new Set<string>()
    const providers = new Set<string>()
    const modelIdentities = new Set<string>()

    for (const entry of body.facts) {
        if (typeof entry !== "object" || entry === null) {
            violations.push("facts")
            continue
        }
        const fact = entry as UsageFactWire
        violations.push(...validateFactIdentity(fact))
        violations.push(...validateFactCounters(fact))
        violations.push(...validateFactExecution(fact))
        if (typeof fact.role === "string") roles.add(fact.role)
        if (typeof fact.provider === "string") providers.add(fact.provider)
        modelIdentities.add(
            usageModelIdentityKey({
                role: "task",
                provider: typeof fact.provider === "string" ? fact.provider : UNKNOWN_USAGE_ID,
                model: typeof fact.model === "string" ? fact.model : UNKNOWN_USAGE_ID,
                custom: fact.custom === true,
            }),
        )
    }

    if (roles.size > USAGE_MAX_ROLES) violations.push("role_cardinality")
    if (providers.size > USAGE_MAX_PROVIDERS) violations.push("provider_cardinality")
    if (modelIdentities.size > USAGE_MAX_MODEL_IDENTITIES) violations.push("model_cardinality")

    // An empty batch is only meaningful when it reports something else: an activation
    // or a claimed second. A batch with neither carries no information at all.
    if (body.facts.length === 0 && body.window.active_seconds + body.sessions_started === 0) {
        violations.push("facts")
    }

    return [...new Set(violations)]
}

function isValidClient(client: UsageClientWire): boolean {
    const sanitized = sanitizeUsageClient(client)
    return sanitized !== undefined && Object.keys(sanitized).length === Object.keys(client).length
}

/** UTF-8 size of the encoded body, which is the bound the service enforces. */
export function usageBodyByteLength(body: UsageBodyWire): number {
    return new TextEncoder().encode(JSON.stringify(body)).byteLength
}

/** Whether the body fits the wire byte bound. */
export function isUsageBodyWithinByteLimit(body: UsageBodyWire): boolean {
    return usageBodyByteLength(body) <= USAGE_BODY_LIMIT_BYTES
}

/**
 * Whether a fact holds nothing worth sending.
 *
 * A zero fact is not harmless: the service drops it, and sending it would spend
 * bytes and a fact slot on a claim nobody made.
 */
export function isEmptyFact(fact: UsageFactWire): boolean {
    const requests = fact.requests
    const tokens = fact.tokens
    return (
        requests.completed + requests.cancelled + requests.failed === 0 &&
        tokens.input + tokens.output + tokens.cache_read + tokens.cache_write === 0 &&
        fact.duration_ms.count === 0 &&
        fact.retries === 0 &&
        (fact.tools === undefined || isEmptyTools(fact.tools)) &&
        (fact.todos === undefined || isEmptyTodos(fact.todos)) &&
        (fact.task_attempts === undefined || isEmptyTaskAttempts(fact.task_attempts))
    )
}

/** Remaining capacity before the caller must seal the current accumulator. */
export function remainingFactCapacity(factCount: number): number {
    return Math.max(0, USAGE_MAX_FACTS - factCount)
}

/**
 * A zero-valued summary for a kind of sample that has none.
 *
 * Re-exported so producers do not construct an ad-hoc empty shape that the
 * reader would then reject as inconsistent.
 */
export const EMPTY_USAGE_SUMMARY = EMPTY_EXECUTION_SUMMARY

/** Exposed so a producer can check a tool name against the same pattern the reader uses. */
export const isUsageToolName = isRegisteredToolName

export type { UsageTaskAttemptsWire, UsageTodosWire, UsageToolsWire }
export { isOutcomeCounts, MAX_TOOL_NAMES_PER_FACT, TOOL_OUTCOMES }
