import { bindProviderAttemptScope, observeProviderStream, type ProviderAttemptIdentity } from "@shared/provider-attempt-observer"
import { describe, expect, it } from "vitest"
import {
    discardBootstrapSignals,
    installObservabilityPipeline,
    type SignalSpanStartOptions,
} from "@/services/telemetry/service/pipeline-port"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { type ApiRequestRoundHandle, ApiRequestRoundTracker } from "./api-request-round-tracker"
import type { ApiRequestRoundRecord, ApiRequestRoundRepository } from "./api-request-round-types"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import type { ApiResponseExecutionRecord, ApiResponseExecutionRepository } from "./api-response-execution-types"
import type { ProviderAttemptUsageEvent, ProviderAttemptUsagePort } from "./provider-request-round-port"

function recordingUsage(): { readonly events: ProviderAttemptUsageEvent[]; readonly port: ProviderAttemptUsagePort } {
    const events: ProviderAttemptUsageEvent[] = []
    return { events, port: { recordAttemptEvent: (event) => events.push(event) } }
}

function revisionOf(event: ProviderAttemptUsageEvent): number | undefined {
    return event.kind === "terminal" || event.kind === "tokens" ? event.record.revision : undefined
}

class MemoryExecutionRepository implements ApiResponseExecutionRepository {
    readonly records: ApiResponseExecutionRecord[] = []
    closed = false
    failRecovery = false

    async append(records: readonly ApiResponseExecutionRecord[]): Promise<void> {
        this.records.push(...records)
    }
    async readRecent(): Promise<ApiResponseExecutionRecord[]> {
        if (this.failRecovery) throw new Error("execution recovery failed")
        return []
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

class MemoryRoundRepository implements ApiRequestRoundRepository {
    readonly records: ApiRequestRoundRecord[] = []
    closed = false
    recoveredInputTokens: number | undefined

    async append(records: readonly ApiRequestRoundRecord[]): Promise<void> {
        this.records.push(...records)
    }
    async readRecent(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRange(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRangeSnapshot(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRecentHistory(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRangeHistorySnapshot(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readCumulativeUsage() {
        return {
            degraded: false,
            ...(this.recoveredInputTokens === undefined ? {} : { inputTokens: this.recoveredInputTokens }),
            cacheNumerator: 0,
            cacheDenominator: 0,
        }
    }
    isDegraded(): boolean {
        return false
    }
    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {
        this.closed = true
    }
}

describe("ApiRequestRoundLifecycle", () => {
    it("forwards terminal, each exact-usage revision and the explicit final in order, without waiting for settlement", async () => {
        const repository = new MemoryRoundRepository()
        const usage = recordingUsage()
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository }),
            undefined,
            usage.port,
        )
        const identity: ProviderAttemptIdentity = {
            provider: "anthropic",
            modelId: "catalog:claude-opus-4-1",
            thinking: "level:high",
        }
        const observer = lifecycle.createObserver({
            logicalRequestId: "review-request",
            apiIndex: 4,
            taskAttempt: 2,
            role: "reviewer",
            policyGeneration: 12,
        })
        const handle = await observer.beginAttempt(identity)
        await observer.finishAttempt(handle, "completed")
        // The Provider fact is already out before any usage or logical settlement exists.
        expect(usage.events.map((event) => event.kind)).toEqual(["terminal"])

        lifecycle.attachExactUsage(handle, {
            inputTokens: 1200,
            outputTokens: 300,
            thoughtsTokens: 40,
            cacheReadTokens: 54_000,
            cacheWriteTokens: 2_100,
            cacheUsageReported: true,
        })
        lifecycle.finalizeTokens(handle)
        // Without an execution owner there is no logical execution to publish.
        lifecycle.completeProviderOnly("review-request")
        await lifecycle.close()

        expect(handle).toMatchObject({ role: "reviewer", policyGeneration: 12, ...identity })
        expect(repository.records.at(-1)).toMatchObject({ revision: 1, inputTokens: 1200, outputTokens: 300 })
        expect(usage.events.map((event) => [event.kind, revisionOf(event)])).toEqual([
            ["terminal", 0],
            ["tokens", 1],
            ["tokens_final", undefined],
        ])
        expect(usage.events[2]).toEqual({ kind: "tokens_final", roundId: handle.roundId })
    })

    it("keeps a failing usage consumer from breaking round persistence", async () => {
        const repository = new MemoryRoundRepository()
        const lifecycle = new ApiRequestRoundLifecycle(new ApiRequestRoundTracker({ taskId: "task-a", repository }), undefined, {
            recordAttemptEvent: () => {
                throw new Error("consumer failed")
            },
        })
        const observer = lifecycle.createObserver({ logicalRequestId: "request", apiIndex: 1, taskAttempt: 0 })
        const handle = await observer.beginAttempt()

        await observer.finishAttempt(handle, "completed")
        lifecycle.attachExactUsage(handle, { inputTokens: 5, outputTokens: 1, cacheUsageReported: false })
        await lifecycle.close()

        expect(repository.records.map(({ revision, status }) => ({ revision, status }))).toEqual([
            { revision: 0, status: "completed" },
            { revision: 1, status: "completed" },
        ])
    })

    it("names every Provider send with its own gen_ai.client.operation span, ended with the send's outcome", async () => {
        const spans: { name: string; attributes: Record<string, unknown>; outcome?: string }[] = []
        // Sends of earlier tests ran without a destination and wait in the bootstrap buffer.
        discardBootstrapSignals()
        const previous = installObservabilityPipeline({
            recordHistogram: () => undefined,
            recordGauge: () => undefined,
            startSpan: (options: SignalSpanStartOptions) => {
                const span: (typeof spans)[number] = { name: options.name, attributes: { ...options.attributes } }
                spans.push(span)
                return {
                    active: true,
                    setAttribute: (key, value) => {
                        span.attributes[key] = value
                    },
                    recordException: () => undefined,
                    end: (outcome) => {
                        span.outcome = outcome
                    },
                }
            },
        })
        try {
            const lifecycle = new ApiRequestRoundLifecycle(
                new ApiRequestRoundTracker({ taskId: "task-a", repository: new MemoryRoundRepository() }),
            )
            const observer = lifecycle.createObserver({
                logicalRequestId: "task:01J0",
                apiIndex: 1,
                taskAttempt: 0,
                role: "task",
            })
            const identity = { provider: "anthropic", modelId: "catalog:claude-sonnet-4-5", thinking: "level:high" }
            const refused = await observer.beginAttempt(identity)
            await observer.finishAttempt(refused, "failed", { status: 429 })
            const stopped = await observer.beginAttempt(identity)
            await observer.finishAttempt(stopped, "cancelled")
            await lifecycle.close()
        } finally {
            installObservabilityPipeline(previous)
        }

        const send = (attempt: number) => ({
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "catalog:claude-sonnet-4-5",
            "dline.role": "task",
            "retry.attempt": attempt,
            "dline.attempt_observation_id": `task-a:task:01J0:provider:${attempt}`,
            "dline.logical_request_id": "task:01J0",
        })
        expect(spans).toEqual([
            {
                name: "gen_ai.client.operation",
                attributes: { ...send(0), "error.type": "rate_limited" },
                outcome: "failure",
            },
            { name: "gen_ai.client.operation", attributes: send(1), outcome: "cancelled" },
        ])
    })

    it("persists transport retries separately and attaches exact usage to the last completed send", async () => {
        const repository = new MemoryRoundRepository()
        let wall = 1_000
        let monotonic = 10
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository, wallClock: () => wall, monotonicClock: () => monotonic }),
        )
        const logicalRequestId = "task-a:api:7"
        const handles: ApiRequestRoundHandle[] = []
        const lifecycleObserver = lifecycle.createObserver({ logicalRequestId, apiIndex: 7, taskAttempt: 2 })
        const observer = {
            beginAttempt: async (identity?: ProviderAttemptIdentity) => {
                const handle = await lifecycleObserver.beginAttempt(identity)
                handles.push(handle)
                return handle
            },
            finishAttempt: (handle: ApiRequestRoundHandle, status: "completed" | "failed" | "cancelled" | "aborted") =>
                lifecycleObserver.finishAttempt(handle, status),
        }
        const source = (async function* () {
            await expect(
                observeProviderStream(async () => {
                    monotonic = 20
                    throw new Error("retryable")
                }),
            ).rejects.toThrow("retryable")
            const stream = await observeProviderStream(async function* () {
                monotonic = 30
                yield "done"
                wall = 3_000
                monotonic = 2_030
            })
            for await (const value of stream) yield value
        })()
        for await (const _value of bindProviderAttemptScope(source, observer)) {
            // Drain the scoped Provider request.
        }
        const finalHandle = handles.at(-1)
        if (!finalHandle) throw new Error("Expected final Provider attempt handle")
        lifecycle.attachExactUsage(finalHandle, {
            inputTokens: 100,
            outputTokens: 20,
            cacheWriteTokens: 10,
            cacheReadTokens: 30,
            cacheUsageReported: true,
            totalCost: 0.01,
            currency: "USD",
        })
        lifecycle.completeProviderOnly(logicalRequestId)
        await lifecycle.close()

        expect(repository.records).toHaveLength(3)
        expect(
            repository.records.map(({ providerAttempt, revision, status }) => ({ providerAttempt, revision, status })),
        ).toEqual([
            { providerAttempt: 0, revision: 0, status: "failed" },
            { providerAttempt: 1, revision: 0, status: "completed" },
            { providerAttempt: 1, revision: 1, status: "completed" },
        ])
        expect(repository.records.at(-1)).toMatchObject({ taskAttempt: 2, currency: "USD", cacheReadTokens: 30 })
        expect(repository.closed).toBe(true)
    })

    it("keeps retry backoff out of execution duration and exposes the final completed send to Task coordination", async () => {
        const roundRepository = new MemoryRoundRepository()
        const executionRepository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const executions = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository: executionRepository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const usage = recordingUsage()
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({
                taskId: "task-a",
                repository: roundRepository,
                wallClock: () => wall,
                monotonicClock: () => monotonic,
            }),
            executions,
            usage.port,
        )
        const logicalRequestId = "task-a:api:9"
        const observer = lifecycle.createObserver({ logicalRequestId, apiIndex: 9, taskAttempt: 0 })

        const first = await observer.beginAttempt()
        wall = 3_000
        monotonic = 2_100
        await observer.finishAttempt(first, "completed")

        wall = 13_000
        monotonic = 12_100
        const second = await observer.beginAttempt()
        wall = 15_000
        monotonic = 14_100
        await observer.finishAttempt(second, "completed")
        wall = 23_000
        monotonic = 22_100
        lifecycle.completeTools(
            logicalRequestId,
            {
                toolCount: 1,
                completedToolCount: 1,
                failedToolCount: 0,
                cancelledToolCount: 0,
            },
            [{ outcome: "completed", toolName: "read_file" }],
        )
        await lifecycle.close()

        expect(executionRepository.records).toEqual([
            expect.objectContaining({
                executionId: first.roundId,
                terminalKind: "provider_only",
                providerDurationMs: 2_000,
                executionDurationMs: 2_000,
            }),
            expect.objectContaining({
                executionId: second.roundId,
                terminalKind: "tools_settled",
                providerDurationMs: 2_000,
                executionDurationMs: 10_000,
            }),
        ])
        // The superseded early send never publishes a logical execution; only the result-producing one does.
        expect(
            usage.events.map((event) => [event.kind, event.kind === "tokens_final" ? event.roundId : event.handle.roundId]),
        ).toEqual([
            ["terminal", first.roundId],
            ["terminal", second.roundId],
            ["logical_execution", second.roundId],
        ])
        expect(usage.events[2]).toMatchObject({
            kind: "logical_execution",
            handle: second,
            execution: {
                executionId: second.roundId,
                terminalKind: "tools_settled",
                toolCount: 1,
                completedToolCount: 1,
            },
            toolCalls: [{ outcome: "completed", toolName: "read_file" }],
        })
        expect(executionRepository.closed).toBe(true)
    })

    it("publishes an open send aborted at close together with its final, since no revision can follow", async () => {
        const repository = new MemoryRoundRepository()
        const usage = recordingUsage()
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository }),
            undefined,
            usage.port,
        )
        const observer = lifecycle.createObserver({ logicalRequestId: "open-request", apiIndex: 5, taskAttempt: 0 })
        const handle = await observer.beginAttempt({
            provider: "openai",
            modelId: "catalog:gpt-5",
            thinking: "level:high",
        })

        await lifecycle.close()

        expect(usage.events).toEqual([
            {
                kind: "terminal",
                handle,
                record: expect.objectContaining({ roundId: handle.roundId, revision: 0, status: "aborted" }),
            },
            { kind: "tokens_final", roundId: handle.roundId },
        ])
    })

    it("recovers round usage independently when execution recovery fails", async () => {
        const roundRepository = new MemoryRoundRepository()
        roundRepository.recoveredInputTokens = 400
        const executionRepository = new MemoryExecutionRepository()
        executionRepository.failRecovery = true
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository: roundRepository }),
            new ApiResponseExecutionLifecycle({ taskId: "task-a", repository: executionRepository }),
        )

        await lifecycle.initializeRounds()
        await expect(lifecycle.initializeExecutions()).rejects.toThrow("execution recovery failed")

        expect(lifecycle.getSnapshot()).toMatchObject({ totalTokensIn: 400 })
        expect(lifecycle.getExecutionSnapshot()).toMatchObject({ rpmBasis: "unavailable", degraded: true })
    })

    it("settles a logical request still unsettled at owner abort as one aborted logical execution", async () => {
        const executionRepository = new MemoryExecutionRepository()
        const usage = recordingUsage()
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository: new MemoryRoundRepository() }),
            new ApiResponseExecutionLifecycle({ taskId: "task-a", repository: executionRepository }),
            usage.port,
        )
        const observer = lifecycle.createObserver({ logicalRequestId: "task-a:api:3", apiIndex: 3, taskAttempt: 0 })
        const handle = await observer.beginAttempt()
        await observer.finishAttempt(handle, "completed")

        await lifecycle.abortOpenExecutions()
        await lifecycle.close()

        const logical = usage.events.filter((event) => event.kind === "logical_execution")
        expect(logical).toEqual([
            expect.objectContaining({
                handle,
                execution: expect.objectContaining({ roundId: handle.roundId, status: "aborted" }),
            }),
        ])
    })

    it("attaches exact usage to the latest terminal send regardless of terminal status", async () => {
        const repository = new MemoryRoundRepository()
        let wall = 1_000
        let monotonic = 10
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository, wallClock: () => wall, monotonicClock: () => monotonic }),
        )
        const logicalRequestId = "task-a:api:8"
        const observer = lifecycle.createObserver({ logicalRequestId, apiIndex: 8, taskAttempt: 0 })

        for (const [index, status] of (["failed", "cancelled", "aborted"] as const).entries()) {
            const handle = await observer.beginAttempt()
            wall += 100
            monotonic += 25
            await observer.finishAttempt(handle, status)
            lifecycle.attachExactUsage(handle, {
                inputTokens: 100 + index,
                outputTokens: 20 + index,
                cacheUsageReported: false,
            })
        }
        await lifecycle.close()

        expect(
            repository.records.map(({ providerAttempt, revision, status }) => ({ providerAttempt, revision, status })),
        ).toEqual([
            { providerAttempt: 0, revision: 0, status: "failed" },
            { providerAttempt: 0, revision: 1, status: "failed" },
            { providerAttempt: 1, revision: 0, status: "cancelled" },
            { providerAttempt: 1, revision: 1, status: "cancelled" },
            { providerAttempt: 2, revision: 0, status: "aborted" },
            { providerAttempt: 2, revision: 1, status: "aborted" },
        ])
    })
})
