import { describe, expect, it } from "vitest"
import type { PendingAttemptFinalization } from "@/core/storage/telemetry-remote/UsageAttemptFinalizationStore"
import type {
    PendingUsageAttemptObservation,
    PendingUsageLogicalClaim,
} from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { API_REQUEST_ROUND_SCHEMA_VERSION } from "@/core/task/performance/api-request-round-types"
import type { ApiResponseExecutionRecord } from "@/core/task/performance/api-response-execution-types"
import type { ProviderAttemptRevision } from "@/core/task/performance/provider-request-round-port"
import { AttemptFinalizer, type AttemptFinalizerLog, type UsageAttemptFinalizationClock } from "../AttemptFinalizer"

const NOW = 1_900_000_000_000
const ROUND = "task-1:request-1:provider:0"

function attempt(revision = 0, overrides: Partial<ProviderAttemptRevision["record"]> = {}): ProviderAttemptRevision {
    return {
        handle: {
            roundId: ROUND,
            logicalRequestId: "request-1",
            apiIndex: 0,
            taskAttempt: 1,
            providerAttempt: 0,
            role: "task",
            provider: "openai",
            modelId: "catalog:gpt-5",
            thinking: "level:high",
            policyGeneration: 7,
            startedAtMs: NOW - 1_000,
            startedMonotonicMs: 10,
        },
        record: {
            schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
            taskId: "task-1",
            roundId: ROUND,
            revision,
            logicalRequestId: "request-1",
            apiIndex: 0,
            taskAttempt: 1,
            providerAttempt: 0,
            startedAtMs: NOW - 1_000,
            completedAtMs: NOW - 500,
            providerDurationMs: 500,
            status: "completed",
            cacheUsageReported: false,
            usageQuality: "none",
            ...overrides,
        },
    }
}

function exact(revision: number, inputTokens: number): ProviderAttemptRevision {
    return attempt(revision, { inputTokens, outputTokens: 4, usageQuality: "exact" })
}

function execution(): ApiResponseExecutionRecord {
    return {
        schemaVersion: 1,
        taskId: "task-1",
        executionId: ROUND,
        revision: 0,
        roundId: ROUND,
        logicalRequestId: "request-1",
        apiIndex: 0,
        taskAttempt: 1,
        providerAttempt: 0,
        startedAtMs: NOW - 1_000,
        providerCompletedAtMs: NOW - 500,
        completedAtMs: NOW,
        providerDurationMs: 500,
        executionDurationMs: 1_000,
        status: "completed",
        terminalKind: "provider_only",
        toolCount: 0,
        completedToolCount: 0,
        failedToolCount: 0,
        cancelledToolCount: 0,
    }
}

function harness(options: { readonly deadlineMs?: number; readonly persistDelayMs?: number } = {}) {
    const observations: PendingUsageAttemptObservation[] = []
    const claims: PendingUsageLogicalClaim[] = []
    const saves: PendingAttemptFinalization[][] = []
    const logs: { level: string; message: string }[] = []
    const deadlines = new Map<string, { deadline: number; finalize: () => void }>()
    const clock: UsageAttemptFinalizationClock = {
        schedule: (observationId, deadline, finalize) => deadlines.set(observationId, { deadline, finalize }),
        cancel: (observationId) => deadlines.delete(observationId),
    }
    const log: AttemptFinalizerLog = (level, message) => logs.push({ level, message })
    const finalizer = new AttemptFinalizer({
        store: {
            save: async (entries) => {
                saves.push([...entries])
            },
            readOverdue: async () => [],
            removeRecovered: async () => undefined,
            purge: async () => undefined,
        },
        sink: {
            appendObservation: async (observation) => {
                observations.push(observation)
            },
            appendLogicalClaim: async (claim) => {
                claims.push(claim)
            },
        },
        localSessionId: "finalizer-session",
        now: () => NOW,
        clock,
        log,
        ...(options.deadlineMs === undefined ? {} : { tokenFinalizationDeadlineMs: options.deadlineMs }),
        persistDelayMs: options.persistDelayMs ?? 60_000,
    })
    const fire = () => {
        for (const { finalize } of [...deadlines.values()]) finalize()
    }
    return { finalizer, observations, claims, saves, logs, deadlines, fire }
}

describe("AttemptFinalizer", () => {
    it("rejects a deadline that is not finite and positive", () => {
        for (const deadlineMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
            expect(() => harness({ deadlineMs })).toThrow(/finite and positive/i)
        }
    })

    it("emits exactly one observation with the highest strictly increasing revision at the explicit final", () => {
        const { finalizer, observations } = harness()

        finalizer.record({ kind: "terminal", ...attempt() })
        finalizer.record({ kind: "tokens", ...exact(2, 30) })
        finalizer.record({ kind: "tokens", ...exact(1, 99) })
        finalizer.record({ kind: "tokens", ...exact(2, 77) })
        expect(observations).toEqual([])
        finalizer.record({ kind: "tokens_final", roundId: ROUND })
        finalizer.record({ kind: "tokens_final", roundId: ROUND })

        expect(observations).toHaveLength(1)
        expect(observations[0]).toMatchObject({
            id: ROUND,
            revision: 2,
            localSessionId: "finalizer-session",
            observation: { tokens: { input: 30, output: 4 }, tokenUsageReported: true },
        })
    })

    it("finalizes at the bounded deadline with tokens unreported and keeps a later revision as loss evidence only", () => {
        const { finalizer, observations, deadlines, fire, logs } = harness({ deadlineMs: 2_500 })

        finalizer.record({ kind: "terminal", ...attempt() })
        expect(deadlines.get(ROUND)?.deadline).toBe(NOW + 2_500)
        fire()
        finalizer.record({ kind: "tokens", ...exact(1, 40) })
        finalizer.record({ kind: "tokens_final", roundId: ROUND })

        expect(observations).toHaveLength(1)
        expect(observations[0]).toMatchObject({ revision: 0, observation: { tokenUsageReported: false } })
        expect(deadlines.size).toBe(0)
        expect(logs).toContainEqual({ level: "debug", message: expect.stringContaining("loss evidence") })
    })

    it("treats a repeated terminal as idempotent and keeps the first of two conflicting terminals", () => {
        const { finalizer, observations, logs } = harness()

        finalizer.record({ kind: "terminal", ...attempt() })
        finalizer.record({ kind: "terminal", ...attempt() })
        finalizer.record({ kind: "terminal", ...attempt(0, { status: "failed" }) })
        finalizer.record({ kind: "tokens_final", roundId: ROUND })

        expect(observations).toHaveLength(1)
        expect(observations[0]?.observation.outcome).toBe("completed")
        expect(logs.filter((entry) => entry.level === "warn")).toEqual([
            { level: "warn", message: expect.stringContaining("terminal conflict (completed then failed)") },
        ])
    })

    it("lets a logical execution settled inside the window ride on the final, and claims a later one separately", () => {
        const inside = harness()
        inside.finalizer.record({ kind: "terminal", ...attempt() })
        inside.finalizer.record({ kind: "logical_execution", handle: attempt().handle, execution: execution() })
        inside.finalizer.record({ kind: "tokens_final", roundId: ROUND })

        expect(inside.observations[0]?.observation.logicalExecution?.taskAttempts).toEqual({ count: 1, sum: 2, min: 2, max: 2 })
        expect(inside.claims).toEqual([])

        const after = harness()
        after.finalizer.record({ kind: "terminal", ...attempt() })
        after.finalizer.record({ kind: "tokens_final", roundId: ROUND })
        after.finalizer.record({ kind: "logical_execution", handle: attempt().handle, execution: execution() })

        expect(after.observations[0]?.observation.logicalExecution).toBeUndefined()
        expect(after.claims).toEqual([
            {
                logicalRequestId: "request-1",
                attemptObservationId: ROUND,
                receivedAt: NOW,
                execution: expect.objectContaining({ logicalRequests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 } }),
            },
        ])
    })

    it("never claims for an attempt it did not admit", () => {
        const { finalizer, claims } = harness()

        finalizer.record({ kind: "logical_execution", handle: attempt().handle, execution: execution() })

        expect(claims).toEqual([])
    })

    it("persists an open window after the coalescing delay and writes nothing when it closed first", async () => {
        const quick = harness({ persistDelayMs: 5 })
        quick.finalizer.record({ kind: "terminal", ...attempt() })
        quick.finalizer.record({ kind: "tokens_final", roundId: ROUND })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(quick.saves).toEqual([])

        const slow = harness({ persistDelayMs: 5 })
        slow.finalizer.record({ kind: "terminal", ...attempt() })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(slow.saves).toEqual([
            [
                expect.objectContaining({
                    observationId: ROUND,
                    deadline: NOW + 10_000,
                    revision: 0,
                    localSessionId: "finalizer-session",
                }),
            ],
        ])

        // Closing the window clears the persisted deadline.
        await slow.finalizer.dispose()
        expect(slow.saves.at(-1)).toEqual([])
        expect(slow.observations).toHaveLength(1)
    })

    it("drops open windows without emitting on purge", async () => {
        const { finalizer, observations, deadlines } = harness()
        finalizer.record({ kind: "terminal", ...attempt() })

        await finalizer.purge()
        finalizer.record({ kind: "tokens_final", roundId: ROUND })

        expect(observations).toEqual([])
        expect(deadlines.size).toBe(0)
    })
})
