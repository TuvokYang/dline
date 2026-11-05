/**
 * The read/write façade a receiver or query service uses for one scope.
 *
 * It owns the ledger lifecycle and exposes the operations the rest of the system
 * needs without leaking entity classes or predicates. Two rules shape the surface:
 *
 * - Every mutation goes through the ledger's transaction, so no caller can write a
 *   number outside the receipt it belongs to.
 * - A clear is *not* a Profile deletion. Clearing usage records what the user asked
 *   to forget, but it must not resurrect legacy numbers on the next start, so the
 *   legacy baseline is released while its marker stays.
 */

import type { MetricsEvent } from "@shared/metrics/events"
import type { PerformanceRow, UsageRow } from "@shared/metrics/types"
import {
    type LegacyImportRecord,
    type MetricsBatchOutcome,
    MetricsLedger,
    type MetricsPruneOptions,
    type MetricsPruneOutcome,
    type MetricsReadOptions,
    type MetricsRollupOptions,
    type MetricsRollupOutcome,
} from "./MetricsLedger"
import type { MetricsScope } from "./MetricsScope"

/** Everything a caller may clear in one call. */
export interface MetricsClearSelector extends MetricsReadOptions {
    readonly tables?: readonly ("usage" | "performance")[]
    /**
     * Overrides the default decision about the frozen legacy baseline.
     *
     * By default a clear that covers the whole usage scope releases it, while a
     * filtered clear keeps it: a Profile, Task, date or bucket filter cannot attribute
     * a Profile-day baseline it never matched, so dropping that baseline would delete
     * numbers the user did not ask to delete.
     */
    readonly releaseLegacyBaseline?: boolean
}

export interface MetricsClearOutcome {
    readonly usageRowsRemoved: number
    readonly performanceRowsRemoved: number
    /**
     * True when frozen legacy numbers survive because the clear was filtered.
     *
     * A surface must show this instead of implying the old day totals are gone.
     */
    readonly legacyBaselineRetained: boolean
}

/** True when a clear matches every usage row of the scope, with no filter at all. */
function coversWholeUsageScope(options: MetricsReadOptions): boolean {
    return (
        options.fromMs === undefined &&
        options.toMs === undefined &&
        options.taskId === undefined &&
        options.profileId === undefined &&
        options.modelId === undefined &&
        options.keyFingerprint === undefined
    )
}

export interface MetricsRepositoryOptions {
    readonly scope: MetricsScope
    readonly now?: () => number
    /** Open for reading only; every mutation is refused. */
    readonly readOnly?: boolean
}

export class MetricsRepository {
    private constructor(
        private readonly ledger: MetricsLedger,
        readonly scope: MetricsScope,
    ) {}

    /** Open one scope's storage. One repository manages one level. */
    static async open(options: MetricsRepositoryOptions): Promise<MetricsRepository> {
        const ledger = await MetricsLedger.open(options)
        return new MetricsRepository(ledger, options.scope)
    }

    /** Record a batch atomically; duplicates and late events are reported, not applied. */
    async record(events: readonly MetricsEvent[]): Promise<MetricsBatchOutcome> {
        return await this.ledger.commitBatch(events)
    }

    /** Read usage rows for this scope. */
    async usage(options: MetricsReadOptions = {}): Promise<UsageRow[]> {
        return await this.ledger.readUsageRows(options)
    }

    /** Read performance rows for this scope. */
    async performance(options: MetricsReadOptions = {}): Promise<PerformanceRow[]> {
        return await this.ledger.readPerformanceRows(options)
    }

    /** Clear matching rows in the selected tables. */
    async clear(selector: MetricsClearSelector = {}): Promise<MetricsClearOutcome> {
        const tables = selector.tables ?? ["usage", "performance"]
        const { tables: _tables, releaseLegacyBaseline, ...readOptions } = selector
        const clearsUsage = tables.includes("usage")
        const release = clearsUsage && (releaseLegacyBaseline ?? coversWholeUsageScope(readOptions))
        const usageRowsRemoved = clearsUsage ? await this.ledger.clearUsageRows(readOptions, release) : 0
        const performanceRowsRemoved = tables.includes("performance") ? await this.ledger.clearPerformanceRows(readOptions) : 0
        return { usageRowsRemoved, performanceRowsRemoved, legacyBaselineRetained: clearsUsage && !release }
    }

    /** Clear everything a specific Profile or task wrote in this scope. */
    async clearKey(key: { readonly profileId?: string; readonly taskId?: string }): Promise<MetricsClearOutcome> {
        if (key.profileId === undefined && key.taskId === undefined) {
            throw new Error("Clearing by key requires a profile id or a task id")
        }
        const selector: MetricsClearSelector = {
            ...(key.profileId === undefined ? {} : { profileId: key.profileId }),
            ...(key.taskId === undefined ? {} : { taskId: key.taskId }),
        }
        // A key always filters, so the frozen Profile-day baseline cannot be attributed
        // to it and is retained; `clear()` reports that to the caller.
        return await this.clear(selector)
    }

    /** Clear one closed bucket range, inclusive of `fromMs` and exclusive of `toMs`. */
    async clearRange(range: { readonly fromMs: number; readonly toMs: number }): Promise<MetricsClearOutcome> {
        if (range.toMs <= range.fromMs) throw new Error("A clear range must end after it starts")
        return await this.clear({ fromMs: range.fromMs, toMs: range.toMs })
    }

    /** Clear every row and every receipt of this scope, including legacy markers. */
    async clearAll(): Promise<MetricsClearOutcome & { metadataRowsRemoved: number }> {
        const cleared = await this.ledger.clearAll()
        return {
            usageRowsRemoved: cleared.usageRows,
            performanceRowsRemoved: cleared.performanceRows,
            legacyBaselineRetained: false,
            metadataRowsRemoved: cleared.metadataRows,
        }
    }

    /** Apply retention and advance the acceptance floor in one transaction. */
    async pruneBefore(options: MetricsPruneOptions): Promise<MetricsPruneOutcome> {
        return await this.ledger.prune(options)
    }

    /** Fold finished buckets into the next coarser resolution. */
    async rollup(options: MetricsRollupOptions): Promise<MetricsRollupOutcome> {
        return await this.ledger.rollup(options)
    }

    /** The scope's acceptance floor, or `undefined` when nothing is final yet. */
    async acceptanceFloorMs(): Promise<number | undefined> {
        return await this.ledger.acceptanceFloorMs()
    }

    /** Raise the acceptance floor; it never moves backwards. */
    async setAcceptanceFloor(floorMs: number): Promise<number> {
        return await this.ledger.setAcceptanceFloor(floorMs)
    }

    /** Record a completed legacy import together with the numbers it froze. */
    async recordLegacyImport(record: LegacyImportRecord): Promise<void> {
        await this.ledger.recordLegacyImport(record)
    }

    /**
     * Whether a legacy subject was ever imported.
     *
     * A migration asks this, not {@link readLegacyBaseline}: a cleared scope keeps the
     * marker but drops the numbers, so asking for the numbers would re-import usage the
     * user had already cleared.
     */
    async hasLegacyImport(subjectKey: string): Promise<boolean> {
        return await this.ledger.hasLegacyImport(subjectKey)
    }

    /** Read the frozen numbers of a legacy import, if it happened. */
    async readLegacyBaseline(subjectKey: string): Promise<LegacyImportRecord | undefined> {
        return await this.ledger.readLegacyBaseline(subjectKey)
    }

    /** Release the database handle. Safe to call more than once. */
    async close(): Promise<void> {
        await this.ledger.close()
    }
}
