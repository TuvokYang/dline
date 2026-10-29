import {
    type ApiRateMetricPoint,
    ApiRateMetricsDataRecord,
    ApiRateMetricsQuery,
    ApiRateMetricsResolution,
    ApiRateRollupRecord,
    ApiRateSecondRecord,
    ApiRateTokenQuality,
    getApiRateSecondActivitySeconds,
} from "./api-rate-metrics-types"

const RESOLUTION_SECONDS = {
    minute: 60,
    hour: 60 * 60,
    day: 24 * 60 * 60,
} as const
const SECONDS_PER_MINUTE = 60
const RAW_SECOND_RETENTION_SECONDS = 48 * 60 * 60
const MINUTE_RETENTION_SECONDS = 30 * 24 * 60 * 60
const HOUR_RETENTION_SECONDS = 365 * 24 * 60 * 60
const RESOLUTION_RANK: Record<ApiRateMetricsResolution, number> = { minute: 1, hour: 2, day: 3 }

interface BucketAccumulator {
    activeSeconds: number
    providerActiveSeconds: number
    requestCount: number
    tokenCount: number
    tokenQuality?: ApiRateTokenQuality
}

/** Select the latest append-only revision for each active second. */
export function foldApiRateSecondRevisions(records: readonly ApiRateSecondRecord[]): ApiRateSecondRecord[] {
    const canonicalBySecond = new Map<number, ApiRateSecondRecord>()
    for (const record of records) {
        const current = canonicalBySecond.get(record.second)
        if (!current || record.revision >= current.revision) {
            canonicalBySecond.set(record.second, record)
        }
    }
    return [...canonicalBySecond.values()].sort((left, right) => left.second - right.second)
}

/** Aggregate sparse active-second and compacted rollup records without counting idle wall-clock time. */
export function compactApiRateMetrics(
    records: readonly ApiRateMetricsDataRecord[],
    nowSecond: number,
): ApiRateMetricsDataRecord[] {
    const output: ApiRateMetricsDataRecord[] = []
    const rollupBuckets = new Map<
        string,
        { resolution: ApiRateMetricsResolution; bucketStartSecond: number; value: BucketAccumulator }
    >()
    const canonicalSeconds = foldApiRateSecondRevisions(
        records.filter((record): record is ApiRateSecondRecord => record.kind === "second"),
    )

    for (const record of canonicalSeconds) {
        const resolution = retentionResolution(nowSecond - record.second)
        if (!resolution) {
            output.push(record)
            continue
        }
        const activity = getApiRateSecondActivitySeconds(record.signals)
        addCompactionBucket(
            rollupBuckets,
            resolution,
            record.second,
            activity.activeSeconds,
            activity.providerActiveSeconds,
            record.requestCount,
            record.effectiveTokens,
            record.tokenQuality,
        )
    }

    for (const record of records) {
        if (record.kind !== "rollup") continue
        const desired = retentionResolution(nowSecond - record.bucketStartSecond) ?? record.resolution
        const resolution = RESOLUTION_RANK[desired] > RESOLUTION_RANK[record.resolution] ? desired : record.resolution
        addCompactionBucket(
            rollupBuckets,
            resolution,
            record.bucketStartSecond,
            record.activeSeconds,
            record.providerActiveSeconds ?? record.activeSeconds,
            record.requestCount,
            record.tokenCount,
            record.tokenQuality,
        )
    }

    for (const bucket of rollupBuckets.values()) {
        output.push(createRollupRecord(bucket.resolution, bucket.bucketStartSecond, bucket.value))
    }
    return output.sort((left, right) => recordStartSecond(left) - recordStartSecond(right))
}

export function aggregateApiRateMetrics(
    records: readonly ApiRateMetricsDataRecord[],
    query: ApiRateMetricsQuery,
): ApiRateMetricPoint[] {
    const bucketSeconds = RESOLUTION_SECONDS[query.resolution]
    const buckets = new Map<number, BucketAccumulator>()
    const canonicalSeconds = foldApiRateSecondRevisions(
        records.filter((record): record is ApiRateSecondRecord => record.kind === "second"),
    )

    for (const record of canonicalSeconds) {
        if (record.second < query.startSecond || record.second >= query.endSecond) continue
        const activity = getApiRateSecondActivitySeconds(record.signals)
        addToBucket(
            buckets,
            bucketSeconds,
            record.second,
            activity.activeSeconds,
            activity.providerActiveSeconds,
            record.requestCount,
            record.effectiveTokens,
            record.tokenQuality,
        )
    }

    for (const record of records) {
        if (record.kind !== "rollup") continue
        if (record.bucketStartSecond < query.startSecond || record.bucketStartSecond >= query.endSecond) continue
        addToBucket(
            buckets,
            bucketSeconds,
            record.bucketStartSecond,
            record.activeSeconds,
            record.providerActiveSeconds ?? record.activeSeconds,
            record.requestCount,
            record.tokenCount,
            record.tokenQuality,
        )
    }

    const points = [...buckets.entries()]
        .sort(([left], [right]) => left - right)
        .map(([bucketStartSecond, bucket]) => ({
            bucketStartMs: bucketStartSecond * 1_000,
            bucketEndMs: (bucketStartSecond + bucketSeconds) * 1_000,
            activeSeconds: bucket.activeSeconds,
            requestCount: bucket.requestCount,
            tokenCount: bucket.tokenCount,
            requestsPerMinute: extrapolatePerMinute(bucket.requestCount, bucket.activeSeconds),
            tokensPerMinute: extrapolatePerMinute(bucket.tokenCount, bucket.providerActiveSeconds),
            tokenQuality: bucket.tokenQuality ?? "estimated",
        }))

    const maxPoints = query.maxPoints
    return maxPoints && maxPoints > 0 && points.length > maxPoints ? points.slice(-maxPoints) : points
}

function addToBucket(
    buckets: Map<number, BucketAccumulator>,
    bucketSeconds: number,
    second: number,
    activeSeconds: number,
    providerActiveSeconds: number,
    requestCount: number,
    tokenCount: number,
    tokenQuality: ApiRateTokenQuality,
): void {
    if (activeSeconds <= 0 && providerActiveSeconds <= 0) return
    const bucketStartSecond = Math.floor(second / bucketSeconds) * bucketSeconds
    const bucket = buckets.get(bucketStartSecond) ?? {
        activeSeconds: 0,
        providerActiveSeconds: 0,
        requestCount: 0,
        tokenCount: 0,
    }
    bucket.activeSeconds += activeSeconds
    bucket.providerActiveSeconds += providerActiveSeconds
    bucket.requestCount += requestCount
    bucket.tokenCount += tokenCount
    if (tokenCount > 0) bucket.tokenQuality = mergeTokenQuality(bucket.tokenQuality, tokenQuality)
    buckets.set(bucketStartSecond, bucket)
}

function addCompactionBucket(
    buckets: Map<string, { resolution: ApiRateMetricsResolution; bucketStartSecond: number; value: BucketAccumulator }>,
    resolution: ApiRateMetricsResolution,
    second: number,
    activeSeconds: number,
    providerActiveSeconds: number,
    requestCount: number,
    tokenCount: number,
    tokenQuality: ApiRateTokenQuality,
): void {
    const bucketSeconds = RESOLUTION_SECONDS[resolution]
    const bucketStartSecond = Math.floor(second / bucketSeconds) * bucketSeconds
    const key = `${resolution}:${bucketStartSecond}`
    const entry = buckets.get(key) ?? {
        resolution,
        bucketStartSecond,
        value: { activeSeconds: 0, providerActiveSeconds: 0, requestCount: 0, tokenCount: 0 },
    }
    entry.value.activeSeconds += activeSeconds
    entry.value.providerActiveSeconds += providerActiveSeconds
    entry.value.requestCount += requestCount
    entry.value.tokenCount += tokenCount
    if (tokenCount > 0) entry.value.tokenQuality = mergeTokenQuality(entry.value.tokenQuality, tokenQuality)
    buckets.set(key, entry)
}

function createRollupRecord(
    resolution: ApiRateMetricsResolution,
    bucketStartSecond: number,
    bucket: BucketAccumulator,
): ApiRateRollupRecord {
    return {
        schemaVersion: 1,
        kind: "rollup",
        resolution,
        bucketStartSecond,
        bucketSeconds: RESOLUTION_SECONDS[resolution],
        activeSeconds: bucket.activeSeconds,
        providerActiveSeconds: bucket.providerActiveSeconds,
        requestCount: bucket.requestCount,
        tokenCount: bucket.tokenCount,
        requestsPerMinute: extrapolatePerMinute(bucket.requestCount, bucket.activeSeconds),
        tokensPerMinute: extrapolatePerMinute(bucket.tokenCount, bucket.providerActiveSeconds),
        tokenQuality: bucket.tokenQuality ?? "estimated",
    }
}

function retentionResolution(ageSeconds: number): ApiRateMetricsResolution | undefined {
    if (ageSeconds < RAW_SECOND_RETENTION_SECONDS) return undefined
    if (ageSeconds < MINUTE_RETENTION_SECONDS) return "minute"
    if (ageSeconds < HOUR_RETENTION_SECONDS) return "hour"
    return "day"
}

function recordStartSecond(record: ApiRateMetricsDataRecord): number {
    return record.kind === "second" ? record.second : record.bucketStartSecond
}

function extrapolatePerMinute(value: number, activeSeconds: number): number {
    return activeSeconds > 0 ? Math.round((value * SECONDS_PER_MINUTE) / activeSeconds) : 0
}

function mergeTokenQuality(current: ApiRateTokenQuality | undefined, next: ApiRateTokenQuality): ApiRateTokenQuality {
    if (!current) return next
    return current === next ? current : "mixed"
}
