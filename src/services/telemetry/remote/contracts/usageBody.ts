/** Canonical schema 4 `/usage` request body and validation. */

import type { AttemptBucket, AttemptDistribution, AttemptFactAggregate } from "../usage/attemptBucket"
import type { UsageGrantContract } from "./deviceGrant"
import {
    EMPTY_EXECUTION_SUMMARY,
    isCount,
    isOutcomeCounts,
    isRegisteredToolName,
    MAX_TOOL_NAMES_PER_FACT,
    TOOL_OUTCOMES,
    type UsageTaskAttemptsWire,
    type UsageTodosWire,
    type UsageToolsWire,
    validateTaskAttempts,
    validateTools,
} from "./usageExecution"

export const USAGE_BODY_LIMIT_BYTES = 64 * 1024
export const USAGE_SECOND_MS = 1_000
export const USAGE_MINUTE_MS = 60_000

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

export interface UsageClientWire {
    readonly version: string
    readonly platform?: string
    readonly architecture?: string
    readonly host_version?: string
    readonly host_editor?: UsageHostEditor
    readonly channel?: UsageReleaseChannel
    readonly is_dev?: boolean
}

export const USAGE_ATTEMPT_SCHEMA_VERSION = 4 as const

export interface UsageAttemptLogicalExecutionWire {
    readonly logical_requests: {
        readonly completed: number
        readonly failed: number
        readonly cancelled: number
        readonly aborted: number
    }
    readonly turn_duration_ms: UsageSummaryWire
    readonly tools?: UsageToolsWire
    readonly task_attempts: UsageTaskAttemptsWire
}

export interface UsageAttemptFactWire {
    readonly role: "task" | "subagent" | "compaction" | "reviewer" | "other"
    readonly provider: string
    readonly model_id: string
    readonly thinking: string | number
    readonly requests: {
        readonly completed: number
        readonly failed: number
        readonly cancelled: number
        readonly aborted: number
    }
    readonly tokens: {
        readonly input: number
        readonly output: number
        readonly cache_read: number
        readonly cache_write: number
        readonly reasoning: number
    }
    readonly token_coverage: { readonly reported: number; readonly unreported: number }
    readonly generation_output_tokens: number
    readonly duration_ms: UsageDistributionWire
    readonly errors: Readonly<Record<string, number>>
    readonly logical_execution?: UsageAttemptLogicalExecutionWire
}

export interface UsageAttemptBucketWire {
    readonly bucket_id: string
    readonly policy_epoch: number
    readonly event_window: {
        readonly started_at: number
        readonly ended_at: number
        readonly first_attempt_at: number
        readonly last_attempt_at: number
        readonly sealed_at: number
    }
    readonly duration_ms: number
    readonly sessions_started: number
    readonly facts: readonly UsageAttemptFactWire[]
}

export interface UsageAttemptBodyWire {
    readonly schema_version: typeof USAGE_ATTEMPT_SCHEMA_VERSION
    readonly client: UsageClientWire
    readonly buckets: readonly UsageAttemptBucketWire[]
}

export type UsageAttemptBodyViolation =
    | "schema_version"
    | "client"
    | "buckets"
    | "facts"
    | "logical_execution"
    | "tool_rows"
    | "body_size"
    | "write_rows"

export interface UsageAttemptBodyValidation {
    readonly contract: UsageGrantContract
    /** Shared client/server estimator owned by the schema 4 storage contract; never guess from a client-only formula. */
    readonly estimateWriteRows: (body: UsageAttemptBodyWire) => number
}

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
    if (![sum, min, max].every(isCount)) return false
    const [total, low, high] = [sum, min, max] as number[]
    return low <= high && low * count <= total && total <= high * count
}

export function isConsistentDistribution(value: unknown): value is UsageDistributionWire {
    if (!isConsistentSummary(value)) return false
    const buckets = (value as { buckets?: unknown }).buckets
    if (!Array.isArray(buckets) || buckets.length !== USAGE_HISTOGRAM_BUCKETS || !buckets.every(isCount)) return false
    return buckets.reduce((total: number, count: number) => total + count, 0) === value.count
}

function isValidClient(client: UsageClientWire): boolean {
    const sanitized = sanitizeUsageClient(client)
    return sanitized !== undefined && Object.keys(sanitized).length === Object.keys(client).length
}

/** Build canonical schema 4 wire facts from immutable, already validated sealed buckets. */
export function buildUsageAttemptBody(buckets: readonly AttemptBucket[], client: UsageClientWire): UsageAttemptBodyWire {
    return {
        schema_version: USAGE_ATTEMPT_SCHEMA_VERSION,
        client,
        buckets: buckets.map((bucket) => {
            if (bucket.sealedAt === undefined) throw new Error("Usage attempt request requires sealed buckets")
            return {
                bucket_id: bucket.bucketId,
                policy_epoch: bucket.policyGeneration,
                event_window: {
                    started_at: bucket.windowStartedAt,
                    ended_at: bucket.windowEndedAt,
                    first_attempt_at: bucket.firstAttemptAt,
                    last_attempt_at: bucket.lastAttemptAt,
                    sealed_at: bucket.sealedAt,
                },
                duration_ms: bucket.durationMs,
                sessions_started: bucket.sessionsStarted,
                facts: [...bucket.facts].sort(compareAttemptFacts).map(toAttemptFactWire),
            }
        }),
    }
}

/** Current schema 4 storage-row model; the server must use the same function when its tables are implemented. */
export function estimateUsageWriteRowsV4(body: UsageAttemptBodyWire): number {
    let factRows = 0
    let executionRows = 0
    let toolRows = 0
    for (const bucket of body.buckets) {
        if (!Array.isArray(bucket.facts)) throw new Error("Usage schema 4 bucket facts are invalid")
        for (const fact of bucket.facts) {
            factRows = checkedUsageAdd(factRows, 1, "fact rows")
            if (!fact.logical_execution) continue
            executionRows = checkedUsageAdd(executionRows, 1, "execution rows")
            toolRows = checkedUsageAdd(toolRows, Object.keys(fact.logical_execution.tools?.by_name ?? {}).length, "tool rows")
        }
    }
    // Reservation/quota/request/bucket accounting is six fixed rows. Every fact
    // writes its canonical row and facet row; execution and named tools are child rows.
    return [6, factRows, factRows, executionRows, toolRows].reduce((sum, value) => checkedUsageAdd(sum, value, "write rows"), 0)
}

export function validateUsageAttemptBody(
    body: UsageAttemptBodyWire,
    validation: UsageAttemptBodyValidation,
): UsageAttemptBodyViolation[] {
    const violations: UsageAttemptBodyViolation[] = []
    const { contract } = validation
    if (body.schema_version !== USAGE_ATTEMPT_SCHEMA_VERSION) violations.push("schema_version")
    if (!isRecord(body.client) || !isValidClient(body.client)) violations.push("client")
    if (!Array.isArray(body.buckets) || body.buckets.length < 1 || body.buckets.length > contract.maxBuckets) {
        violations.push("buckets")
    }

    let factCount = 0
    let toolRows = 0
    if (Array.isArray(body.buckets)) {
        for (const bucket of body.buckets) {
            const result = validateAttemptBucketWire(bucket)
            violations.push(...result.violations)
            factCount = addOrInvalidate(factCount, result.factCount, violations, "facts")
            toolRows = addOrInvalidate(toolRows, result.toolRows, violations, "tool_rows")
        }
    }
    if (factCount > contract.maxFacts) violations.push("facts")
    if (toolRows > contract.maxToolRows) violations.push("tool_rows")

    try {
        const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength
        if (bytes > contract.maxBodyBytes || bytes > USAGE_BODY_LIMIT_BYTES) violations.push("body_size")
    } catch {
        violations.push("body_size")
    }
    try {
        const writeRows = validation.estimateWriteRows(body)
        if (!Number.isSafeInteger(writeRows) || writeRows < 0 || writeRows > contract.maxWriteRows) violations.push("write_rows")
    } catch {
        violations.push("write_rows")
    }
    return [...new Set(violations)]
}

function validateAttemptBucketWire(bucket: UsageAttemptBucketWire): {
    readonly violations: UsageAttemptBodyViolation[]
    readonly factCount: number
    readonly toolRows: number
} {
    const violations: UsageAttemptBodyViolation[] = []
    if (!isRecord(bucket)) return { violations: ["buckets"], factCount: 0, toolRows: 0 }
    if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(bucket.bucket_id) || !isCount(bucket.policy_epoch) || !isCount(bucket.duration_ms)) {
        violations.push("buckets")
    }
    if (!isCount(bucket.sessions_started)) violations.push("buckets")
    const window = bucket.event_window
    if (
        !isRecord(window) ||
        ![window.started_at, window.ended_at, window.first_attempt_at, window.last_attempt_at, window.sealed_at].every(isCount) ||
        window.ended_at <= window.started_at ||
        window.first_attempt_at < window.started_at ||
        window.last_attempt_at < window.first_attempt_at ||
        window.last_attempt_at >= window.ended_at ||
        window.sealed_at < window.last_attempt_at
    ) {
        violations.push("buckets")
    }
    if (!Array.isArray(bucket.facts)) return { violations: [...violations, "facts"], factCount: 0, toolRows: 0 }
    if (bucket.facts.length === 0 && bucket.sessions_started === 0) violations.push("facts")

    let duration = 0
    let toolRows = 0
    for (const fact of bucket.facts) {
        const result = validateAttemptFactWire(fact)
        violations.push(...result.violations)
        duration = addOrInvalidate(duration, result.durationMs, violations, "facts")
        toolRows = addOrInvalidate(toolRows, result.toolRows, violations, "tool_rows")
    }
    if (isCount(bucket.duration_ms) && duration !== bucket.duration_ms) violations.push("facts")
    return { violations, factCount: bucket.facts.length, toolRows }
}

function validateAttemptFactWire(fact: UsageAttemptFactWire): {
    readonly violations: UsageAttemptBodyViolation[]
    readonly durationMs: number
    readonly toolRows: number
} {
    const violations: UsageAttemptBodyViolation[] = []
    if (!isRecord(fact) || !isValidAttemptFactIdentity(fact)) {
        return { violations: ["facts"], durationMs: 0, toolRows: 0 }
    }
    const requestTotal = attemptRequestTotal(fact.requests)
    if (requestTotal === undefined || requestTotal < 1) violations.push("facts")
    const tokens = fact.tokens
    if (
        !isRecord(tokens) ||
        ![tokens.input, tokens.output, tokens.cache_read, tokens.cache_write, tokens.reasoning].every(isCount) ||
        (isCount(tokens.reasoning) && isCount(tokens.output) && tokens.reasoning > tokens.output)
    ) {
        violations.push("facts")
    }
    const coverage = fact.token_coverage
    if (
        !isRecord(coverage) ||
        !isCount(coverage.reported) ||
        !isCount(coverage.unreported) ||
        requestTotal === undefined ||
        coverage.reported + coverage.unreported !== requestTotal
    ) {
        violations.push("facts")
    }
    if (!isCount(fact.generation_output_tokens)) violations.push("facts")
    if (!isConsistentDistribution(fact.duration_ms) || fact.duration_ms.count !== requestTotal) violations.push("facts")
    if (
        !isRecord(fact.errors) ||
        Object.entries(fact.errors).some(([name, value]) => !/^[a-z][a-z0-9_]{0,31}$/u.test(name) || !isCount(value))
    ) {
        violations.push("facts")
    }

    let toolRows = 0
    if (fact.logical_execution !== undefined) {
        const logical = validateAttemptLogicalExecutionWire(fact.logical_execution, requestTotal)
        if (!logical.valid) violations.push("logical_execution")
        toolRows = logical.toolRows
    }
    return {
        violations,
        durationMs: isConsistentDistribution(fact.duration_ms) ? fact.duration_ms.sum : 0,
        toolRows,
    }
}

function validateAttemptLogicalExecutionWire(
    execution: UsageAttemptLogicalExecutionWire,
    providerRequestTotal: number | undefined,
): { readonly valid: boolean; readonly toolRows: number } {
    if (!isRecord(execution)) return { valid: false, toolRows: 0 }
    const logicalTotal = attemptRequestTotal(execution.logical_requests)
    if (
        logicalTotal === undefined ||
        logicalTotal < 1 ||
        (providerRequestTotal !== undefined && logicalTotal > providerRequestTotal)
    ) {
        return { valid: false, toolRows: 0 }
    }
    if (!isConsistentSummary(execution.turn_duration_ms) || execution.turn_duration_ms.count !== logicalTotal) {
        return { valid: false, toolRows: 0 }
    }
    if (validateTaskAttempts(execution.task_attempts).length > 0 || execution.task_attempts.count !== logicalTotal) {
        return { valid: false, toolRows: 0 }
    }
    if (execution.tools === undefined) return { valid: true, toolRows: 0 }
    if (validateTools(execution.tools).length > 0) return { valid: false, toolRows: 0 }
    const toolTotal = TOOL_OUTCOMES.reduce((sum, outcome) => sum + execution.tools![outcome], 0)
    if (!Number.isSafeInteger(toolTotal) || toolTotal < 1) return { valid: false, toolRows: 0 }
    return { valid: true, toolRows: Object.keys(execution.tools.by_name ?? {}).length }
}

function attemptRequestTotal(value: unknown): number | undefined {
    if (!isRecord(value)) return undefined
    const keys = ["completed", "failed", "cancelled", "aborted"] as const
    if (!keys.every((key) => isCount(value[key]))) return undefined
    const total = keys.reduce((sum, key) => sum + (value[key] as number), 0)
    return Number.isSafeInteger(total) ? total : undefined
}

function isValidAttemptFactIdentity(fact: UsageAttemptFactWire): boolean {
    if (!(USAGE_ATTEMPT_ROLES as readonly unknown[]).includes(fact.role)) return false
    if (typeof fact.provider !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(fact.provider)) return false
    if (
        typeof fact.model_id !== "string" ||
        !/^(?:catalog:[a-z0-9][a-z0-9_.:/-]{0,95}|state:(?:private|unknown))$/u.test(fact.model_id)
    ) {
        return false
    }
    return (
        (typeof fact.thinking === "number" &&
            Number.isSafeInteger(fact.thinking) &&
            !Object.is(fact.thinking, -0) &&
            (fact.thinking === -1 || fact.thinking >= 0)) ||
        (typeof fact.thinking === "string" &&
            /^(?:level:[a-z0-9_.-]{1,32}|state:(?:enabled|disabled|off|dynamic|default|unknown))$/u.test(fact.thinking))
    )
}

function addOrInvalidate(
    left: number,
    right: number,
    violations: UsageAttemptBodyViolation[],
    violation: UsageAttemptBodyViolation,
): number {
    const total = left + right
    if (!Number.isSafeInteger(total) || total < 0) {
        violations.push(violation)
        return left
    }
    return total
}

function checkedUsageAdd(left: number, right: number, label: string): number {
    const total = left + right
    if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Usage schema 4 ${label} overflow`)
    return total
}

const USAGE_ATTEMPT_ROLES = ["task", "subagent", "compaction", "reviewer", "other"] as const

function toAttemptFactWire(fact: AttemptFactAggregate): UsageAttemptFactWire {
    return {
        role: fact.identity.role,
        provider: fact.identity.provider,
        model_id: fact.identity.modelId,
        thinking: fact.identity.thinking,
        requests: fact.requests,
        tokens: {
            input: fact.tokens.input,
            output: fact.tokens.output,
            cache_read: fact.tokens.cacheRead,
            cache_write: fact.tokens.cacheWrite,
            reasoning: fact.tokens.reasoning,
        },
        token_coverage: fact.tokenCoverage,
        generation_output_tokens: fact.generationOutputTokens,
        duration_ms: toAttemptDistributionWire(fact.duration),
        errors: fact.errors,
        ...(fact.logicalExecution
            ? {
                  logical_execution: {
                      logical_requests: fact.logicalExecution.logicalRequests,
                      turn_duration_ms: fact.logicalExecution.turnDurationMs,
                      ...(fact.logicalExecution.tools ? { tools: fact.logicalExecution.tools } : {}),
                      task_attempts: fact.logicalExecution.taskAttempts,
                  },
              }
            : {}),
    }
}

function toAttemptDistributionWire(distribution: AttemptDistribution): UsageDistributionWire {
    return {
        count: distribution.count,
        sum: distribution.sum,
        min: distribution.min,
        max: distribution.max,
        buckets: distribution.buckets,
    }
}

function compareAttemptFacts(left: AttemptFactAggregate, right: AttemptFactAggregate): number {
    return JSON.stringify([
        left.identity.role,
        left.identity.provider,
        left.identity.modelId,
        left.identity.thinking,
    ]).localeCompare(
        JSON.stringify([right.identity.role, right.identity.provider, right.identity.modelId, right.identity.thinking]),
    )
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
