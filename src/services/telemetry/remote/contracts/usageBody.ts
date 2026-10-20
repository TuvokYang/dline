import {
    USAGE_ERROR_CLASSES,
    USAGE_PURPOSES,
    type UsageErrorClass,
    type UsagePurpose,
} from "@/core/task/telemetry/UsageSettlement"

/**
 * The `/v1/usage` request body, `schema_version` 2 (otel contract v2 §2).
 *
 * The body maps one-to-one onto the service's columns, so the service stores it
 * without unpacking. The validator mirrors every rule the service answers with
 * 422: a batch it would refuse is a permanent loss once written as an inflight
 * body, so it is checked before that point and dropped locally instead.
 */

export const USAGE_SCHEMA_VERSION = 2
export const USAGE_BODY_LIMIT_BYTES = 32 * 1024
export const USAGE_MINUTE_MS = 60_000
/** Active minutes one batch may carry, and the most the client keeps waiting locally. */
export const USAGE_MAX_ACTIVE_MINUTES = 60
/** The longest `ended_at - started_at` the service accepts; the minutes inside need not be contiguous. */
export const USAGE_MAX_SPAN_MS = 60 * USAGE_MINUTE_MS
export const USAGE_MAX_MODELS = 8
export const USAGE_MAX_PROVIDERS = 8
/** Upper bounds, in milliseconds, of every latency histogram; the eleventh bucket counts what exceeds them. */
export const USAGE_HISTOGRAM_BOUNDS_MS: readonly number[] = [250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000]
export const USAGE_HISTOGRAM_BUCKETS = USAGE_HISTOGRAM_BOUNDS_MS.length + 1
/** Stands in for every model or provider folded away by the eight-entry limit. */
export const USAGE_OVERFLOW_ID = "_other"
/** Stands in for every custom model, whose own ID never leaves the machine. */
export const USAGE_CUSTOM_MODEL_ID = "_custom"

export const USAGE_HOST_EDITORS = ["vscode", "cursor", "vscodium", "windsurf", "other"] as const
export type UsageHostEditor = (typeof USAGE_HOST_EDITORS)[number]
export const USAGE_RELEASE_CHANNELS = ["stable", "insiders"] as const
export type UsageReleaseChannel = (typeof USAGE_RELEASE_CHANNELS)[number]

export const USAGE_PROVIDER_PATTERN = /^[a-z0-9_-]{1,32}$/
export const USAGE_MODEL_PATTERN = /^[a-z0-9_.-]{1,64}$/
const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/
const CLIENT_FIELD_PATTERN = /^[A-Za-z0-9_.+ -]{1,64}$/

export interface UsageSummaryWire {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
}

/** A summary with its distribution; the buckets sum to `count`. */
export interface UsageHistogramWire extends UsageSummaryWire {
    readonly buckets: readonly number[]
}

export interface UsagePurposeWire {
    readonly requests: { readonly completed: number; readonly cancelled: number; readonly failed: number }
    /** `input` is fresh input only; cache reads and writes are counted apart. */
    readonly tokens: {
        readonly input: number
        readonly output: number
        readonly cache_read: number
        readonly cache_write: number
    }
    readonly duration_ms?: UsageSummaryWire
}

export interface UsageModelTokensWire {
    readonly input: number
    readonly output: number
    readonly cache_read: number
    readonly cache_write: number
    /** The reasoning share of `output`; absent when the provider never reported it. */
    readonly reasoning?: number
}

export interface UsageModelWire {
    readonly provider: string
    readonly model: string
    /** `total` includes failed and cancelled requests. */
    readonly requests: { readonly total: number; readonly failed: number; readonly cancelled: number }
    readonly tokens: UsageModelTokensWire
    readonly duration_ms?: UsageHistogramWire
    /** Streaming requests only. */
    readonly ttft_ms?: UsageHistogramWire
    readonly generation_ms?: UsageHistogramWire
    /** The busiest minute of the batch for this model, by requests and by output tokens separately. */
    readonly peak_minute: { readonly requests: number; readonly tokens_output: number }
}

export interface UsageProviderWire {
    readonly provider: string
    readonly errors: Readonly<Partial<Record<UsageErrorClass, number>>>
    readonly retries: number
    readonly retry_wait_ms?: UsageSummaryWire
}

/** Every field but `version` is omitted rather than sent empty when the host cannot fill it. */
export interface UsageClientWire {
    readonly version: string
    readonly platform?: string
    readonly architecture?: string
    readonly host_version?: string
    readonly host_editor?: UsageHostEditor
    readonly channel?: UsageReleaseChannel
    readonly is_dev?: boolean
}

export interface UsageWindowWire {
    /** Start of the first active minute, epoch milliseconds. */
    readonly started_at: number
    /** End of the last active minute. */
    readonly ended_at: number
    readonly active_minutes: number
    /** Minutes lost before this batch: the backlog limit, a local validation failure or a 422. */
    readonly dropped_minutes: number
}

export interface UsageBodyWire {
    readonly schema_version: typeof USAGE_SCHEMA_VERSION
    readonly client: UsageClientWire
    readonly window: UsageWindowWire
    readonly sessions_started: number
    readonly purposes: Readonly<Partial<Record<UsagePurpose, UsagePurposeWire>>>
    readonly models: readonly UsageModelWire[]
    readonly providers: readonly UsageProviderWire[]
}

export type UsageBodyViolation =
    | "schema_version"
    | "client"
    | "window"
    | "sessions_started"
    | "purposes"
    | "models"
    | "providers"
    | "body_size"

/** Keep only the client fields the service accepts; an odd host value is left out instead of refusing every batch. */
export function sanitizeUsageClient(client: { readonly [K in keyof UsageClientWire]?: unknown }): UsageClientWire | undefined {
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

/** Every section of the body that breaks a service rule; empty when the service would accept it. */
export function validateUsageBody(body: UsageBodyWire): UsageBodyViolation[] {
    const violations: UsageBodyViolation[] = []
    if (body.schema_version !== USAGE_SCHEMA_VERSION) violations.push("schema_version")
    if (!isValidClient(body.client)) violations.push("client")
    if (!isValidWindow(body.window)) violations.push("window")
    if (!isCount(body.sessions_started)) violations.push("sessions_started")
    if (!isRecord(body.purposes) || !Object.entries(body.purposes).every(([key, value]) => isValidPurpose(key, value))) {
        violations.push("purposes")
    }
    if (!isValidModelList(body.models)) violations.push("models")
    if (!isValidProviderList(body.providers)) violations.push("providers")
    return violations
}

function isValidClient(client: UsageClientWire): boolean {
    if (!isRecord(client)) return false
    const sanitized = sanitizeUsageClient(client)
    return sanitized !== undefined && Object.keys(sanitized).length === Object.keys(client).length
}

function isValidWindow(window: UsageWindowWire): boolean {
    if (!isRecord(window)) return false
    const { started_at: start, ended_at: end, active_minutes: active, dropped_minutes: dropped } = window
    if (![start, end, active, dropped].every(isCount)) return false
    if (start % USAGE_MINUTE_MS !== 0 || end % USAGE_MINUTE_MS !== 0 || end <= start) return false
    if (end - start > USAGE_MAX_SPAN_MS) return false
    return active >= 1 && active <= USAGE_MAX_ACTIVE_MINUTES && active * USAGE_MINUTE_MS <= end - start
}

/** A persisted or projected purpose entry the service would accept under `key`. */
export function isValidPurpose(key: string, value: unknown): value is UsagePurposeWire {
    if (!(USAGE_PURPOSES as readonly string[]).includes(key) || !isRecord(value)) return false
    const { requests, tokens } = value
    if (!isRecord(requests) || !hasCounts(requests, ["completed", "cancelled", "failed"])) return false
    if (!isRecord(tokens) || !hasCounts(tokens, ["input", "output", "cache_read", "cache_write"])) return false
    return value.duration_ms === undefined || isConsistentSummary(value.duration_ms)
}

/** A model entry, with or without its peak, the service would accept. */
export function isValidModelEntry(value: unknown, withPeak: boolean): value is UsageModelWire {
    if (!isRecord(value)) return false
    if (typeof value.provider !== "string" || !USAGE_PROVIDER_PATTERN.test(value.provider)) return false
    if (typeof value.model !== "string" || !USAGE_MODEL_PATTERN.test(value.model)) return false
    const { requests, tokens } = value
    if (!isRecord(requests) || !hasCounts(requests, ["total", "failed", "cancelled"])) return false
    const total = requests.total as number
    if ((requests.failed as number) > total || (requests.cancelled as number) > total) return false
    if (!isRecord(tokens) || !hasCounts(tokens, ["input", "output", "cache_read", "cache_write"])) return false
    if (tokens.reasoning !== undefined && !isCount(tokens.reasoning)) return false
    for (const timing of [value.duration_ms, value.ttft_ms, value.generation_ms]) {
        if (timing !== undefined && !isConsistentHistogram(timing)) return false
    }
    if (!withPeak) return value.peak_minute === undefined
    const peak = value.peak_minute
    if (!isRecord(peak) || !hasCounts(peak, ["requests", "tokens_output"])) return false
    return (peak.requests as number) <= total && (peak.tokens_output as number) <= (tokens.output as number)
}

function isValidModelList(models: readonly UsageModelWire[]): boolean {
    if (!Array.isArray(models) || models.length > USAGE_MAX_MODELS) return false
    if (!models.every((model) => isValidModelEntry(model, true))) return false
    return new Set(models.map((model) => `${model.provider}/${model.model}`)).size === models.length
}

/** A provider entry the service would accept. */
export function isValidProviderEntry(value: unknown): value is UsageProviderWire {
    if (!isRecord(value)) return false
    if (typeof value.provider !== "string" || !USAGE_PROVIDER_PATTERN.test(value.provider)) return false
    if (!isRecord(value.errors)) return false
    for (const [key, count] of Object.entries(value.errors)) {
        if (!(USAGE_ERROR_CLASSES as readonly string[]).includes(key) || !isCount(count)) return false
    }
    if (!isCount(value.retries)) return false
    return value.retry_wait_ms === undefined || isConsistentSummary(value.retry_wait_ms)
}

function isValidProviderList(providers: readonly UsageProviderWire[]): boolean {
    if (!Array.isArray(providers) || providers.length > USAGE_MAX_PROVIDERS) return false
    if (!providers.every(isValidProviderEntry)) return false
    return new Set(providers.map((provider) => provider.provider)).size === providers.length
}

/** `min*count <= sum <= max*count` over non-negative finite values, as the service checks. */
export function isConsistentSummary(value: unknown): value is UsageSummaryWire {
    if (!isRecord(value)) return false
    const { count, sum, min, max } = value
    if (!isCount(count) || count < 1) return false
    if (![sum, min, max].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)) return false
    const [total, low, high] = [sum, min, max] as number[]
    return low <= high && low * count <= total && total <= high * count
}

/** A summary whose eleven buckets sum to its count. */
export function isConsistentHistogram(value: unknown): value is UsageHistogramWire {
    if (!isConsistentSummary(value)) return false
    const buckets = (value as { buckets?: unknown }).buckets
    if (!Array.isArray(buckets) || buckets.length !== USAGE_HISTOGRAM_BUCKETS || !buckets.every(isCount)) return false
    return buckets.reduce((total: number, count: number) => total + count, 0) === value.count
}

function hasCounts(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return keys.every((key) => isCount(value[key]))
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
