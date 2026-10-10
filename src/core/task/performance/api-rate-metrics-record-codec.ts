import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import {
    API_RATE_METRICS_SCHEMA_VERSION,
    type ApiRateMetricsFileRecord,
    type ApiRateMetricsMetaRecord,
    type ApiRateMetricsResolution,
    type ApiRateRollupRecord,
    type ApiRateSecondRecord,
    type ApiRateSignal,
    type ApiRateTokenQuality,
} from "./api-rate-metrics-types"

const SIGNAL_ORDER: readonly ApiRateSignal[] = ["task_active", "provider_active", "request_start", "stream_tokens", "exact_usage"]
const SIGNALS = new Set<ApiRateSignal>(SIGNAL_ORDER)
const TOKEN_QUALITIES = new Set<ApiRateTokenQuality>(["estimated", "mixed", "exact"])
const RESOLUTIONS = new Set<ApiRateMetricsResolution>(["minute", "hour", "day"])
const KNOWN_SIGNALS_MASK = (1 << SIGNAL_ORDER.length) - 1

export type ApiRateMetricsMigrationKey = "legacy-api-rate-metrics-jsonl-v1" | "api-rate-metrics-sqlite-wrapper-v1"

export interface ApiRateMetricsMigrationMarker {
    schemaVersion: typeof API_RATE_METRICS_SCHEMA_VERSION
    kind: "migration"
    migrationKey: ApiRateMetricsMigrationKey
    sourceFingerprint: string
    importedRecords: number
    degraded: boolean
    completedAt: number
}

export type ApiRateMetricsStoredRecord = ApiRateMetricsFileRecord | ApiRateMetricsMigrationMarker
export type ApiRateMetricsStoredKind = ApiRateMetricsStoredRecord["kind"]

export interface ApiRateMetricsEntityValues {
    recordKey: string
    revision: number
    schemaVersion: number
    kind: ApiRateMetricsStoredKind
    startSecond: number | null
    taskId: string | null
    createdAt: number | null
    second: number | null
    signalsMask: number | null
    requestCount: number | null
    estimatedTokens: number | null
    effectiveTokens: number | null
    tokenQuality: ApiRateTokenQuality | null
    runningActiveSeconds: number | null
    runningProviderActiveSeconds: number | null
    runningRequestCount: number | null
    runningTokenCount: number | null
    requestsPerMinute: number | null
    tokensPerMinute: number | null
    resolution: ApiRateMetricsResolution | null
    bucketStartSecond: number | null
    bucketSeconds: number | null
    activeSeconds: number | null
    providerActiveSeconds: number | null
    tokenCount: number | null
    migrationKey: ApiRateMetricsMigrationKey | null
    sourceFingerprint: string | null
    importedRecords: number | null
    degraded: boolean | null
    completedAt: number | null
}

export class ApiRateMetricsEntity implements ApiRateMetricsEntityValues {
    static readonly storage = defineEntity<ApiRateMetricsEntity>()({
        schemaId: "api-rate-metrics-flat",
        version: 1,
        columns: {
            recordKey: column.text({ primary: true }),
            revision: column.integer({ primary: true }),
            schemaVersion: column.integer(),
            kind: column.enumText(["meta", "second", "rollup", "migration"] as const, { indexed: true }),
            startSecond: column.integer({ nullable: true, indexed: true }),
            taskId: column.text({ nullable: true }),
            createdAt: column.real({ nullable: true }),
            second: column.integer({ nullable: true }),
            signalsMask: column.integer({ nullable: true }),
            requestCount: column.integer({ nullable: true }),
            estimatedTokens: column.integer({ nullable: true }),
            effectiveTokens: column.integer({ nullable: true }),
            tokenQuality: column.enumText(["estimated", "mixed", "exact"] as const, { nullable: true }),
            runningActiveSeconds: column.integer({ nullable: true }),
            runningProviderActiveSeconds: column.integer({ nullable: true }),
            runningRequestCount: column.integer({ nullable: true }),
            runningTokenCount: column.integer({ nullable: true }),
            requestsPerMinute: column.integer({ nullable: true }),
            tokensPerMinute: column.integer({ nullable: true }),
            resolution: column.enumText(["minute", "hour", "day"] as const, { nullable: true }),
            bucketStartSecond: column.integer({ nullable: true }),
            bucketSeconds: column.integer({ nullable: true }),
            activeSeconds: column.integer({ nullable: true }),
            providerActiveSeconds: column.integer({ nullable: true }),
            tokenCount: column.integer({ nullable: true }),
            migrationKey: column.enumText(["legacy-api-rate-metrics-jsonl-v1", "api-rate-metrics-sqlite-wrapper-v1"] as const, {
                nullable: true,
            }),
            sourceFingerprint: column.text({ nullable: true }),
            importedRecords: column.integer({ nullable: true }),
            degraded: column.boolean({ nullable: true }),
            completedAt: column.real({ nullable: true }),
        },
        indexes: [
            { name: "api-rate-metrics-kind-start-revision", fields: ["kind", "startSecond", "revision"] },
            { name: "api-rate-metrics-kind-resolution-start", fields: ["kind", "resolution", "startSecond"] },
        ],
        defaultOrder: [
            { field: "startSecond", direction: "asc" },
            { field: "recordKey", direction: "asc" },
            { field: "revision", direction: "asc" },
        ],
        hydrate: (values) => new ApiRateMetricsEntity(values),
    })

    readonly recordKey!: string
    readonly revision!: number
    readonly schemaVersion!: number
    readonly kind!: ApiRateMetricsStoredKind
    readonly startSecond!: number | null
    readonly taskId!: string | null
    readonly createdAt!: number | null
    readonly second!: number | null
    readonly signalsMask!: number | null
    readonly requestCount!: number | null
    readonly estimatedTokens!: number | null
    readonly effectiveTokens!: number | null
    readonly tokenQuality!: ApiRateTokenQuality | null
    readonly runningActiveSeconds!: number | null
    readonly runningProviderActiveSeconds!: number | null
    readonly runningRequestCount!: number | null
    readonly runningTokenCount!: number | null
    readonly requestsPerMinute!: number | null
    readonly tokensPerMinute!: number | null
    readonly resolution!: ApiRateMetricsResolution | null
    readonly bucketStartSecond!: number | null
    readonly bucketSeconds!: number | null
    readonly activeSeconds!: number | null
    readonly providerActiveSeconds!: number | null
    readonly tokenCount!: number | null
    readonly migrationKey!: ApiRateMetricsMigrationKey | null
    readonly sourceFingerprint!: string | null
    readonly importedRecords!: number | null
    readonly degraded!: boolean | null
    readonly completedAt!: number | null

    constructor(values: ApiRateMetricsEntityValues) {
        Object.assign(this, values)
    }
}

export function toApiRateMetricsEntity(record: ApiRateMetricsStoredRecord): ApiRateMetricsEntity {
    const base = createEmptyEntity(record)
    if (record.kind === "meta") {
        return new ApiRateMetricsEntity({ ...base, taskId: record.taskId, createdAt: record.createdAt })
    }
    if (record.kind === "second") {
        return new ApiRateMetricsEntity({
            ...base,
            second: record.second,
            signalsMask: encodeSignals(record.signals),
            requestCount: record.requestCount,
            estimatedTokens: record.estimatedTokens,
            effectiveTokens: record.effectiveTokens,
            tokenQuality: record.tokenQuality,
            runningActiveSeconds: record.runningActiveSeconds,
            runningProviderActiveSeconds: record.runningProviderActiveSeconds ?? null,
            runningRequestCount: record.runningRequestCount,
            runningTokenCount: record.runningTokenCount,
            requestsPerMinute: record.requestsPerMinute,
            tokensPerMinute: record.tokensPerMinute,
        })
    }
    if (record.kind === "rollup") {
        return new ApiRateMetricsEntity({
            ...base,
            requestCount: record.requestCount,
            tokenQuality: record.tokenQuality,
            requestsPerMinute: record.requestsPerMinute,
            tokensPerMinute: record.tokensPerMinute,
            resolution: record.resolution,
            bucketStartSecond: record.bucketStartSecond,
            bucketSeconds: record.bucketSeconds,
            activeSeconds: record.activeSeconds,
            providerActiveSeconds: record.providerActiveSeconds ?? null,
            tokenCount: record.tokenCount,
        })
    }
    return new ApiRateMetricsEntity({
        ...base,
        migrationKey: record.migrationKey,
        sourceFingerprint: record.sourceFingerprint,
        importedRecords: record.importedRecords,
        degraded: record.degraded,
        completedAt: record.completedAt,
    })
}

export function fromApiRateMetricsEntity(entity: ApiRateMetricsEntity): ApiRateMetricsStoredRecord {
    let record: ApiRateMetricsStoredRecord | undefined
    if (entity.kind === "meta") {
        record = sanitizeMeta({
            schemaVersion: entity.schemaVersion,
            kind: entity.kind,
            taskId: requireValue(entity.taskId, "taskId"),
            createdAt: requireValue(entity.createdAt, "createdAt"),
        })
    } else if (entity.kind === "second") {
        record = sanitizeSecondRecord({
            schemaVersion: entity.schemaVersion,
            kind: entity.kind,
            second: requireValue(entity.second, "second"),
            revision: entity.revision,
            signals: decodeSignals(requireValue(entity.signalsMask, "signalsMask")),
            requestCount: requireValue(entity.requestCount, "requestCount"),
            estimatedTokens: requireValue(entity.estimatedTokens, "estimatedTokens"),
            effectiveTokens: requireValue(entity.effectiveTokens, "effectiveTokens"),
            tokenQuality: requireValue(entity.tokenQuality, "tokenQuality"),
            runningActiveSeconds: requireValue(entity.runningActiveSeconds, "runningActiveSeconds"),
            ...(entity.runningProviderActiveSeconds === null
                ? {}
                : { runningProviderActiveSeconds: entity.runningProviderActiveSeconds }),
            runningRequestCount: requireValue(entity.runningRequestCount, "runningRequestCount"),
            runningTokenCount: requireValue(entity.runningTokenCount, "runningTokenCount"),
            requestsPerMinute: requireValue(entity.requestsPerMinute, "requestsPerMinute"),
            tokensPerMinute: requireValue(entity.tokensPerMinute, "tokensPerMinute"),
        })
    } else if (entity.kind === "rollup") {
        record = sanitizeRollupRecord({
            schemaVersion: entity.schemaVersion,
            kind: entity.kind,
            resolution: requireValue(entity.resolution, "resolution"),
            bucketStartSecond: requireValue(entity.bucketStartSecond, "bucketStartSecond"),
            bucketSeconds: requireValue(entity.bucketSeconds, "bucketSeconds"),
            activeSeconds: requireValue(entity.activeSeconds, "activeSeconds"),
            ...(entity.providerActiveSeconds === null ? {} : { providerActiveSeconds: entity.providerActiveSeconds }),
            requestCount: requireValue(entity.requestCount, "requestCount"),
            tokenCount: requireValue(entity.tokenCount, "tokenCount"),
            requestsPerMinute: requireValue(entity.requestsPerMinute, "requestsPerMinute"),
            tokensPerMinute: requireValue(entity.tokensPerMinute, "tokensPerMinute"),
            tokenQuality: requireValue(entity.tokenQuality, "tokenQuality"),
        })
    } else if (entity.kind === "migration") {
        record = sanitizeMigrationMarker({
            schemaVersion: entity.schemaVersion,
            kind: entity.kind,
            migrationKey: requireValue(entity.migrationKey, "migrationKey"),
            sourceFingerprint: requireValue(entity.sourceFingerprint, "sourceFingerprint"),
            importedRecords: requireValue(entity.importedRecords, "importedRecords"),
            degraded: requireValue(entity.degraded, "degraded"),
            completedAt: requireValue(entity.completedAt, "completedAt"),
        })
    }
    if (!record || entity.recordKey !== getRecordKey(record) || entity.startSecond !== getStartSecond(record)) {
        throw new Error(`Invalid persisted API rate metrics entity ${entity.recordKey}`)
    }
    return record
}

export function isApiRateMetricsStoredRecord(value: unknown): value is ApiRateMetricsStoredRecord {
    return isApiRateMetricsFileRecord(value) || sanitizeMigrationMarker(value) !== undefined
}

function createEmptyEntity(record: ApiRateMetricsStoredRecord): ApiRateMetricsEntityValues {
    return {
        recordKey: getRecordKey(record),
        revision: getRevision(record),
        schemaVersion: record.schemaVersion,
        kind: record.kind,
        startSecond: getStartSecond(record),
        taskId: null,
        createdAt: null,
        second: null,
        signalsMask: null,
        requestCount: null,
        estimatedTokens: null,
        effectiveTokens: null,
        tokenQuality: null,
        runningActiveSeconds: null,
        runningProviderActiveSeconds: null,
        runningRequestCount: null,
        runningTokenCount: null,
        requestsPerMinute: null,
        tokensPerMinute: null,
        resolution: null,
        bucketStartSecond: null,
        bucketSeconds: null,
        activeSeconds: null,
        providerActiveSeconds: null,
        tokenCount: null,
        migrationKey: null,
        sourceFingerprint: null,
        importedRecords: null,
        degraded: null,
        completedAt: null,
    }
}

function getRecordKey(record: ApiRateMetricsStoredRecord): string {
    if (record.kind === "migration") return `migration:${record.migrationKey}`
    if (record.kind === "meta") return "meta"
    if (record.kind === "second") return `second:${record.second}`
    return `rollup:${record.resolution}:${record.bucketStartSecond}`
}

function getRevision(record: ApiRateMetricsStoredRecord): number {
    return record.kind === "second" ? record.revision : 0
}

function getStartSecond(record: ApiRateMetricsStoredRecord): number | null {
    if (record.kind === "second") return record.second
    if (record.kind === "rollup") return record.bucketStartSecond
    return null
}

function encodeSignals(signals: readonly ApiRateSignal[]): number {
    let mask = 0
    for (const signal of signals) {
        const index = SIGNAL_ORDER.indexOf(signal)
        if (index < 0) throw new Error(`Unsupported API rate metric signal ${signal}`)
        mask |= 1 << index
    }
    return mask
}

function decodeSignals(mask: number): ApiRateSignal[] {
    if (!isNonNegativeInteger(mask) || (mask & ~KNOWN_SIGNALS_MASK) !== 0) {
        throw new Error(`Invalid API rate metrics signals mask ${mask}`)
    }
    return SIGNAL_ORDER.filter((_, index) => (mask & (1 << index)) !== 0)
}

function requireValue<TValue>(value: TValue | null, field: string): TValue {
    if (value === null) throw new Error(`Missing API rate metrics field ${field}`)
    return value
}

export function isApiRateMetricsFileRecord(value: unknown): value is ApiRateMetricsFileRecord {
    return sanitizeMeta(value) !== undefined || sanitizeDataRecord(value) !== undefined
}

export function sanitizeMigrationMarker(value: unknown): ApiRateMetricsMigrationMarker | undefined {
    if (!isRecord(value)) return undefined
    if (
        value.schemaVersion !== API_RATE_METRICS_SCHEMA_VERSION ||
        value.kind !== "migration" ||
        (value.migrationKey !== "legacy-api-rate-metrics-jsonl-v1" &&
            value.migrationKey !== "api-rate-metrics-sqlite-wrapper-v1") ||
        typeof value.sourceFingerprint !== "string" ||
        !isNonNegativeInteger(value.importedRecords) ||
        typeof value.degraded !== "boolean" ||
        !isFiniteNumber(value.completedAt)
    )
        return undefined
    return value as unknown as ApiRateMetricsMigrationMarker
}

export function sanitizeMeta(value: unknown): ApiRateMetricsMetaRecord | undefined {
    if (!isRecord(value)) return undefined
    if (value.schemaVersion !== API_RATE_METRICS_SCHEMA_VERSION || value.kind !== "meta") return undefined
    if (typeof value.taskId !== "string" || !isFiniteNumber(value.createdAt)) return undefined
    return value as unknown as ApiRateMetricsMetaRecord
}

export function sanitizeDataRecord(value: unknown): ApiRateSecondRecord | ApiRateRollupRecord | undefined {
    if (!isRecord(value) || value.schemaVersion !== API_RATE_METRICS_SCHEMA_VERSION) return undefined
    if (value.kind === "second") return sanitizeSecondRecord(value)
    if (value.kind === "rollup") return sanitizeRollupRecord(value)
    return undefined
}

function sanitizeSecondRecord(value: Record<string, unknown>): ApiRateSecondRecord | undefined {
    if (!isNonNegativeInteger(value.second) || !isNonNegativeInteger(value.revision)) return undefined
    if (!Array.isArray(value.signals) || !value.signals.every((signal) => SIGNALS.has(signal as ApiRateSignal))) return undefined
    if (
        !isNonNegativeInteger(value.requestCount) ||
        !isNonNegativeInteger(value.estimatedTokens) ||
        !isNonNegativeInteger(value.effectiveTokens) ||
        !TOKEN_QUALITIES.has(value.tokenQuality as ApiRateTokenQuality) ||
        !isNonNegativeInteger(value.runningActiveSeconds) ||
        (value.runningProviderActiveSeconds !== undefined && !isNonNegativeInteger(value.runningProviderActiveSeconds)) ||
        !isNonNegativeInteger(value.runningRequestCount) ||
        !isNonNegativeInteger(value.runningTokenCount) ||
        !isNonNegativeInteger(value.requestsPerMinute) ||
        !isNonNegativeInteger(value.tokensPerMinute)
    )
        return undefined
    return value as unknown as ApiRateSecondRecord
}

function sanitizeRollupRecord(value: Record<string, unknown>): ApiRateRollupRecord | undefined {
    if (!isResolution(value.resolution)) return undefined
    if (
        !isNonNegativeInteger(value.bucketStartSecond) ||
        !isNonNegativeInteger(value.bucketSeconds) ||
        !isNonNegativeInteger(value.activeSeconds) ||
        (value.providerActiveSeconds !== undefined && !isNonNegativeInteger(value.providerActiveSeconds)) ||
        !isNonNegativeInteger(value.requestCount) ||
        !isNonNegativeInteger(value.tokenCount) ||
        !isNonNegativeInteger(value.requestsPerMinute) ||
        !isNonNegativeInteger(value.tokensPerMinute) ||
        !TOKEN_QUALITIES.has(value.tokenQuality as ApiRateTokenQuality)
    )
        return undefined
    return value as unknown as ApiRateRollupRecord
}

function isResolution(value: unknown): value is ApiRateMetricsResolution {
    return typeof value === "string" && RESOLUTIONS.has(value as ApiRateMetricsResolution)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}
