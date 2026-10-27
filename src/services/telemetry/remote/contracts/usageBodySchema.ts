/**
 * Usage schema 5 request body under contract revision 1 (usage-contract §1.1).
 *
 * This module is the client's single reading of the wire body: structural and
 * conservation validation, the semantic array order that precedes RFC 8785
 * canonicalization, and the logical write-row cost. It validates untrusted JSON
 * so a client defect is caught before an immutable request manifest exists.
 *
 * Violations carry the server's stable rejection code and contract path, plus a
 * client rule identifier that names the violated invariant.
 */

import { canonicalJsonBytes, compareUtf16 } from "./canonicalJson"
import { isUsageModelId } from "./modelIdentity"
import { isUsageThinking } from "./thinking"
import { isCount, validateTaskAttempts, validateTodos, validateTools } from "./usageExecution"

/** Usage schema the client speaks; `/usage` and every `/auth/*` request also name it in `X-Dline-Contract`. */
export const USAGE_SCHEMA_VERSION = 5
/** Lowest revision of {@link USAGE_SCHEMA_VERSION} this client implements; a later revision only adds compatible extensions. */
export const USAGE_CONTRACT_REVISION = 1
export const USAGE_EVENT_WINDOW_MS = 600_000
export const USAGE_DURATION_BUCKET_THRESHOLD_MS = 60_000
/** Upper bounds of every latency histogram; the last bucket counts values above the final bound. */
export const USAGE_HISTOGRAM_BOUNDS_MS: readonly number[] = [250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000]
export const USAGE_HISTOGRAM_BUCKETS = USAGE_HISTOGRAM_BOUNDS_MS.length + 1

export const USAGE_ROLES = ["task", "subagent", "compaction", "reviewer", "other"] as const
export type UsageRole = (typeof USAGE_ROLES)[number]
export const USAGE_FAILURE_CLASSES = [
    "authentication",
    "rate_limited",
    "timeout",
    "network",
    "provider_rejected",
    "provider_unavailable",
    "invalid_response",
    "unknown",
] as const
export type UsageFailureClass = (typeof USAGE_FAILURE_CLASSES)[number]
export const USAGE_RELEASE_CHANNELS = ["stable", "pre-release", "insiders"] as const
export type UsageReleaseChannel = (typeof USAGE_RELEASE_CHANNELS)[number]
export const USAGE_HOST_EDITORS = ["vscode", "cursor", "vscodium", "windsurf", "other"] as const
export type UsageHostEditor = (typeof USAGE_HOST_EDITORS)[number]

export interface UsageBodyLimits {
    readonly maxBodyBytes: number
    readonly maxBuckets: number
    readonly maxFacts: number
    readonly maxToolRows: number
    readonly maxWriteRows: number
}

/** Schema 5 ceilings; a grant can lower them but never raise them. */
export const USAGE_HARD_LIMITS: UsageBodyLimits = {
    maxBodyBytes: 65_536,
    maxBuckets: 8,
    maxFacts: 32,
    maxToolRows: 384,
    maxWriteRows: 486,
}
export const USAGE_MAX_NAMED_TOOLS_PER_FACT = 12

export type UsageRejectCode =
    | "invalid_schema"
    | "invalid_usage_body"
    | "invalid_coverage"
    | "write_budget_exceeded"
    | "payload_too_large"

export type UsageBodyRule =
    | "field"
    | "capacity"
    | "body_size"
    | "write_budget"
    | "duplicate_bucket"
    | "duplicate_fact"
    | "event_window"
    | "bucket_duration"
    | "sessions"
    | "request_total"
    | "reasoning_within_output"
    | "token_coverage_total"
    | "generation_coverage_total"
    | "generation_coverage_count"
    | "generation_requires_tokens"
    | "generation_within_output"
    | "logical_coverage_total"
    | "logical_coverage"
    | "task_attempts_count"
    | "turn_duration_count"
    | "tools"
    | "todos"
    | "distribution"
    | "duration_count"
    | "duration_minimum"
    | "ttft_count"
    | "error_conservation"

export interface UsageBodyViolation {
    readonly code: UsageRejectCode
    readonly rule: UsageBodyRule
    readonly path: string
}

export interface UsageBodyValidationOptions {
    readonly limits: UsageBodyLimits
    /** Version in the request User-Agent; `client.version` must equal it exactly. */
    readonly clientVersion: string
}

const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/u
const CLIENT_FIELD_PATTERN = /^[A-Za-z0-9_.+ -]{1,64}$/u
const BUCKET_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u
const FAILURE_CLASS_PATTERN = /^[a-z][a-z0-9_.-]{0,31}$/u
const OUTCOMES = ["completed", "failed", "cancelled", "aborted"] as const

const BODY_KEYS = ["schema_version", "client", "buckets"]
const CLIENT_KEYS = ["version", "platform", "architecture", "host_version", "host_editor", "channel", "is_dev"]
const BUCKET_KEYS = ["bucket_id", "policy_epoch", "event_window", "duration_ms", "sessions_started", "facts"]
const WINDOW_KEYS = ["started_at", "ended_at", "first_attempt_at", "last_attempt_at", "sealed_at"]
const FACT_KEYS = [
    "role",
    "provider",
    "model_id",
    "thinking",
    "requests",
    "tokens",
    "token_coverage",
    "generation_coverage",
    "logical_execution_coverage",
    "generation_output_tokens",
    "duration_ms",
    "ttft_ms",
    "generation_ms",
    "errors",
    "logical_execution",
]
const TOKEN_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"]
const COVERAGE_KEYS = ["reported", "unreported"]
const SUMMARY_KEYS = ["count", "sum", "min", "max"]
const DISTRIBUTION_KEYS = [...SUMMARY_KEYS, "buckets"]
const LOGICAL_KEYS = ["logical_requests", "turn_duration_ms", "tools", "task_attempts", "todos"]

type JsonRecord = Record<string, unknown>

export function effectiveUsageLimits(limits: UsageBodyLimits): UsageBodyLimits {
    return {
        maxBodyBytes: Math.min(limits.maxBodyBytes, USAGE_HARD_LIMITS.maxBodyBytes),
        maxBuckets: Math.min(limits.maxBuckets, USAGE_HARD_LIMITS.maxBuckets),
        maxFacts: Math.min(limits.maxFacts, USAGE_HARD_LIMITS.maxFacts),
        maxToolRows: Math.min(limits.maxToolRows, USAGE_HARD_LIMITS.maxToolRows),
        maxWriteRows: Math.min(limits.maxWriteRows, USAGE_HARD_LIMITS.maxWriteRows),
    }
}

/** Every violation of the body; an empty list means the server contract accepts it. */
export function validateUsageBodySchema(body: unknown, options: UsageBodyValidationOptions): UsageBodyViolation[] {
    const violations = new ViolationList()
    if (!isRecord(body)) {
        violations.add("", "field", "invalid_schema")
        return violations.list
    }
    const limits = effectiveUsageLimits(options.limits)
    rejectUnknownKeys(body, BODY_KEYS, "", violations)
    if (body.schema_version !== USAGE_SCHEMA_VERSION) violations.add("schema_version", "field", "invalid_schema")
    validateClient(body.client, options.clientVersion, violations)
    validateBuckets(body.buckets, limits, violations)
    if (violations.list.length > 0) return violations.list

    if (canonicalUsageBodyBytes(body).byteLength > limits.maxBodyBytes) violations.add("", "body_size", "payload_too_large")
    if (estimateUsageWriteRows(body) > limits.maxWriteRows) violations.add("", "write_budget", "write_budget_exceeded")
    return violations.list
}

/** Logical write cost shared with the server: `6 + 2 × facts + execution rows + named-tool rows`. */
export function estimateUsageWriteRows(body: unknown): number {
    let rows = 6
    for (const bucket of arrayOf(isRecord(body) ? body.buckets : undefined)) {
        for (const fact of arrayOf(isRecord(bucket) ? bucket.facts : undefined)) {
            rows += 2
            const execution = isRecord(fact) ? fact.logical_execution : undefined
            if (!isRecord(execution)) continue
            rows += 1 + namedToolCount(execution)
        }
    }
    return rows
}

/** Fix the semantic array order (buckets by ID, facts by joint identity) that precedes canonicalization. */
export function orderUsageBody<T>(body: T): T {
    if (!isRecord(body) || !Array.isArray(body.buckets)) return body
    const buckets = body.buckets
        .map((bucket) =>
            isRecord(bucket) && Array.isArray(bucket.facts) ? { ...bucket, facts: [...bucket.facts].sort(compareFacts) } : bucket,
        )
        .sort((left, right) =>
            compareUtf16(stringOf(isRecord(left) ? left.bucket_id : ""), stringOf(isRecord(right) ? right.bucket_id : "")),
        )
    return { ...body, buckets } as T
}

export function canonicalUsageBodyBytes(body: unknown): Uint8Array {
    return canonicalJsonBytes(orderUsageBody(body))
}

class ViolationList {
    readonly list: UsageBodyViolation[] = []

    add(path: string, rule: UsageBodyRule, code: UsageRejectCode = "invalid_usage_body"): void {
        this.list.push({ code, rule, path })
    }
}

function validateClient(client: unknown, clientVersion: string, violations: ViolationList): void {
    if (!isRecord(client)) {
        violations.add("client", "field")
        return
    }
    rejectUnknownKeys(client, CLIENT_KEYS, "client", violations)
    if (typeof client.version !== "string" || !CLIENT_VERSION_PATTERN.test(client.version) || client.version !== clientVersion) {
        violations.add("client.version", "field")
    }
    for (const key of ["platform", "architecture", "host_version"] as const) {
        const value = client[key]
        if (value !== undefined && (typeof value !== "string" || !CLIENT_FIELD_PATTERN.test(value))) {
            violations.add(`client.${key}`, "field")
        }
    }
    if (client.host_editor !== undefined && !includes(USAGE_HOST_EDITORS, client.host_editor))
        violations.add("client.host_editor", "field")
    if (client.channel !== undefined && !includes(USAGE_RELEASE_CHANNELS, client.channel))
        violations.add("client.channel", "field")
    if (client.is_dev !== undefined && typeof client.is_dev !== "boolean") violations.add("client.is_dev", "field")
}

function validateBuckets(buckets: unknown, limits: UsageBodyLimits, violations: ViolationList): void {
    if (!Array.isArray(buckets) || buckets.length === 0) {
        violations.add("buckets", "field")
        return
    }
    if (buckets.length > limits.maxBuckets) violations.add("buckets", "capacity")
    const bucketIds = new Set<string>()
    let facts = 0
    let toolRows = 0
    buckets.forEach((bucket, index) => {
        const location = `buckets[${index}]`
        const id = isRecord(bucket) ? bucket.bucket_id : undefined
        if (typeof id === "string" && bucketIds.has(id)) violations.add(`${location}.bucket_id`, "duplicate_bucket")
        if (typeof id === "string") bucketIds.add(id)
        const counts = validateBucket(bucket, location, violations)
        facts += counts.facts
        toolRows += counts.toolRows
    })
    if (facts > limits.maxFacts || toolRows > limits.maxToolRows) violations.add("buckets", "capacity")
}

function validateBucket(bucket: unknown, location: string, violations: ViolationList): { facts: number; toolRows: number } {
    if (!isRecord(bucket)) {
        violations.add(location, "field")
        return { facts: 0, toolRows: 0 }
    }
    rejectUnknownKeys(bucket, BUCKET_KEYS, location, violations)
    if (typeof bucket.bucket_id !== "string" || !BUCKET_ID_PATTERN.test(bucket.bucket_id))
        violations.add(`${location}.bucket_id`, "field")
    if (!isCount(bucket.policy_epoch)) violations.add(`${location}.policy_epoch`, "field")
    validateEventWindow(bucket.event_window, `${location}.event_window`, violations)
    if (!Array.isArray(bucket.facts) || bucket.facts.length === 0) {
        violations.add(`${location}.facts`, "field")
        return { facts: 0, toolRows: 0 }
    }

    const identities = new Set<string>()
    let duration: number | undefined = 0
    let attempts: number | undefined = 0
    let toolRows = 0
    bucket.facts.forEach((fact, index) => {
        const factLocation = `${location}.facts[${index}]`
        const result = validateFact(fact, factLocation, violations)
        if (result.identity !== undefined) {
            if (identities.has(result.identity)) violations.add(factLocation, "duplicate_fact")
            identities.add(result.identity)
        }
        duration = checkedSum(duration, result.durationMs)
        attempts = checkedSum(attempts, result.attempts)
        toolRows += result.toolRows
    })
    if (!isCount(bucket.duration_ms)) violations.add(`${location}.duration_ms`, "field")
    else if (duration !== undefined && duration !== bucket.duration_ms)
        violations.add(`${location}.duration_ms`, "bucket_duration")
    if (!isCount(bucket.sessions_started)) violations.add(`${location}.sessions_started`, "field")
    else if (attempts !== undefined && bucket.sessions_started > attempts)
        violations.add(`${location}.sessions_started`, "sessions")
    return { facts: bucket.facts.length, toolRows }
}

function validateEventWindow(window: unknown, location: string, violations: ViolationList): void {
    if (!isRecord(window) || !WINDOW_KEYS.every((key) => isCount(window[key]))) {
        violations.add(location, "field")
        return
    }
    rejectUnknownKeys(window, WINDOW_KEYS, location, violations)
    const { started_at, ended_at, first_attempt_at, last_attempt_at, sealed_at } = window as Record<string, number>
    const aligned = started_at % USAGE_EVENT_WINDOW_MS === 0 && ended_at === started_at + USAGE_EVENT_WINDOW_MS
    const ordered = started_at <= first_attempt_at && first_attempt_at <= last_attempt_at && last_attempt_at < ended_at
    if (!aligned || !ordered || sealed_at < last_attempt_at) violations.add(location, "event_window")
}

interface FactResult {
    readonly identity?: string
    readonly durationMs?: number
    readonly attempts?: number
    readonly toolRows: number
}

function validateFact(fact: unknown, location: string, violations: ViolationList): FactResult {
    if (!isRecord(fact)) {
        violations.add(location, "field")
        return { toolRows: 0 }
    }
    rejectUnknownKeys(fact, FACT_KEYS, location, violations)
    const identityValid = validateIdentity(fact, location, violations)
    const total = outcomeTotal(fact.requests)
    if (total === undefined) violations.add(`${location}.requests`, "field")
    else if (total < 1) violations.add(`${location}.requests`, "request_total")

    const tokens = validateTokens(fact.tokens, `${location}.tokens`, violations)
    const tokenCoverage = coverageOf(fact.token_coverage, `${location}.token_coverage`, violations)
    if (tokenCoverage && total !== undefined && tokenCoverage.reported + tokenCoverage.unreported !== total) {
        violations.add(`${location}.token_coverage`, "token_coverage_total")
    }
    validateGeneration(fact, location, total, tokens, tokenCoverage, violations)
    const durationMs = validateDuration(fact.duration_ms, `${location}.duration_ms`, total, violations)
    if (fact.ttft_ms !== undefined) {
        if (!isDistribution(fact.ttft_ms)) violations.add(`${location}.ttft_ms`, "distribution")
        else if (total !== undefined && fact.ttft_ms.count > total) violations.add(`${location}.ttft_ms`, "ttft_count")
    }
    validateErrors(fact.errors, `${location}.errors`, fact.requests, violations)
    const toolRows = validateLogicalExecution(fact, location, total, violations)

    return {
        identity: identityValid ? JSON.stringify([fact.role, fact.provider, fact.model_id, fact.thinking]) : undefined,
        durationMs,
        attempts: total,
        toolRows,
    }
}

function validateIdentity(fact: JsonRecord, location: string, violations: ViolationList): boolean {
    let valid = true
    const check = (key: string, accepted: boolean) => {
        if (accepted) return
        violations.add(`${location}.${key}`, "field")
        valid = false
    }
    check("role", includes(USAGE_ROLES, fact.role))
    check("provider", typeof fact.provider === "string" && PROVIDER_PATTERN.test(fact.provider))
    check("model_id", isUsageModelId(fact.model_id))
    check("thinking", isUsageThinking(fact.thinking))
    return valid
}

function validateTokens(tokens: unknown, location: string, violations: ViolationList): JsonRecord | undefined {
    if (!isRecord(tokens) || !TOKEN_KEYS.every((key) => isCount(tokens[key]))) {
        violations.add(location, "field")
        return undefined
    }
    rejectUnknownKeys(tokens, TOKEN_KEYS, location, violations)
    if ((tokens.reasoning as number) > (tokens.output as number))
        violations.add(`${location}.reasoning`, "reasoning_within_output")
    return tokens
}

function validateGeneration(
    fact: JsonRecord,
    location: string,
    total: number | undefined,
    tokens: JsonRecord | undefined,
    tokenCoverage: Coverage | undefined,
    violations: ViolationList,
): void {
    const coverage = coverageOf(fact.generation_coverage, `${location}.generation_coverage`, violations)
    if (coverage && total !== undefined && coverage.reported + coverage.unreported !== total) {
        violations.add(`${location}.generation_coverage`, "generation_coverage_total")
    }
    const timing = fact.generation_ms
    if (timing !== undefined && !isDistribution(timing)) violations.add(`${location}.generation_ms`, "distribution")
    const timedCount = isDistribution(timing) ? timing.count : 0
    const outputTokens = fact.generation_output_tokens
    if (!isCount(outputTokens)) violations.add(`${location}.generation_output_tokens`, "field")
    if (coverage) {
        // Timing and output exist only together, for exactly the reported subset.
        const unpaired = coverage.reported === 0 && isCount(outputTokens) && outputTokens > 0
        if (timedCount !== coverage.reported || unpaired)
            violations.add(`${location}.generation_ms`, "generation_coverage_count", "invalid_coverage")
    }
    if (tokenCoverage && Math.max(coverage?.reported ?? 0, timedCount) > tokenCoverage.reported) {
        violations.add(`${location}.generation_coverage`, "generation_requires_tokens")
    }
    if (tokens && isCount(outputTokens) && outputTokens > (tokens.output as number)) {
        violations.add(`${location}.generation_output_tokens`, "generation_within_output")
    }
}

/** Count and minimum are checked even when the histogram is inconsistent, so each broken invariant is named. */
function validateDuration(
    duration: unknown,
    location: string,
    total: number | undefined,
    violations: ViolationList,
): number | undefined {
    if (!isRecord(duration)) {
        violations.add(location, "field")
        return undefined
    }
    const consistent = isDistribution(duration)
    if (!consistent) violations.add(location, "distribution")
    if (isCount(duration.count) && total !== undefined && duration.count !== total) violations.add(location, "duration_count")
    if (isCount(duration.min) && duration.min < 1) violations.add(location, "duration_minimum")
    return consistent ? duration.sum : undefined
}

function validateErrors(errors: unknown, location: string, requests: unknown, violations: ViolationList): void {
    if (
        !isRecord(errors) ||
        Object.entries(errors).some(([name, count]) => !FAILURE_CLASS_PATTERN.test(name) || !isCount(count) || count < 1)
    ) {
        violations.add(location, "field")
        return
    }
    const failed = isRecord(requests) ? requests.failed : undefined
    const sum = checkedSum(0, ...(Object.values(errors) as number[]))
    if (isCount(failed) && sum !== failed) violations.add(location, "error_conservation")
}

/** Returns the named-tool rows of the fact. */
function validateLogicalExecution(
    fact: JsonRecord,
    location: string,
    total: number | undefined,
    violations: ViolationList,
): number {
    const coverage = coverageOf(fact.logical_execution_coverage, `${location}.logical_execution_coverage`, violations)
    if (coverage && total !== undefined && coverage.reported + coverage.unreported > total) {
        violations.add(`${location}.logical_execution_coverage`, "logical_coverage_total")
    }
    const execution = fact.logical_execution
    if (execution === undefined) {
        if (coverage && coverage.reported !== 0) violations.add(`${location}.logical_execution_coverage`, "logical_coverage")
        return 0
    }
    const executionLocation = `${location}.logical_execution`
    if (!isRecord(execution)) {
        violations.add(executionLocation, "field")
        return 0
    }
    rejectUnknownKeys(execution, LOGICAL_KEYS, executionLocation, violations)
    const logicalTotal = outcomeTotal(execution.logical_requests)
    if (logicalTotal === undefined || logicalTotal < 1) violations.add(`${executionLocation}.logical_requests`, "field")
    if (coverage && logicalTotal !== undefined && logicalTotal !== coverage.reported) {
        violations.add(`${location}.logical_execution_coverage`, "logical_coverage")
    }
    const turn = execution.turn_duration_ms
    if (!isSummary(turn)) violations.add(`${executionLocation}.turn_duration_ms`, "distribution")
    else if (logicalTotal !== undefined && turn.count !== logicalTotal)
        violations.add(`${executionLocation}.turn_duration_ms`, "turn_duration_count")

    const attempts = execution.task_attempts
    if (!isRecord(attempts) || validateTaskAttempts(attempts as never).length > 0)
        violations.add(`${executionLocation}.task_attempts`, "field")
    if (isRecord(attempts) && isCount(attempts.count) && logicalTotal !== undefined && attempts.count !== logicalTotal) {
        violations.add(`${executionLocation}.task_attempts`, "task_attempts_count")
    }
    if (execution.todos !== undefined && (!isRecord(execution.todos) || validateTodos(execution.todos as never).length > 0)) {
        violations.add(`${executionLocation}.todos`, "todos")
    }
    return validateExecutionTools(execution.tools, `${executionLocation}.tools`, violations)
}

function validateExecutionTools(tools: unknown, location: string, violations: ViolationList): number {
    if (tools === undefined) return 0
    if (!isRecord(tools)) {
        violations.add(location, "field")
        return 0
    }
    rejectUnknownKeys(tools, ["completed", "failed", "cancelled", "by_name", "unlisted"], location, violations)
    const problems = validateTools(tools as never)
    if (problems.includes("tools_by_name_limit")) violations.add(`${location}.by_name`, "capacity")
    if (problems.some((problem) => problem !== "tools_by_name_limit")) violations.add(location, "tools")
    return isRecord(tools.by_name) ? Object.keys(tools.by_name).length : 0
}

interface Coverage {
    readonly reported: number
    readonly unreported: number
}

function coverageOf(value: unknown, location: string, violations: ViolationList): Coverage | undefined {
    if (!isRecord(value) || !isCount(value.reported) || !isCount(value.unreported)) {
        violations.add(location, "field")
        return undefined
    }
    rejectUnknownKeys(value, COVERAGE_KEYS, location, violations)
    return { reported: value.reported, unreported: value.unreported }
}

interface Summary {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
}

interface Distribution extends Summary {
    readonly buckets: readonly number[]
}

function isSummary(value: unknown): value is Summary {
    if (!isRecord(value) || Object.keys(value).some((key) => !SUMMARY_KEYS.includes(key))) return false
    const { count, sum, min, max } = value
    if (!isCount(count) || count < 1 || !isCount(sum) || !isCount(min) || !isCount(max)) return false
    return min <= max && min * count <= sum && sum <= max * count
}

/** A summary plus a histogram whose populated range agrees with `min` and `max`. */
function isDistribution(value: unknown): value is Distribution {
    if (!isRecord(value) || Object.keys(value).some((key) => !DISTRIBUTION_KEYS.includes(key))) return false
    const { buckets, ...summary } = value
    if (!isSummary(summary)) return false
    if (!Array.isArray(buckets) || buckets.length !== USAGE_HISTOGRAM_BUCKETS || !buckets.every(isCount)) return false
    if (checkedSum(0, ...buckets) !== summary.count) return false
    const first = buckets.findIndex((count) => count > 0)
    const last = buckets.length - 1 - [...buckets].reverse().findIndex((count) => count > 0)
    return histogramBucket(summary.min) === first && histogramBucket(summary.max) === last
}

export function histogramBucket(valueMs: number): number {
    const index = USAGE_HISTOGRAM_BOUNDS_MS.findIndex((bound) => valueMs <= bound)
    return index === -1 ? USAGE_HISTOGRAM_BOUNDS_MS.length : index
}

function outcomeTotal(value: unknown): number | undefined {
    if (!isRecord(value) || Object.keys(value).some((key) => !includes(OUTCOMES, key))) return undefined
    if (!OUTCOMES.every((key) => isCount(value[key]))) return undefined
    return checkedSum(0, ...OUTCOMES.map((key) => value[key] as number))
}

function namedToolCount(execution: JsonRecord): number {
    const tools = execution.tools
    return isRecord(tools) && isRecord(tools.by_name) ? Object.keys(tools.by_name).length : 0
}

function compareFacts(left: unknown, right: unknown): number {
    const a = isRecord(left) ? left : {}
    const b = isRecord(right) ? right : {}
    for (const key of ["role", "provider", "model_id"] as const) {
        const order = compareUtf16(stringOf(a[key]), stringOf(b[key]))
        if (order !== 0) return order
    }
    return compareThinking(a.thinking, b.thinking)
}

/** Numbers sort before strings; numbers by value, strings by UTF-16 code units. */
function compareThinking(left: unknown, right: unknown): number {
    const leftIsNumber = typeof left === "number"
    const rightIsNumber = typeof right === "number"
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1
    if (leftIsNumber && rightIsNumber) return Math.sign((left as number) - (right as number))
    return compareUtf16(stringOf(left), stringOf(right))
}

function rejectUnknownKeys(value: JsonRecord, allowed: readonly string[], location: string, violations: ViolationList): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) violations.add(location ? `${location}.${key}` : key, "field")
    }
}

/** Sum of counts, or `undefined` when an operand is missing or the result leaves the safe-integer range. */
function checkedSum(initial: number | undefined, ...values: readonly (number | undefined)[]): number | undefined {
    let total = initial
    for (const value of values) {
        if (total === undefined || value === undefined) return undefined
        total += value
        if (!Number.isSafeInteger(total)) return undefined
    }
    return total
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === "string" && (values as readonly string[]).includes(value)
}

function stringOf(value: unknown): string {
    return typeof value === "string" ? value : ""
}

function arrayOf(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
