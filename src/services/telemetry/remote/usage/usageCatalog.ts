import { USAGE_PURPOSES, type UsagePurpose, type UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import type { UsageMeasurementWire } from "../contracts/wire"

/**
 * The fixed remote usage catalog (WS-098 spec §10).
 *
 * Names split only by purpose and outcome; provider, model and API format never
 * appear, so the catalog stays a few dozen names and carries no identifying detail.
 */
export interface UsageObservation {
    readonly counters: Readonly<Record<string, number>>
    readonly measurements: Readonly<Record<string, UsageMeasurementWire>>
}

export function usageMetricNames(purpose: UsagePurpose) {
    return {
        input: `dline.usage.tokens.input.${purpose}`,
        output: `dline.usage.tokens.output.${purpose}`,
        cacheRead: `dline.usage.tokens.cache_read.${purpose}`,
        cacheWrite: `dline.usage.tokens.cache_write.${purpose}`,
        cost: `dline.usage.cost_micro_usd.${purpose}`,
        duration: `dline.usage.request_duration_ms.${purpose}`,
    } as const
}

export function requestCounterName(purpose: UsagePurpose, outcome: UsageSettlement["outcome"]): string {
    return `dline.usage.requests.${purpose}.${outcome}`
}

/** Project one settled request onto the catalog; zero counts are omitted to keep batches sparse. */
export function projectUsageSettlement(settlement: UsageSettlement): UsageObservation {
    const purpose = catalogPurpose(settlement.purpose)
    const names = usageMetricNames(purpose)
    const counters: Record<string, number> = { [requestCounterName(purpose, settlement.outcome)]: 1 }
    addCount(counters, names.input, settlement.inputTokens)
    addCount(counters, names.output, settlement.outputTokens)
    addCount(counters, names.cacheRead, settlement.cacheReadTokens)
    addCount(counters, names.cacheWrite, settlement.cacheWriteTokens)
    if (settlement.costMicroUsd !== undefined) addCount(counters, names.cost, settlement.costMicroUsd)
    const duration = Math.max(0, Math.round(settlement.durationMs))
    return { counters, measurements: { [names.duration]: { count: 1, sum: duration, min: duration, max: duration } } }
}

/** A purpose this build does not know is reported as `other` rather than inventing a name. */
function catalogPurpose(purpose: string): UsagePurpose {
    return (USAGE_PURPOSES as readonly string[]).includes(purpose) ? (purpose as UsagePurpose) : "other"
}

function addCount(counters: Record<string, number>, name: string, value: number): void {
    const count = Math.round(value)
    if (Number.isSafeInteger(count) && count > 0) counters[name] = count
}

/**
 * Read the counters and summaries of a persisted observation or window. Any
 * value the server would refuse makes the whole record unreadable, so a
 * damaged record is skipped instead of poisoning the batch it would join.
 */
export function parseUsageObservation(value: unknown): UsageObservation | undefined {
    if (!isRecord(value) || !isRecord(value.counters) || !isRecord(value.measurements)) return undefined
    const counters = value.counters
    if (!Object.values(counters).every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)) return undefined
    const measurements: Record<string, UsageMeasurementWire> = {}
    for (const [name, entry] of Object.entries(value.measurements)) {
        if (!isRecord(entry)) return undefined
        const { count, sum, min, max } = entry
        if (!Number.isSafeInteger(count) || (count as number) < 1) return undefined
        if (![sum, min, max].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)) return undefined
        measurements[name] = { count: count as number, sum: sum as number, min: min as number, max: max as number }
    }
    return { counters: counters as Record<string, number>, measurements }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
