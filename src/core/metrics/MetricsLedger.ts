/**
 * The single write path for one metrics scope.
 *
 * A ledger owns one open database and every write that touches it. Writes go through
 * `commitBatch`, which performs *one* database transaction: each event is checked
 * against its receipt, the current row is read inside the same transaction, and the
 * accumulated result is written back together with the new receipt. That ordering is
 * what makes "receipt committed but numbers lost" impossible, and it is why the ledger
 * never does an incremental overwrite of a stale value.
 *
 * The ledger is deliberately not a global singleton: one instance manages one scope.
 * Opening the same path twice within one runtime shares the underlying connection
 * through the SQLite registry, but that is an optimization of the backend, not a
 * guarantee the ledger relies on.
 */

import type { TransactionalUnifyStoreDatabase, UnifyStoreCollectionTransaction } from "@core/storage/backend/api/UnifyStore"
import { and, eq, gte, lt, type UnifyStorePredicate } from "@core/storage/backend/api/UnifyStoreQuery"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { bucketStartOf, RESOLUTION_MS } from "@shared/metrics/bucket"
import { isUsageEvent, type MetricsEvent, type PerformanceEvent, type UsageEvent } from "@shared/metrics/events"
import { idempotencyKey } from "@shared/metrics/identity"
import {
    accumulatePerformance,
    accumulateUsage,
    emptyPerformanceRowBody,
    emptyUsageRow,
    mergePerformanceBodies,
    mergeUsageBodies,
    type PerformanceBody,
    type UsageBody,
} from "@shared/metrics/merge"
import type { MetricsResolution, MetricsRowIdentity, PerformanceRow, UsageRow } from "@shared/metrics/types"
import { MetricsMetadataEntity, type MetricsMetadataEntityValues } from "./entities/MetricsMetadataEntity"
import { PerformanceEntity, type PerformanceEntityValues } from "./entities/PerformanceEntity"
import { UsageEntity, type UsageEntityValues } from "./entities/UsageEntity"
import type { MetricsScope } from "./MetricsScope"

/** The only resolution events are stored at; coarser rows exist only after a rollup. */
const EVENT_RESOLUTION: MetricsResolution = "minute"

/** Subject key of the scope-wide acceptance floor row. */
const ACCEPTANCE_FLOOR_SUBJECT = ""

/** What one batch did, so a caller can report duplicates instead of silently dropping them. */
export interface MetricsBatchOutcome {
    /** Events that became stored numbers. */
    readonly accepted: number
    readonly usageRows: number
    readonly performanceRows: number
    /** Events already recorded by an earlier batch. */
    readonly duplicate: number
    /** Events older than the acceptance floor; they can never be applied. */
    readonly lateExpired: number
}

const EMPTY_OUTCOME: MetricsBatchOutcome = Object.freeze({
    accepted: 0,
    usageRows: 0,
    performanceRows: 0,
    duplicate: 0,
    lateExpired: 0,
})

/** One-time legacy import state, kept beside the rows it describes. */
export interface LegacyImportRecord {
    readonly subjectKey: string
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cost?: number
    readonly currency?: string
}

/** Options for a rollup of finished buckets into the next coarser resolution. */
export interface MetricsRollupOptions {
    readonly sourceResolution: MetricsResolution
    readonly targetResolution: MetricsResolution
    /**
     * Only buckets that end at or before this instant are folded.
     *
     * A bucket still open at `beforeMs` may receive a legal late event, so folding it
     * would make the folded hour and the late minute row disagree.
     */
    readonly beforeMs: number
}

/** How many rows a rollup folded, so maintenance can report real work. */
export interface MetricsRollupOutcome {
    readonly sourceRowsRemoved: number
    readonly targetRowsWritten: number
}

/** Retention and floor maintenance in one transaction. */
export interface MetricsPruneOptions {
    /** Rows bucketed before this instant are deleted. */
    readonly retentionStartMs: number
    /**
     * Events observed before this instant are rejected from now on.
     *
     * It must not be newer than `retentionStartMs`: a newer floor would reject events
     * whose bucket retention still keeps, and the two answers would contradict.
     */
    readonly acceptanceFloorMs: number
}

export interface MetricsPruneOutcome {
    readonly usageRowsRemoved: number
    readonly performanceRowsRemoved: number
    readonly receiptsRemoved: number
    readonly acceptanceFloorMs: number
}

export interface MetricsLedgerOptions {
    readonly scope: MetricsScope
    /** Injected so tests can make a bucket's closed-ness deterministic. */
    readonly now?: () => number
    /**
     * Open for reading only.
     *
     * A reader must not take the write lock. This backend runs every transaction as
     * `BEGIN IMMEDIATE`, which acquires the database's write lock even for a `SELECT`,
     * so a read on the extension host thread would wait behind the worker's batch for
     * up to `busy_timeout`. Opening readonly also refuses an unmigrated database
     * instead of creating one from a read path.
     */
    readonly readOnly?: boolean
}

export class MetricsLedger {
    private readonly scope: MetricsScope
    private readonly now: () => number
    private readonly readOnly: boolean
    private database: TransactionalUnifyStoreDatabase | undefined
    private closePromise: Promise<void> | undefined

    private constructor(options: MetricsLedgerOptions) {
        this.scope = options.scope
        this.now = options.now ?? Date.now
        this.readOnly = options.readOnly === true
    }

    /**
     * Open the scope's database and register every collection it owns.
     *
     * A database transaction can only address a collection that was opened on that
     * database first, so the three collections are opened once here rather than
     * lazily on the first write. The path's parent directory is created by the backend.
     */
    static async open(options: MetricsLedgerOptions): Promise<MetricsLedger> {
        const ledger = new MetricsLedger(options)
        const readOnly = options.readOnly === true
        const database = await new SqliteUnifyStoreBackend().open(options.scope.databasePath, { readonly: readOnly })
        try {
            await database.openStore(UsageEntity)
            await database.openStore(PerformanceEntity)
            await database.openStore(MetricsMetadataEntity)
        } catch (error) {
            await database.close().catch(() => undefined)
            throw error
        }
        ledger.database = database
        return ledger
    }

    get scopeId(): string {
        return this.scope.scopeId
    }

    /**
     * Record one batch atomically.
     *
     * Duplicate events are skipped rather than re-added: the receipt and the number it
     * describes commit together, so a receipt exists exactly when the number does.
     */
    async commitBatch(events: readonly MetricsEvent[]): Promise<MetricsBatchOutcome> {
        this.assertWritable()
        if (events.length === 0) return EMPTY_OUTCOME
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const usageStore = transaction.store(UsageEntity)
            const performanceStore = transaction.store(PerformanceEntity)
            const metadataStore = transaction.store(MetricsMetadataEntity)
            const floorMs = await this.readAcceptanceFloor(metadataStore)

            let usageRows = 0
            let performanceRows = 0
            let duplicate = 0
            let lateExpired = 0

            for (const event of events) {
                if (floorMs !== undefined && event.observedAtMs < floorMs) {
                    lateExpired += 1
                    continue
                }
                const receiptKey = idempotencyKey(event.taskId, event.eventId)
                if (await hasReceipt(metadataStore, this.scope.scopeId, receiptKey)) {
                    duplicate += 1
                    continue
                }
                if (isUsageEvent(event)) {
                    await this.accumulateUsage(usageStore, event)
                    usageRows += 1
                } else {
                    await this.accumulatePerformance(performanceStore, event as PerformanceEvent)
                    performanceRows += 1
                }
                await metadataStore.insert([receiptRow(this.scope.scopeId, event, receiptKey, this.now())])
            }

            return {
                accepted: usageRows + performanceRows,
                usageRows,
                performanceRows,
                duplicate,
                lateExpired,
            }
        })
    }

    /** The scope's current acceptance floor, or `undefined` when every event is accepted. */
    async acceptanceFloorMs(): Promise<number | undefined> {
        const database = this.requireDatabase()
        return await database.transaction(
            async (transaction) => await this.readAcceptanceFloor(transaction.store(MetricsMetadataEntity)),
        )
    }

    /**
     * Raise the acceptance floor. It never moves backwards.
     *
     * Lowering the floor would re-open history that rollups and retention already
     * treated as final, so the stored value is the maximum of the old and new floors.
     */
    async setAcceptanceFloor(floorMs: number): Promise<number> {
        this.assertWritable()
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const store = transaction.store(MetricsMetadataEntity)
            const current = await this.readAcceptanceFloor(store)
            const effective = current === undefined ? floorMs : Math.max(current, floorMs)
            await store.upsert([acceptanceFloorRow(this.scope.scopeId, effective, this.now())])
            return effective
        })
    }

    /**
     * Record that one legacy subject was imported, with the numbers it froze.
     *
     * Marker and baseline commit together: a marker without its baseline would claim
     * the import happened while losing the numbers it existed to preserve, and a
     * baseline without its marker would be imported a second time.
     */
    async recordLegacyImport(record: LegacyImportRecord): Promise<void> {
        this.assertWritable()
        const database = this.requireDatabase()
        await database.transaction(async (transaction) => {
            const store = transaction.store(MetricsMetadataEntity)
            const recordedAt = new Date(this.now()).toISOString()
            await store.upsert([
                legacyRow(this.scope.scopeId, "legacy_marker", record.subjectKey, recordedAt),
                legacyRow(this.scope.scopeId, "legacy_baseline", record.subjectKey, recordedAt, record),
            ])
        })
    }

    /**
     * Whether one legacy subject was ever imported, independent of its numbers.
     *
     * The marker is the durable record of the import. A clear removes only the frozen
     * numbers, so a migration that asked for the baseline would see "never imported"
     * and write the cleared usage back; asking for the marker is what makes "cleared
     * once" stay cleared.
     */
    async hasLegacyImport(subjectKey: string): Promise<boolean> {
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const rows = await transaction.store(MetricsMetadataEntity).query({
                where: metadataWhere(this.scope.scopeId, "legacy_marker", subjectKey),
                limit: 1,
            })
            return rows.length > 0
        })
    }

    /** One legacy subject's frozen baseline, or `undefined` when it was never imported. */
    async readLegacyBaseline(subjectKey: string): Promise<LegacyImportRecord | undefined> {
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const rows = await transaction.store(MetricsMetadataEntity).query({
                where: metadataWhere(this.scope.scopeId, "legacy_baseline", subjectKey),
                limit: 1,
            })
            const row = rows[0]
            if (!row) return undefined
            return {
                subjectKey: row.subjectKey,
                inputTokens: row.legacyInputTokens ?? 0,
                outputTokens: row.legacyOutputTokens ?? 0,
                ...(row.legacyCost === null || row.legacyCost === undefined ? {} : { cost: row.legacyCost }),
                ...(row.legacyCurrency === null || row.legacyCurrency === undefined || row.legacyCurrency === ""
                    ? {}
                    : { currency: row.legacyCurrency }),
            }
        })
    }

    /**
     * Fold finished buckets into the next coarser resolution.
     *
     * A source bucket is eligible only when it can no longer receive a legal late
     * event, i.e. when it ended at or before the acceptance floor. With no floor
     * recorded, no bucket is final and nothing is folded — that is the honest answer,
     * not an arbitrary age threshold.
     */
    async rollup(options: MetricsRollupOptions): Promise<MetricsRollupOutcome> {
        this.assertWritable()
        const { sourceResolution, targetResolution, beforeMs } = options
        if (RESOLUTION_MS[targetResolution] <= RESOLUTION_MS[sourceResolution]) {
            throw new Error("A rollup target must be coarser than its source resolution")
        }
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const metadataStore = transaction.store(MetricsMetadataEntity)
            const floorMs = await this.readAcceptanceFloor(metadataStore)
            const usageStore = transaction.store(UsageEntity)
            const performanceStore = transaction.store(PerformanceEntity)
            const isFinal = (bucketStartMs: number, resolution: MetricsResolution): boolean =>
                floorMs !== undefined &&
                bucketStartMs + RESOLUTION_MS[resolution] <= floorMs &&
                bucketStartMs + RESOLUTION_MS[resolution] <= beforeMs

            let sourceRowsRemoved = 0
            let targetRowsWritten = 0

            const usageSources = (
                await usageStore.query({
                    where: and(
                        eq(UsageEntity.storage.fields.scopeId, this.scope.scopeId),
                        eq(UsageEntity.storage.fields.resolution, sourceResolution),
                    ),
                })
            ).filter((row) => isFinal(row.bucketStartMs, sourceResolution))
            for (const group of groupUsageRows(usageSources, targetResolution)) {
                const reduced = group.reduce((base, row) => mergeUsageRowPair(base, row))
                // A target bucket may already hold rows from an earlier rollup pass, so the
                // new contribution is merged onto the stored value instead of replacing it.
                const existing = await usageStore.query({ where: usageIdentityWhere(reduced), limit: 1 })
                const merged = existing[0] ? mergeUsageRowPair(toUsageRow(existing[0]), reduced) : reduced
                await usageStore.upsert([toUsageEntityValues(merged, this.now())])
                targetRowsWritten += 1
            }
            for (const row of usageSources) {
                await usageStore.deleteWhere(usageIdentityWhere(row))
                sourceRowsRemoved += 1
            }

            const performanceSources = (
                await performanceStore.query({
                    where: and(
                        eq(PerformanceEntity.storage.fields.scopeId, this.scope.scopeId),
                        eq(PerformanceEntity.storage.fields.resolution, sourceResolution),
                    ),
                })
            ).filter((row) => isFinal(row.bucketStartMs, sourceResolution))
            for (const group of groupPerformanceRows(performanceSources, targetResolution)) {
                const reduced = group.reduce((base, row) => mergePerformanceRowPair(base, row))
                const existing = await performanceStore.query({ where: performanceIdentityWhere(reduced), limit: 1 })
                const merged = existing[0] ? mergePerformanceRowPair(toPerformanceRow(existing[0]), reduced) : reduced
                await performanceStore.upsert([toPerformanceEntityValues(merged, this.now())])
                targetRowsWritten += 1
            }
            for (const row of performanceSources) {
                await performanceStore.deleteWhere(performanceIdentityWhere(row))
                sourceRowsRemoved += 1
            }

            return { sourceRowsRemoved, targetRowsWritten }
        })
    }

    /**
     * Apply retention and advance the acceptance floor in one transaction.
     *
     * Receipts whose events are all below the new floor are removed: the floor alone
     * already rejects those events, so dropping the receipts cannot make one reapply.
     */
    async prune(options: MetricsPruneOptions): Promise<MetricsPruneOutcome> {
        this.assertWritable()
        if (options.acceptanceFloorMs > options.retentionStartMs) {
            throw new Error("The acceptance floor cannot be newer than the retention start")
        }
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const usageStore = transaction.store(UsageEntity)
            const performanceStore = transaction.store(PerformanceEntity)
            const metadataStore = transaction.store(MetricsMetadataEntity)

            const usageRowsRemoved = await countRows(
                usageStore,
                and(
                    eq(UsageEntity.storage.fields.scopeId, this.scope.scopeId),
                    lt(UsageEntity.storage.fields.bucketStartMs, options.retentionStartMs),
                ),
            )
            await usageStore.deleteWhere(
                and(
                    eq(UsageEntity.storage.fields.scopeId, this.scope.scopeId),
                    lt(UsageEntity.storage.fields.bucketStartMs, options.retentionStartMs),
                ),
            )
            const performanceRowsRemoved = await countRows(
                performanceStore,
                and(
                    eq(PerformanceEntity.storage.fields.scopeId, this.scope.scopeId),
                    lt(PerformanceEntity.storage.fields.bucketStartMs, options.retentionStartMs),
                ),
            )
            await performanceStore.deleteWhere(
                and(
                    eq(PerformanceEntity.storage.fields.scopeId, this.scope.scopeId),
                    lt(PerformanceEntity.storage.fields.bucketStartMs, options.retentionStartMs),
                ),
            )

            const receiptsRemoved = await countRows(
                metadataStore,
                and(
                    eq(MetricsMetadataEntity.storage.fields.scopeId, this.scope.scopeId),
                    eq(MetricsMetadataEntity.storage.fields.kind, "receipt"),
                    lt(MetricsMetadataEntity.storage.fields.observedAtMs, options.acceptanceFloorMs),
                ),
            )
            await metadataStore.deleteWhere(
                and(
                    eq(MetricsMetadataEntity.storage.fields.scopeId, this.scope.scopeId),
                    eq(MetricsMetadataEntity.storage.fields.kind, "receipt"),
                    lt(MetricsMetadataEntity.storage.fields.observedAtMs, options.acceptanceFloorMs),
                ),
            )

            const current = await this.readAcceptanceFloor(metadataStore)
            const effective = current === undefined ? options.acceptanceFloorMs : Math.max(current, options.acceptanceFloorMs)
            await metadataStore.upsert([acceptanceFloorRow(this.scope.scopeId, effective, this.now())])

            return {
                usageRowsRemoved,
                performanceRowsRemoved,
                receiptsRemoved,
                acceptanceFloorMs: effective,
            }
        })
    }

    /**
     * Refuse a write on a reader.
     *
     * A readonly connection cannot commit, and letting the attempt reach SQLite would
     * report a generic failure instead of the real mistake: the call came from a path
     * that must never write this scope.
     */
    private assertWritable(): void {
        if (this.readOnly) throw new Error("A read-only metrics ledger cannot record or mutate rows")
    }

    /** Read usage rows for one scope, narrowable by identity columns and bucket range. */
    async readUsageRows(options: MetricsReadOptions = {}): Promise<UsageRow[]> {
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) =>
            (await transaction.store(UsageEntity).query({ where: usageReadWhere(this.scope.scopeId, options) })).map(toUsageRow),
        )
    }

    /** Read performance rows for one scope, narrowable by identity columns and bucket range. */
    async readPerformanceRows(options: MetricsReadOptions = {}): Promise<PerformanceRow[]> {
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) =>
            (
                await transaction.store(PerformanceEntity).query({
                    where: performanceReadWhere(this.scope.scopeId, options),
                })
            ).map(toPerformanceRow),
        )
    }

    /**
     * Delete matching rows and, when the deletion covers a whole legacy subject,
     * release the frozen numeric baseline.
     *
     * The marker stays until `clearAll`: it records that the import happened, and
     * dropping it on a partial clear would let a restart re-import numbers the user
     * just deleted.
     */
    async clearUsageRows(options: MetricsReadOptions = {}, releaseLegacyBaseline = false): Promise<number> {
        this.assertWritable()
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const store = transaction.store(UsageEntity)
            const where = usageReadWhere(this.scope.scopeId, options)
            const removed = await countRows(store, where)
            await store.deleteWhere(where)
            if (releaseLegacyBaseline) {
                await releaseLegacyNumerics(transaction.store(MetricsMetadataEntity), this.scope.scopeId)
            }
            return removed
        })
    }

    /** Delete matching performance rows. */
    async clearPerformanceRows(options: MetricsReadOptions = {}): Promise<number> {
        this.assertWritable()
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const store = transaction.store(PerformanceEntity)
            const where = performanceReadWhere(this.scope.scopeId, options)
            const removed = await countRows(store, where)
            await store.deleteWhere(where)
            return removed
        })
    }

    /**
     * Clear every number in the scope while keeping the bookkeeping that protects them.
     *
     * Only the legacy *baseline* is a number, so it goes with the rows. The migrated
     * marker, the receipts and the acceptance floor stay: they are what stops the retained
     * legacy state from resurrecting cleared usage after a restart, and what keeps an
     * already-rejected fact rejected. Dropping them turned "clear" into "re-importable",
     * which is the opposite of AC-11.
     */
    async clearAll(): Promise<{ usageRows: number; performanceRows: number; metadataRows: number }> {
        this.assertWritable()
        const database = this.requireDatabase()
        return await database.transaction(async (transaction) => {
            const usageStore = transaction.store(UsageEntity)
            const performanceStore = transaction.store(PerformanceEntity)
            const metadataStore = transaction.store(MetricsMetadataEntity)
            const scopeUsage: UnifyStorePredicate<UsageEntityValues> = eq(UsageEntity.storage.fields.scopeId, this.scope.scopeId)
            const scopePerformance: UnifyStorePredicate<PerformanceEntityValues> = eq(
                PerformanceEntity.storage.fields.scopeId,
                this.scope.scopeId,
            )
            // Only the baseline carries a number. `legacy_marker`, `receipt` and
            // `acceptance_floor` are protection metadata and must survive a clear.
            const baselineMetadata: UnifyStorePredicate<MetricsMetadataEntityValues> = and(
                eq(MetricsMetadataEntity.storage.fields.scopeId, this.scope.scopeId),
                eq(MetricsMetadataEntity.storage.fields.kind, "legacy_baseline"),
            )
            const usageRows = await countRows(usageStore, scopeUsage)
            const performanceRows = await countRows(performanceStore, scopePerformance)
            const metadataRows = await countRows(metadataStore, baselineMetadata)
            await usageStore.deleteWhere(scopeUsage)
            await performanceStore.deleteWhere(scopePerformance)
            await metadataStore.deleteWhere(baselineMetadata)
            return { usageRows, performanceRows, metadataRows }
        })
    }

    /** Release the database handle. Safe to call more than once. */
    async close(): Promise<void> {
        this.closePromise ??= (async () => {
            const database = this.database
            this.database = undefined
            await database?.close()
        })()
        return await this.closePromise
    }

    private requireDatabase(): TransactionalUnifyStoreDatabase {
        if (!this.database) throw new Error("Metrics ledger is closed")
        return this.database
    }

    private async readAcceptanceFloor(
        store: UnifyStoreCollectionTransaction<MetricsMetadataEntityValues>,
    ): Promise<number | undefined> {
        const rows = await store.query({
            where: metadataWhere(this.scope.scopeId, "acceptance_floor", ACCEPTANCE_FLOOR_SUBJECT),
            limit: 1,
        })
        const floorMs = rows[0]?.floorMs
        return floorMs === null || floorMs === undefined ? undefined : floorMs
    }

    /** Read-then-write accumulation; the read is inside the caller's transaction. */
    private async accumulateUsage(store: UnifyStoreCollectionTransaction<UsageEntityValues>, event: UsageEvent): Promise<void> {
        const identity = usageIdentityOf(this.scope.scopeId, event)
        const rows = await store.query({ where: usageIdentityWhere(identity), limit: 1 })
        const current = rows[0]
        const base: UsageBody = current ? usageBodyOf(current) : emptyUsageRow()
        const accumulated = accumulateUsage(base, event)
        const row: UsageRow = {
            ...identity,
            providerId: current?.providerId ?? event.providerId,
            ...accumulated,
            aggregatedAt: new Date(this.now()).toISOString(),
        }
        await store.upsert([toUsageEntityValues(row, this.now())])
    }

    /** Read-then-write accumulation for one performance fact kind. */
    private async accumulatePerformance(
        store: UnifyStoreCollectionTransaction<PerformanceEntityValues>,
        event: PerformanceEvent,
    ): Promise<void> {
        const identity = performanceIdentityOf(this.scope.scopeId, event)
        const rows = await store.query({ where: performanceIdentityWhere(identity), limit: 1 })
        const current = rows[0]
        const base: PerformanceBody = current ? performanceBodyOf(current) : emptyPerformanceRowBody()
        const accumulated = accumulatePerformance(base, event)
        const row: PerformanceRow = {
            ...identity,
            providerId: current?.providerId ?? event.providerId,
            ...accumulated,
            aggregatedAt: new Date(this.now()).toISOString(),
        }
        await store.upsert([toPerformanceEntityValues(row, this.now())])
    }
}

/** Identity filter shared by reads and clears. */
export interface MetricsReadOptions {
    readonly profileId?: string
    readonly taskId?: string
    readonly modelId?: string
    readonly keyFingerprint?: string
    /** Inclusive lower bound on `bucketStartMs`. */
    readonly fromMs?: number
    /** Exclusive upper bound on `bucketStartMs`. */
    readonly toMs?: number
}

/** Storage shapes use `null` for absent values; domain rows keep them optional. */
export function toUsageEntityValues(row: UsageRow, nowMs: number): UsageEntityValues {
    return {
        ...row,
        cost: row.cost ?? null,
        currency: row.currency ?? null,
        aggregatedAt: row.aggregatedAt === "" ? new Date(nowMs).toISOString() : row.aggregatedAt,
    }
}

export function toPerformanceEntityValues(row: PerformanceRow, _nowMs: number): PerformanceEntityValues {
    return { ...row }
}

function toUsageRow(values: UsageEntityValues): UsageRow {
    const { cost, currency, ...rest } = values
    return { ...rest, ...(cost === null ? {} : { cost }), ...(currency === null ? {} : { currency }) }
}

function toPerformanceRow(values: PerformanceEntityValues): PerformanceRow {
    return { ...values }
}

/** The accumulator body of a stored row, so `accumulateUsage` sees only numbers. */
function usageBodyOf(values: UsageEntityValues): UsageBody {
    const row = toUsageRow(values)
    const {
        scopeId: _scopeId,
        resolution: _resolution,
        bucketStartMs: _bucketStartMs,
        modelId: _modelId,
        taskId: _taskId,
        profileId: _profileId,
        keyFingerprint: _keyFingerprint,
        providerId: _providerId,
        aggregatedAt: _aggregatedAt,
        ...body
    } = row
    return body
}

function performanceBodyOf(values: PerformanceEntityValues): PerformanceBody {
    const row = toPerformanceRow(values)
    const {
        scopeId: _scopeId,
        resolution: _resolution,
        bucketStartMs: _bucketStartMs,
        modelId: _modelId,
        taskId: _taskId,
        profileId: _profileId,
        keyFingerprint: _keyFingerprint,
        providerId: _providerId,
        factKind: _factKind,
        aggregatedAt: _aggregatedAt,
        ...body
    } = row
    return body
}

function usageIdentityOf(scopeId: string, event: UsageEvent): MetricsRowIdentity {
    return {
        scopeId,
        resolution: EVENT_RESOLUTION,
        bucketStartMs: bucketStartOf(event.observedAtMs, EVENT_RESOLUTION),
        modelId: event.modelId,
        taskId: event.taskId,
        profileId: event.profileId,
        keyFingerprint: event.keyFingerprint,
    }
}

function performanceIdentityOf(
    scopeId: string,
    event: PerformanceEvent,
): MetricsRowIdentity & { factKind: PerformanceEvent["factKind"] } {
    return {
        scopeId,
        resolution: EVENT_RESOLUTION,
        bucketStartMs: bucketStartOf(event.observedAtMs, EVENT_RESOLUTION),
        modelId: event.modelId,
        taskId: event.taskId,
        profileId: event.profileId,
        keyFingerprint: event.keyFingerprint,
        factKind: event.factKind,
    }
}

function usageIdentityWhere(identity: MetricsRowIdentity): UnifyStorePredicate<UsageEntityValues> {
    const fields = UsageEntity.storage.fields
    return and(
        eq(fields.scopeId, identity.scopeId),
        eq(fields.resolution, identity.resolution),
        eq(fields.bucketStartMs, identity.bucketStartMs),
        eq(fields.modelId, identity.modelId),
        eq(fields.taskId, identity.taskId),
        eq(fields.profileId, identity.profileId),
        eq(fields.keyFingerprint, identity.keyFingerprint),
    )
}

function performanceIdentityWhere(
    identity: MetricsRowIdentity & { factKind: PerformanceEvent["factKind"] },
): UnifyStorePredicate<PerformanceEntityValues> {
    const fields = PerformanceEntity.storage.fields
    return and(
        eq(fields.scopeId, identity.scopeId),
        eq(fields.resolution, identity.resolution),
        eq(fields.bucketStartMs, identity.bucketStartMs),
        eq(fields.modelId, identity.modelId),
        eq(fields.taskId, identity.taskId),
        eq(fields.profileId, identity.profileId),
        eq(fields.keyFingerprint, identity.keyFingerprint),
        eq(fields.factKind, identity.factKind),
    )
}

function usageReadWhere(scopeId: string, options: MetricsReadOptions): UnifyStorePredicate<UsageEntityValues> {
    const fields = UsageEntity.storage.fields
    const predicates: UnifyStorePredicate<UsageEntityValues>[] = [eq(fields.scopeId, scopeId)]
    if (options.profileId !== undefined) predicates.push(eq(fields.profileId, options.profileId))
    if (options.taskId !== undefined) predicates.push(eq(fields.taskId, options.taskId))
    if (options.modelId !== undefined) predicates.push(eq(fields.modelId, options.modelId))
    if (options.keyFingerprint !== undefined) predicates.push(eq(fields.keyFingerprint, options.keyFingerprint))
    if (options.fromMs !== undefined) predicates.push(gte(fields.bucketStartMs, options.fromMs))
    if (options.toMs !== undefined) predicates.push(lt(fields.bucketStartMs, options.toMs))
    return and(...predicates)
}

function performanceReadWhere(scopeId: string, options: MetricsReadOptions): UnifyStorePredicate<PerformanceEntityValues> {
    const fields = PerformanceEntity.storage.fields
    const predicates: UnifyStorePredicate<PerformanceEntityValues>[] = [eq(fields.scopeId, scopeId)]
    if (options.profileId !== undefined) predicates.push(eq(fields.profileId, options.profileId))
    if (options.taskId !== undefined) predicates.push(eq(fields.taskId, options.taskId))
    if (options.modelId !== undefined) predicates.push(eq(fields.modelId, options.modelId))
    if (options.keyFingerprint !== undefined) predicates.push(eq(fields.keyFingerprint, options.keyFingerprint))
    if (options.fromMs !== undefined) predicates.push(gte(fields.bucketStartMs, options.fromMs))
    if (options.toMs !== undefined) predicates.push(lt(fields.bucketStartMs, options.toMs))
    return and(...predicates)
}

function metadataWhere(
    scopeId: string,
    kind: MetricsMetadataEntityValues["kind"],
    subjectKey: string,
): UnifyStorePredicate<MetricsMetadataEntityValues> {
    const fields = MetricsMetadataEntity.storage.fields
    return and(eq(fields.scopeId, scopeId), eq(fields.kind, kind), eq(fields.subjectKey, subjectKey))
}

async function hasReceipt(
    store: UnifyStoreCollectionTransaction<MetricsMetadataEntityValues>,
    scopeId: string,
    receiptKey: string,
): Promise<boolean> {
    const rows = await store.query({ where: metadataWhere(scopeId, "receipt", receiptKey), limit: 1 })
    return rows.length > 0
}

function receiptRow(scopeId: string, event: MetricsEvent, receiptKey: string, nowMs: number): MetricsMetadataEntityValues {
    return {
        scopeId,
        kind: "receipt",
        subjectKey: receiptKey,
        eventId: event.eventId,
        taskId: event.taskId,
        floorMs: null,
        observedAtMs: event.observedAtMs,
        legacyInputTokens: null,
        legacyOutputTokens: null,
        legacyCost: null,
        legacyCurrency: null,
        recordedAt: new Date(nowMs).toISOString(),
    }
}

function acceptanceFloorRow(scopeId: string, floorMs: number, nowMs: number): MetricsMetadataEntityValues {
    return {
        scopeId,
        kind: "acceptance_floor",
        subjectKey: ACCEPTANCE_FLOOR_SUBJECT,
        eventId: "",
        taskId: "",
        floorMs,
        observedAtMs: null,
        legacyInputTokens: null,
        legacyOutputTokens: null,
        legacyCost: null,
        legacyCurrency: null,
        recordedAt: new Date(nowMs).toISOString(),
    }
}

function legacyRow(
    scopeId: string,
    kind: "legacy_marker" | "legacy_baseline",
    subjectKey: string,
    recordedAt: string,
    record?: LegacyImportRecord,
): MetricsMetadataEntityValues {
    return {
        scopeId,
        kind,
        subjectKey,
        eventId: "",
        taskId: "",
        floorMs: null,
        observedAtMs: null,
        legacyInputTokens: record?.inputTokens ?? null,
        legacyOutputTokens: record?.outputTokens ?? null,
        legacyCost: record?.cost ?? null,
        legacyCurrency: record?.currency ?? null,
        recordedAt,
    }
}

/**
 * Drop the frozen numbers of every legacy baseline while keeping its marker.
 *
 * A cleared account must not resurrect the old inclusive total, but re-importing it
 * would also undo the clear, so only the numbers go.
 */
async function releaseLegacyNumerics(
    store: UnifyStoreCollectionTransaction<MetricsMetadataEntityValues>,
    scopeId: string,
): Promise<void> {
    const fields = MetricsMetadataEntity.storage.fields
    const rows = await store.query({
        where: and(eq(fields.scopeId, scopeId), eq(fields.kind, "legacy_baseline")),
    })
    if (rows.length === 0) return
    await store.upsert(
        rows.map((row) => ({
            ...row,
            legacyInputTokens: null,
            legacyOutputTokens: null,
            legacyCost: null,
            legacyCurrency: null,
        })),
    )
}

async function countRows<TEntity extends object>(
    store: UnifyStoreCollectionTransaction<TEntity>,
    where: UnifyStorePredicate<TEntity>,
): Promise<number> {
    return (await store.query({ where })).length
}

/** Group source rows by everything except resolution and bucket start. */
function groupUsageRows(rows: readonly UsageEntityValues[], target: MetricsResolution): UsageRow[][] {
    const groups = new Map<string, UsageRow[]>()
    for (const values of rows) {
        const row = toUsageRow(values)
        const key = [
            row.scopeId,
            target,
            bucketStartOf(row.bucketStartMs, target),
            row.modelId,
            row.taskId,
            row.profileId,
            row.keyFingerprint,
            // `providerId` is deliberately absent: the target primary key does not include
            // it, so grouping by it would emit several groups that overwrite one row.
        ].join("|")
        const bucket = groups.get(key)
        const projected: UsageRow = {
            ...row,
            resolution: target,
            bucketStartMs: bucketStartOf(row.bucketStartMs, target),
        }
        if (bucket) bucket.push(projected)
        else groups.set(key, [projected])
    }
    return [...groups.values()]
}

function groupPerformanceRows(rows: readonly PerformanceEntityValues[], target: MetricsResolution): PerformanceRow[][] {
    const groups = new Map<string, PerformanceRow[]>()
    for (const values of rows) {
        const row = toPerformanceRow(values)
        const key = [
            row.scopeId,
            target,
            bucketStartOf(row.bucketStartMs, target),
            row.modelId,
            row.taskId,
            row.profileId,
            row.keyFingerprint,
            // Same reason as usage: `providerId` is not part of the target primary key.
            row.factKind,
        ].join("|")
        const bucket = groups.get(key)
        const projected: PerformanceRow = {
            ...row,
            resolution: target,
            bucketStartMs: bucketStartOf(row.bucketStartMs, target),
        }
        if (bucket) bucket.push(projected)
        else groups.set(key, [projected])
    }
    return [...groups.values()]
}

/** Fold two already-projected rows into one coarser row. */
function mergeUsageRowPair(base: UsageRow, next: UsageRow): UsageRow {
    return { ...base, ...mergeUsageBodies(usageBodyOfRow(base), usageBodyOfRow(next)) }
}

/** Fold two already-projected performance rows into one coarser row. */
function mergePerformanceRowPair(base: PerformanceRow, next: PerformanceRow): PerformanceRow {
    return { ...base, ...mergePerformanceBodies(performanceBodyOfRow(base), performanceBodyOfRow(next)) }
}

function usageBodyOfRow(row: UsageRow): UsageBody {
    const {
        scopeId: _scopeId,
        resolution: _resolution,
        bucketStartMs: _bucketStartMs,
        modelId: _modelId,
        taskId: _taskId,
        profileId: _profileId,
        keyFingerprint: _keyFingerprint,
        providerId: _providerId,
        aggregatedAt: _aggregatedAt,
        ...body
    } = row
    return body
}

function performanceBodyOfRow(row: PerformanceRow): PerformanceBody {
    const {
        scopeId: _scopeId,
        resolution: _resolution,
        bucketStartMs: _bucketStartMs,
        modelId: _modelId,
        taskId: _taskId,
        profileId: _profileId,
        keyFingerprint: _keyFingerprint,
        providerId: _providerId,
        factKind: _factKind,
        aggregatedAt: _aggregatedAt,
        ...body
    } = row
    return body
}

/** Row-level addition used by rollups; the arithmetic lives in the shared merge module. */
export type { PerformanceBody, UsageBody }
