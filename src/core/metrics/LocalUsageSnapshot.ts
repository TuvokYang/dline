/**
 * Today's locally measured usage for one Profile, read from the global ledger.
 *
 * The provider reports quota percentages, not token counts, so the figures a usage
 * surface shows as "today" come from facts this installation already committed. They
 * are read from the global metrics ledger rather than from a second per-Profile
 * counter, so a number shown here and a number shown in the metrics view cannot
 * disagree about the same request.
 *
 * A missing database is "nothing recorded yet", which is a real zero: the previous
 * per-Profile ledger published zero for an unused Profile and the surface showed it.
 * A database that exists but cannot be read is reported as absent instead, because
 * publishing zeroes there would claim a quiet day that was never measured.
 */

import fs from "node:fs"
import type { AccountUsageLocalData } from "@shared/ExtensionMessage"
import { totalsOfUsage } from "@shared/metrics/query"
import { Logger } from "@shared/services/Logger"
import { globalMetricsDatabasePath } from "./MetricsPaths"
import { MetricsRepository } from "./MetricsRepository"
import { globalMetricsScope } from "./MetricsScope"

/** Read one Profile's committed usage for the local calendar day containing `now`. */
export async function readLocalUsageSnapshot(
    profileId: string,
    now: Date = new Date(),
): Promise<AccountUsageLocalData | undefined> {
    if (profileId === "") return undefined
    const databasePath = globalMetricsDatabasePath()
    if (!fs.existsSync(databasePath)) return emptySnapshot(now)

    const scope = globalMetricsScope()
    let repository: MetricsRepository | undefined
    try {
        repository = await MetricsRepository.open({ scope, readOnly: true })
        const { fromMs, toMs } = localDayRange(now)
        const rows = await repository.usage({ profileId, fromMs, toMs })
        const totals = totalsOfUsage(rows)
        // Use the stored samples directly: deriving misses from a ratio loses a real
        // zero-hit sample and introduces rounding. Unreported cache never widens this
        // denominator, even when those requests contributed fresh input to the totals.
        const cacheNumerator = rows.reduce((sum, row) => sum + row.cacheNumerator, 0)
        const cacheDenominator = rows.reduce((sum, row) => sum + row.cacheDenominator, 0)
        const cacheHitTokens = cacheDenominator > 0 ? cacheNumerator : undefined
        const cacheMissTokens = cacheDenominator > 0 ? cacheDenominator - cacheNumerator : undefined
        return {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            thoughtsTokens: totals.thoughtsTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            cacheReadTokens: totals.cacheReadTokens,
            ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
            ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
            usageReported: true,
            retrievedAt: now.toISOString(),
        }
    } catch (error) {
        // A usage surface must degrade, not fail: the provider reading is still
        // publishable, it just cannot carry local counts this time.
        Logger.debug(`[Usage] Local usage could not be read for a Profile: ${String(error)}`)
        return undefined
    } finally {
        await repository?.close().catch(() => undefined)
    }
}

/** A Profile with no committed row for the day: measured, and measured at zero. */
function emptySnapshot(now: Date): AccountUsageLocalData {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        usageReported: true,
        retrievedAt: now.toISOString(),
    }
}

/** The half-open local day range a bucket start is compared against. */
function localDayRange(now: Date): { readonly fromMs: number; readonly toMs: number } {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    return { fromMs: start.getTime(), toMs: end.getTime() }
}
