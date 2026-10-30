import { bindProviderAttemptScope } from "@shared/provider-attempt-observer"
import { describe, expect, it } from "vitest"
import type { ApiProviderStreamChunk } from "@/core/api/transform/stream"
import { ApiRequestRoundLifecycle } from "../api-request-round-lifecycle"
import type { ApiRequestRoundHandle } from "../api-request-round-tracker"
import type { ApiRequestRoundRecord, ApiRequestRoundUsage } from "../api-request-round-types"
import { ApiResponseExecutionLifecycle } from "../api-response-execution-lifecycle"
import type { ApiResponseExecutionRecord, ApiResponseExecutionRepository } from "../api-response-execution-types"
import type { ProviderAttemptUsageEvent } from "../provider-request-round-port"

/**
 * Pins the subagent settlement boundary. A logical request whose Provider stream
 * closed before its tools ran must not be terminalized as "provider only, zero
 * tools", and a retried attempt must not settle its predecessor as a successful
 * zero-tool execution.
 */

class MemoryExecutionRepository implements ApiResponseExecutionRepository {
    readonly records: ApiResponseExecutionRecord[] = []

    async append(records: readonly ApiResponseExecutionRecord[]): Promise<void> {
        this.records.push(...records)
    }
    async readRecent(): Promise<ApiResponseExecutionRecord[]> {
        return []
    }
    async readRange(): Promise<ApiResponseExecutionRecord[]> {
        return []
    }
    async readRangeSnapshot(): Promise<ApiResponseExecutionRecord[]> {
        return []
    }
    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {}
}

const STARTED_AT_MS = 1_000
const COMPLETED_AT_MS = 3_000
const PROVIDER_DURATION_MS = COMPLETED_AT_MS - STARTED_AT_MS

/**
 * Handle allocator for the round tracker. These tests own the Provider terminal
 * themselves, because the settlement boundary is what they prove.
 */
function createRoundTracker() {
    let allocated = 0
    const roundRecord = (handle: ApiRequestRoundHandle, status: ApiRequestRoundRecord["status"]): ApiRequestRoundRecord => ({
        schemaVersion: 1,
        taskId: "task-a",
        roundId: handle.roundId,
        revision: 0,
        logicalRequestId: handle.logicalRequestId,
        apiIndex: handle.apiIndex,
        taskAttempt: handle.taskAttempt,
        providerAttempt: handle.providerAttempt,
        startedAtMs: handle.startedAtMs,
        completedAtMs: COMPLETED_AT_MS,
        providerDurationMs: PROVIDER_DURATION_MS,
        status,
        cacheUsageReported: false,
        usageQuality: "none",
    })
    return {
        beginRound(input: {
            readonly logicalRequestId: string
            readonly apiIndex: number
            readonly taskAttempt: number
        }): ApiRequestRoundHandle {
            const handle: ApiRequestRoundHandle = {
                roundId: `${input.logicalRequestId}:provider:${allocated}`,
                logicalRequestId: input.logicalRequestId,
                apiIndex: input.apiIndex,
                taskAttempt: input.taskAttempt,
                providerAttempt: allocated,
                startedAtMs: STARTED_AT_MS,
                startedMonotonicMs: 100,
            }
            allocated += 1
            return handle
        },
        finishRound: roundRecord,
        attachExactUsage(handle: ApiRequestRoundHandle, usage: ApiRequestRoundUsage): ApiRequestRoundRecord {
            return {
                ...roundRecord(handle, "completed"),
                usageQuality: "exact",
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
            }
        },
        async initialize(): Promise<void> {},
        async waitForPersistence(): Promise<void> {},
        async close(): Promise<void> {},
        abortOpenRounds(): readonly never[] {
            return []
        },
        getSnapshot() {
            return { requestsPerMinute: undefined, rpmBasis: "unavailable" as const, requestCount: 0, degraded: false }
        },
    }
}

interface Harness {
    readonly events: ProviderAttemptUsageEvent[]
    readonly settledExecutions: ApiResponseExecutionRecord[]
    readonly lifecycle: ApiRequestRoundLifecycle
    begin(logicalRequestId: string, taskAttempt?: number): ApiRequestRoundHandle
}

function createHarness(): Harness {
    const events: ProviderAttemptUsageEvent[] = []
    const repository = new MemoryExecutionRepository()
    const executions = new ApiResponseExecutionLifecycle({ taskId: "task-a", repository })
    const lifecycle = new ApiRequestRoundLifecycle(createRoundTracker() as never, executions, {
        recordAttemptEvent: (event) => events.push(event),
    })
    return {
        events,
        settledExecutions: repository.records,
        lifecycle,
        begin(logicalRequestId, taskAttempt = 0) {
            // A subagent admits its request before it sends, the way the Runner's
            // admission declares the tools it will run after the stream ends.
            lifecycle.expectTools(logicalRequestId)
            const observer = lifecycle.createObserver({
                logicalRequestId,
                apiIndex: 0,
                taskAttempt,
                role: "subagent",
            })
            const handle = observer.beginAttempt({
                provider: "openai",
                modelId: "gpt-4o",
                thinking: "state:off",
            }) as ApiRequestRoundHandle
            observer.finishAttempt(handle, "completed")
            return handle
        },
    }
}

describe("subagent logical execution settlement", () => {
    it("keeps a logical request open when its Provider stream closes before its tools run", async () => {
        const { lifecycle, events, settledExecutions, begin } = createHarness()
        const handle = begin("request-a")

        // The Provider stream closed: the Runner's tools have not run yet.
        lifecycle.completeProviderOnly("request-a")
        await lifecycle.waitForPersistence()
        expect(events.filter((event) => event.kind === "logical_execution")).toHaveLength(0)
        expect(settledExecutions).toHaveLength(0)

        // Tools settle afterwards and must reach that same logical execution.
        lifecycle.completeTools(
            "request-a",
            {
                toolCount: 1,
                completedToolCount: 0,
                failedToolCount: 1,
                cancelledToolCount: 0,
            },
            [{ outcome: "failed", toolName: "search_files" }],
        )
        await lifecycle.waitForPersistence()

        const settled = events.filter((event) => event.kind === "logical_execution")
        expect(settled).toHaveLength(1)
        expect(settledExecutions).toEqual([
            expect.objectContaining({
                executionId: handle.roundId,
                terminalKind: "tools_settled",
                toolCount: 1,
                failedToolCount: 1,
            }),
        ])
    })

    it("settles a subagent request that truly ran no tool as tools-settled zero, not provider-only", async () => {
        const { lifecycle, settledExecutions, begin } = createHarness()
        begin("request-b")

        lifecycle.completeTools("request-b", {
            toolCount: 0,
            completedToolCount: 0,
            failedToolCount: 0,
            cancelledToolCount: 0,
        })
        await lifecycle.waitForPersistence()

        expect(settledExecutions).toEqual([
            expect.objectContaining({ terminalKind: "tools_settled", toolCount: 0, status: "completed" }),
        ])
    })

    it("settles a superseded attempt as aborted instead of a successful zero-tool completion", async () => {
        const { lifecycle, events, settledExecutions } = createHarness()
        lifecycle.expectTools("request-c")
        const first = lifecycle.createObserver({
            logicalRequestId: "request-c",
            apiIndex: 0,
            taskAttempt: 0,
            role: "subagent",
        })
        const firstHandle = first.beginAttempt({
            provider: "openai",
            modelId: "gpt-4o",
            thinking: "state:off",
        }) as ApiRequestRoundHandle
        first.finishAttempt(firstHandle, "completed")

        // The initial-stream retry reuses the logical request id, so the retry's
        // first send supersedes the attempt that already reached its terminal.
        const retry = lifecycle.createObserver({
            logicalRequestId: "request-c",
            apiIndex: 0,
            taskAttempt: 1,
            role: "subagent",
        })
        retry.beginAttempt({ provider: "openai", modelId: "gpt-4o", thinking: "state:off" })
        await lifecycle.waitForPersistence()

        const superseded = settledExecutions.find((record) => record.executionId === firstHandle.roundId)
        expect(superseded).toMatchObject({ status: "aborted" })
        expect(events).toContainEqual(
            expect.objectContaining({
                kind: "logical_execution",
                handle: expect.objectContaining({ roundId: firstHandle.roundId }),
            }),
        )
    })
})

describe("subagent stream closure", () => {
    it("closes an inner Provider iterator abandoned after its first chunk", async () => {
        let closed = false
        async function* inner(): AsyncGenerator<ApiProviderStreamChunk> {
            try {
                yield { type: "text", text: "first" }
                yield { type: "text", text: "second" }
            } finally {
                closed = true
            }
        }
        const scoped = bindProviderAttemptScope(inner(), {
            beginAttempt: () => undefined,
            finishAttempt: () => undefined,
        })

        // A consumer that stops after the first chunk, the way the Runner exits
        // when a finish was requested while the stream was still yielding.
        for await (const chunk of scoped) {
            if (chunk.type !== "text") throw new Error(`Expected a text chunk, received ${chunk.type}`)
            expect(chunk.text).toBe("first")
            break
        }

        expect(closed).toBe(true)
    })
})

describe("subagent usage accounting", () => {
    it("records the accumulated usage of a send that produced no tool call", () => {
        const { lifecycle, events } = createHarness()
        const observer = lifecycle.createObserver({
            logicalRequestId: "request-d",
            apiIndex: 0,
            taskAttempt: 0,
            role: "subagent",
        })
        const handle = observer.beginAttempt({
            provider: "openai",
            modelId: "gpt-4o",
            thinking: "state:off",
        }) as ApiRequestRoundHandle

        lifecycle.attachExactUsage(handle, {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cacheUsageReported: true,
        })

        expect(events.filter((event) => event.kind === "tokens")).toEqual([
            expect.objectContaining({
                handle: expect.objectContaining({ roundId: handle.roundId }),
                record: expect.objectContaining({ usageQuality: "exact", inputTokens: 120 }),
            }),
        ])
    })
})
