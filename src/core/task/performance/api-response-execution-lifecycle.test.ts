import { describe, expect, it, vi } from "vitest"
import type { ApiRequestRoundHandle } from "./api-request-round-tracker"
import type { ApiRequestRoundRecord } from "./api-request-round-types"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import type {
    ApiResponseExecutionRecord,
    ApiResponseExecutionRepository,
    ApiResponseExecutionToolSummary,
} from "./api-response-execution-types"

class MemoryExecutionRepository implements ApiResponseExecutionRepository {
    readonly records: ApiResponseExecutionRecord[] = []
    readonly appendAttempts: ApiResponseExecutionRecord[][] = []
    closed = false
    failNextAppend = false

    constructor(private readonly recovered: readonly ApiResponseExecutionRecord[] = []) {}

    async append(records: readonly ApiResponseExecutionRecord[]): Promise<void> {
        this.appendAttempts.push([...records])
        if (this.failNextAppend) {
            this.failNextAppend = false
            throw new Error("execution append failed")
        }
        this.records.push(...records)
    }
    async readRecent(limit = 60): Promise<ApiResponseExecutionRecord[]> {
        return this.recovered.slice(-limit)
    }
    async readRange(): Promise<ApiResponseExecutionRecord[]> {
        return []
    }
    async readRangeSnapshot(): Promise<ApiResponseExecutionRecord[]> {
        return []
    }
    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {
        this.closed = true
    }
}

function handle(roundId = "task-a:request-a:provider:0"): ApiRequestRoundHandle {
    return {
        roundId,
        logicalRequestId: "request-a",
        apiIndex: 7,
        taskAttempt: 0,
        providerAttempt: Number(roundId.at(-1) ?? 0),
        startedAtMs: 1_000,
        startedMonotonicMs: 100,
    }
}

function providerTerminal(
    roundHandle: ApiRequestRoundHandle,
    status: ApiRequestRoundRecord["status"] = "completed",
): ApiRequestRoundRecord {
    return {
        schemaVersion: 1,
        taskId: "task-a",
        roundId: roundHandle.roundId,
        revision: 0,
        logicalRequestId: roundHandle.logicalRequestId,
        apiIndex: roundHandle.apiIndex,
        taskAttempt: roundHandle.taskAttempt,
        providerAttempt: roundHandle.providerAttempt,
        startedAtMs: roundHandle.startedAtMs,
        completedAtMs: 3_000,
        providerDurationMs: 2_000,
        status,
        cacheUsageReported: false,
        usageQuality: "none",
    }
}

function executionRecord(
    executionId: string,
    completedAtMs: number,
    executionDurationMs: number,
    revision = 0,
): ApiResponseExecutionRecord {
    return {
        schemaVersion: 1,
        taskId: "task-a",
        executionId,
        revision,
        roundId: executionId,
        logicalRequestId: executionId,
        apiIndex: completedAtMs,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs: Math.max(0, completedAtMs - executionDurationMs),
        providerCompletedAtMs: completedAtMs,
        completedAtMs,
        providerDurationMs: executionDurationMs,
        executionDurationMs,
        status: "completed",
        terminalKind: "provider_only",
        toolCount: 0,
        completedToolCount: 0,
        failedToolCount: 0,
        cancelledToolCount: 0,
    }
}

const TOOLS_COMPLETED: ApiResponseExecutionToolSummary = {
    toolCount: 2,
    completedToolCount: 2,
    failedToolCount: 0,
    cancelledToolCount: 0,
}

describe("ApiResponseExecutionLifecycle", () => {
    it("uses Provider terminal as the complete execution boundary when no tools run", async () => {
        const repository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const roundHandle = handle()
        lifecycle.begin(roundHandle)
        wall = 3_000
        monotonic = 2_100
        lifecycle.providerTerminal(roundHandle, providerTerminal(roundHandle))
        lifecycle.completeProviderOnly(roundHandle)
        await lifecycle.waitForPersistence()

        expect(repository.records).toEqual([
            expect.objectContaining({
                executionId: roundHandle.roundId,
                providerDurationMs: 2_000,
                executionDurationMs: 2_000,
                terminalKind: "provider_only",
                status: "completed",
                toolCount: 0,
            }),
        ])
    })

    it("extends execution duration through complete tool settlement and preserves tool outcome counts", async () => {
        const repository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const roundHandle = handle()
        lifecycle.begin(roundHandle)
        wall = 3_000
        monotonic = 2_100
        lifecycle.providerTerminal(roundHandle, providerTerminal(roundHandle))
        wall = 11_000
        monotonic = 10_100
        lifecycle.completeTools(roundHandle, TOOLS_COMPLETED)
        await lifecycle.waitForPersistence()

        expect(repository.records.at(-1)).toMatchObject({
            providerDurationMs: 2_000,
            executionDurationMs: 10_000,
            terminalKind: "tools_settled",
            status: "completed",
            ...TOOLS_COMPLETED,
        })
    })

    it("keeps a successful logical request completed when some tools settle and others are skipped", async () => {
        const repository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const roundHandle = handle()
        lifecycle.begin(roundHandle)
        wall = 3_000
        monotonic = 2_100
        lifecycle.providerTerminal(roundHandle, providerTerminal(roundHandle))
        wall = 5_000
        monotonic = 4_100
        lifecycle.completeTools(roundHandle, {
            toolCount: 3,
            completedToolCount: 1,
            failedToolCount: 0,
            cancelledToolCount: 2,
        })
        await lifecycle.waitForPersistence()

        expect(repository.records.at(-1)).toMatchObject({
            status: "completed",
            completedToolCount: 1,
            cancelledToolCount: 2,
        })
    })

    it("marks a successful Provider request cancelled only when every tool was cancelled", async () => {
        const repository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const roundHandle = handle()
        lifecycle.begin(roundHandle)
        wall = 3_000
        monotonic = 2_100
        lifecycle.providerTerminal(roundHandle, providerTerminal(roundHandle))
        wall = 5_000
        monotonic = 4_100
        lifecycle.completeTools(roundHandle, {
            toolCount: 2,
            completedToolCount: 0,
            failedToolCount: 0,
            cancelledToolCount: 2,
        })
        await lifecycle.waitForPersistence()

        expect(repository.records.at(-1)?.status).toBe("cancelled")
    })

    it("automatically terminals failed Provider sends without waiting for tool coordination", async () => {
        const repository = new MemoryExecutionRepository()
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => 3_000,
            monotonicClock: () => monotonic,
        })
        const roundHandle = handle()
        lifecycle.begin(roundHandle)
        monotonic = 2_100
        lifecycle.providerTerminal(roundHandle, providerTerminal(roundHandle, "failed"))
        await lifecycle.waitForPersistence()

        expect(repository.records.at(-1)).toMatchObject({
            status: "failed",
            terminalKind: "provider_only",
            executionDurationMs: 2_000,
        })
    })

    it("stops at the durable TURN-END awaiting-user boundary and ignores later user wait", async () => {
        const repository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const onChanged = vi.fn()
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
            onChanged,
        })
        const roundHandle = handle()
        lifecycle.begin(roundHandle)
        wall = 3_000
        monotonic = 2_100
        lifecycle.providerTerminal(roundHandle, providerTerminal(roundHandle))
        wall = 6_000
        monotonic = 5_100
        lifecycle.completeTurnEndAwaitingUser(roundHandle, {
            toolCount: 1,
            completedToolCount: 1,
            failedToolCount: 0,
            cancelledToolCount: 0,
        })
        wall = 66_000
        monotonic = 65_100
        lifecycle.completeTurnEndAwaitingUser(roundHandle, TOOLS_COMPLETED)
        await lifecycle.waitForPersistence()

        expect(repository.records).toHaveLength(1)
        expect(repository.records[0]).toMatchObject({
            terminalKind: "turn_end_awaiting_user",
            executionDurationMs: 5_000,
        })
        expect(onChanged).toHaveBeenCalledTimes(1)
    })

    it("aborts open executions without closing the repository", async () => {
        const repository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const first = handle()
        lifecycle.begin(first)
        wall = 3_000
        monotonic = 2_100
        lifecycle.providerTerminal(first, providerTerminal(first))
        wall = 6_000
        monotonic = 5_100

        await lifecycle.abortOpenExecutions()

        expect(repository.records.at(-1)).toMatchObject({
            status: "aborted",
            executionDurationMs: 5_000,
        })
        expect(repository.closed).toBe(false)

        const second = handle("task-a:request-b:provider:0")
        lifecycle.begin(second)
        wall = 8_000
        monotonic = 7_100
        lifecycle.providerTerminal(second, providerTerminal(second))
        lifecycle.completeProviderOnly(second)
        await lifecycle.waitForPersistence()

        expect(repository.records).toHaveLength(2)
        expect(repository.closed).toBe(false)
    })

    it("aborts and flushes open executions before closing", async () => {
        const repository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const roundHandle = handle()
        lifecycle.begin(roundHandle)
        wall = 4_000
        monotonic = 3_100

        await lifecycle.close()

        expect(repository.records.at(-1)).toMatchObject({
            status: "aborted",
            terminalKind: "provider_only",
            providerDurationMs: 3_000,
            executionDurationMs: 3_000,
        })
        expect(repository.closed).toBe(true)
    })

    it("recovers the latest 60 canonical executions into the Header snapshot", async () => {
        const recovered = Array.from({ length: 61 }, (_, index) => executionRecord(`execution-${index}`, index + 1, 1_000))
        const repository = new MemoryExecutionRepository(recovered)
        const lifecycle = new ApiResponseExecutionLifecycle({ taskId: "task-a", repository })

        await lifecycle.initialize()

        expect(lifecycle.getSnapshot()).toEqual({
            requestsPerMinute: 60,
            rpmBasis: "execution_duration",
            executionCount: 60,
            executionDurationMs: 60_000,
            degraded: false,
        })
    })

    it("continues the write queue after one append failure while keeping RPM unavailable", async () => {
        const repository = new MemoryExecutionRepository()
        repository.failNextAppend = true
        let wall = 1_000
        let monotonic = 100
        const lifecycle = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })

        const first = handle()
        lifecycle.begin(first)
        wall = 3_000
        monotonic = 2_100
        lifecycle.providerTerminal(first, providerTerminal(first))
        lifecycle.completeProviderOnly(first)
        await lifecycle.waitForPersistence()

        const second = handle("task-a:request-b:provider:1")
        lifecycle.begin(second)
        wall = 5_000
        monotonic = 4_100
        lifecycle.providerTerminal(second, providerTerminal(second))
        lifecycle.completeProviderOnly(second)
        await lifecycle.waitForPersistence()

        expect(repository.appendAttempts).toHaveLength(2)
        expect(repository.records).toHaveLength(1)
        expect(repository.records[0]?.executionId).toBe(second.roundId)
        expect(lifecycle.getSnapshot()).toEqual({
            rpmBasis: "unavailable",
            executionCount: 1,
            executionDurationMs: 2_000,
            degraded: true,
        })
    })
})
