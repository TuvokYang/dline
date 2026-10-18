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
