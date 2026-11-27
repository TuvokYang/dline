import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { and, asc, desc, eq, gte, latestPerGroup, lt } from "@core/storage/backend/api/UnifyStoreQuery"
import { createApiResponseExecutionCollection } from "./api-response-execution-collection"
import {
    ApiResponseExecutionEntity,
    fromApiResponseExecutionEntity,
    toApiResponseExecutionEntity,
} from "./api-response-execution-entity"
import type {
    ApiResponseExecutionRangeQuery,
    ApiResponseExecutionRangeSnapshotQuery,
    ApiResponseExecutionRecord,
    ApiResponseExecutionRepository,
} from "./api-response-execution-types"
import { scanNewestGroups } from "./newest-group-scan"

export interface TaskApiResponseExecutionRepositoryOptions {
    readonly taskId: string
    readonly location?: string
    readonly readOnly?: boolean
}

const DEFAULT_RECENT_EXECUTION_LIMIT = 60
/** Physical rows one recent read inspects before selecting; an execution holds few revisions. */
const DEFAULT_RECENT_SCAN_ROWS = 4_096

/** Executions one range read keeps; see the round repository's round budget. */
const DEFAULT_RANGE_MAX_ROUNDS = 32_768

/** Physical-row safety ceiling for a range scan across every widening. */
const DEFAULT_RANGE_SCAN_ROWS = 262_144

/** Owns canonical complete-execution persistence for one Task. */
export class TaskApiResponseExecutionRepository implements ApiResponseExecutionRepository {
    private collection: UnifyStore<ApiResponseExecutionEntity> | undefined
    private initialization: Promise<void> | undefined
    private writeSequence: Promise<void> = Promise.resolve()
    private closing = false
    private closed = false
    private closePromise: Promise<void> | undefined

    constructor(private readonly options: TaskApiResponseExecutionRepositoryOptions) {}

    async append(records: readonly ApiResponseExecutionRecord[]): Promise<void> {
        this.assertWritable()
        if (records.length === 0) return
        for (const record of records) {
            if (record.taskId !== this.options.taskId) {
                throw new Error(
                    `API response execution Task mismatch: expected ${this.options.taskId}, received ${record.taskId}`,
                )
            }
        }
        await this.initialize()
        const entities = records.map(toApiResponseExecutionEntity)
        return this.enqueueWrite(() => this.requireCollection().insert(entities))
    }

    async readRecent(limit = DEFAULT_RECENT_EXECUTION_LIMIT): Promise<ApiResponseExecutionRecord[]> {
        assertPositiveLimit(limit, "API response execution recent limit")
        await this.initialize()
        await this.waitForWrites()
        const fields = ApiResponseExecutionEntity.storage.fields
        // Mirror the round repository: order by the composite (taskId, completedAtMs, revision)
        // index and cap physical rows before deduplicating instead of running latestPerGroup over
        // the entire history on every Task open.
        const result = await this.requireCollection().query({
            where: eq(fields.taskId, this.options.taskId),
            orderBy: [desc(fields.completedAtMs), desc(fields.revision)],
            limit: Math.max(limit, DEFAULT_RECENT_SCAN_ROWS),
        })
        return selectLatestExecutions(result.records.map(fromApiResponseExecutionEntity)).slice(-limit)
    }

    async readRange(query: ApiResponseExecutionRangeQuery): Promise<ApiResponseExecutionRecord[]> {
        assertRangeQuery(query)
        await this.initialize()
        await this.waitForWrites()
        const fields = ApiResponseExecutionEntity.storage.fields
        const result = await this.requireCollection().query({
            where: and(
                eq(fields.taskId, this.options.taskId),
                gte(fields.completedAtMs, query.startMs),
                lt(fields.completedAtMs, query.endMs),
            ),
            select: latestPerGroup({ groupBy: [fields.executionId], orderBy: [desc(fields.revision)] }),
            orderBy: [asc(fields.completedAtMs), asc(fields.providerAttempt)],
            limit: query.maxPoints,
        })
        return result.records.map(fromApiResponseExecutionEntity)
    }

    async readRangeSnapshot(query: ApiResponseExecutionRangeSnapshotQuery): Promise<ApiResponseExecutionRecord[]> {
        assertRangeSnapshotQuery(query)
        await this.initialize()
        await this.waitForWrites()
        const fields = ApiResponseExecutionEntity.storage.fields
        // Cap the source rows before selecting, for the same reason as the round
        // repository: a ranking selection makes SQLite materialize the whole window
        // before LIMIT applies, so the bound has to limit physical rows instead. The
        // bound counts executions, so extra revisions cost rows rather than coverage.
        const scan = await scanNewestGroups<ApiResponseExecutionRecord>({
            targetGroups: query.maxRounds ?? DEFAULT_RANGE_MAX_ROUNDS,
            maxScanRows: DEFAULT_RANGE_SCAN_ROWS,
            keyOf: ({ executionId }) => executionId,
            fetch: async (limit) => {
                const result = await this.requireCollection().query({
                    where: and(
                        eq(fields.taskId, this.options.taskId),
                        gte(fields.completedAtMs, query.startMs),
                        lt(fields.completedAtMs, query.endMs),
                    ),
                    orderBy: [desc(fields.completedAtMs), desc(fields.revision)],
                    limit,
                })
                return result.records.map(fromApiResponseExecutionEntity)
            },
        })
        const executions = selectLatestExecutions(scan.rows)
        const target = query.maxRounds ?? DEFAULT_RANGE_MAX_ROUNDS
        return executions.length > target ? executions.slice(-target) : executions
    }

    async waitForWrites(): Promise<void> {
        await this.writeSequence
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise
        this.closing = true
        this.closePromise = (async () => {
            try {
                await this.writeSequence
                await this.initialization?.catch(() => undefined)
                await this.collection?.close()
            } finally {
                this.closed = true
                this.collection = undefined
            }
        })()
        return this.closePromise
    }

    private initialize(): Promise<void> {
        if (this.closing || this.closed) return Promise.reject(new Error("API response execution repository is closed"))
        this.initialization ??= createApiResponseExecutionCollection(this.options).then((collection) => {
            this.collection = collection
        })
        return this.initialization
    }

    private enqueueWrite(operation: () => Promise<void>): Promise<void> {
        const result = this.writeSequence.then(operation)
        this.writeSequence = result.then(
            () => undefined,
            () => undefined,
        )
        return result
    }

    private requireCollection(): UnifyStore<ApiResponseExecutionEntity> {
        if (!this.collection) throw new Error("API response execution repository is not initialized")
        return this.collection
    }

    private assertWritable(): void {
        if (this.closing || this.closed) throw new Error("API response execution repository is closed")
        if (this.options.readOnly) throw new Error("API response execution repository is read-only")
    }
}

/**
 * Keep only the highest revision of each execution, in the order the rows arrived.
 *
 * The in-memory equivalent of the `latestPerGroup` selection, applied after the
 * row cap so the ranking cost is bounded by the cap rather than the window size.
 */
function selectLatestExecutions(records: readonly ApiResponseExecutionRecord[]): ApiResponseExecutionRecord[] {
    const latest = new Map<string, ApiResponseExecutionRecord>()
    for (const record of records) {
        const current = latest.get(record.executionId)
        if (!current || record.revision > current.revision) latest.set(record.executionId, record)
    }
    return [...latest.values()].sort(
        (left, right) =>
            left.completedAtMs - right.completedAtMs ||
            left.providerAttempt - right.providerAttempt ||
            left.executionId.localeCompare(right.executionId),
    )
}

function assertPositiveLimit(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
}

function assertRangeQuery(query: ApiResponseExecutionRangeQuery): void {
    assertRange(query.startMs, query.endMs)
    assertPositiveLimit(query.maxPoints, "API response execution range maxPoints")
}

function assertRangeSnapshotQuery(query: ApiResponseExecutionRangeSnapshotQuery): void {
    assertRange(query.startMs, query.endMs)
    if (!Number.isSafeInteger(query.pageSize) || query.pageSize < 2) {
        throw new Error("API response execution range pageSize must be an integer of at least two")
    }
}

function assertRange(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        throw new Error("API response execution range must use increasing finite milliseconds")
    }
}
