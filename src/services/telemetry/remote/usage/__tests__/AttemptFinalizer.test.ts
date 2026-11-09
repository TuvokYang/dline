import { describe, expect, it, vi } from "vitest"
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

function harness(
    options: {
        readonly deadlineMs?: number
        readonly persistDelayMs?: number
        readonly appendRetryDelayMs?: number
        readonly appendObservation?: (observation: PendingUsageAttemptObservation) => Promise<void>
    } = {},
) {
    const observations: PendingUsageAttemptObservation[] = []
    const claims: PendingUsageLogicalClaim[] = []
    /** Interleaved sink order, so a dependency between the two append kinds is observable. */
    const order: string[] = []
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
                const append = options.appendObservation
                if (append) return append(observation)
                observations.push(observation)
                order.push(`observation:${observation.id}`)
            },
            appendLogicalClaim: async (claim) => {
                claims.push(claim)
                order.push(`claim:${claim.attemptObservationId}`)
            },
        },
        localSessionId: "finalizer-session",
        now: () => NOW,
        clock,
        log,
        ...(options.deadlineMs === undefined ? {} : { tokenFinalizationDeadlineMs: options.deadlineMs }),
        persistDelayMs: options.persistDelayMs ?? 60_000,
        ...(options.appendRetryDelayMs === undefined ? {} : { appendRetryDelayMs: options.appendRetryDelayMs }),
    })
    const fire = () => {
        for (const { finalize } of [...deadlines.values()]) finalize()
    }
    return { finalizer, observations, claims, order, saves, logs, deadlines, fire }
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
        const { finalizer, observations, deadlines, fire } = harness({ deadlineMs: 2_500 })

        finalizer.record({ kind: "terminal", ...attempt() })
        expect(deadlines.get(ROUND)?.deadline).toBe(NOW + 2_500)
        fire()
        finalizer.record({ kind: "tokens", ...exact(1, 40) })
        finalizer.record({ kind: "tokens_final", roundId: ROUND })

        expect(observations).toHaveLength(1)
        expect(observations[0]).toMatchObject({ revision: 0, observation: { tokenUsageReported: false } })
        expect(deadlines.size).toBe(0)
    })

    it("treats a repeated terminal as idempotent and keeps the first of two conflicting terminals", () => {
        const { finalizer, observations } = harness()

        finalizer.record({ kind: "terminal", ...attempt() })
        finalizer.record({ kind: "terminal", ...attempt() })
        finalizer.record({ kind: "terminal", ...attempt(0, { status: "failed" }) })
        finalizer.record({ kind: "tokens_final", roundId: ROUND })

        expect(observations).toHaveLength(1)
        expect(observations[0]?.observation.outcome).toBe("completed")
    })

    it("lets a logical execution settled inside the window ride on the final, and claims a later one separately", async () => {
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
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(after.observations[0]?.observation.logicalExecution).toBeUndefined()
        expect(after.claims).toEqual([
            {
                logicalRequestId: "request-1",
                attemptObservationId: ROUND,
                receivedAt: NOW,
                execution: expect.objectContaining({ logicalRequests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 } }),
            },
        ])
        // The claim names an attempt checkpoint the fold can only find after that
        // attempt's own observation reached the spool.
        expect(after.order).toEqual([`observation:${ROUND}`, `claim:${ROUND}`])
    })

    it("writes no claim while the observation it names is still unsaved", async () => {
        let release: (() => void) | undefined
        const { finalizer, claims, order } = harness({
            appendObservation: () =>
                new Promise<void>((resolve) => {
                    release = resolve
                }),
        })

        finalizer.record({ kind: "terminal", ...attempt() })
        finalizer.record({ kind: "tokens_final", roundId: ROUND })
        finalizer.record({ kind: "logical_execution", handle: attempt().handle, execution: execution() })
        await Promise.resolve()

        // A fold that read the spool now would see a claim with no attempt checkpoint,
        // skip it, and still discard that shard.
        expect(claims).toEqual([])
        expect(order).toEqual([])

        release?.()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(claims.map((claim) => claim.attemptObservationId)).toEqual([ROUND])
        expect(order).toEqual([`claim:${ROUND}`])
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

    it("keeps the attempt recoverable until the spool append succeeded, so a transient failure loses no token", async () => {
        const stored: PendingUsageAttemptObservation[] = []
        let fail = true
        const { finalizer, saves } = harness({
            appendRetryDelayMs: 5,
            appendObservation: async (observation) => {
                if (fail) {
                    fail = false
                    throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
                }
                stored.push(observation)
            },
        })

        finalizer.record({ kind: "terminal", ...attempt() })
        finalizer.record({ kind: "tokens_final", roundId: ROUND })
        expect(stored).toEqual([])

        // The rejected append reopens the window, so a restart can still finish this attempt.
        await new Promise((resolve) => setTimeout(resolve, 0))
        await finalizer.flush()
        expect(saves.at(-1)?.map((entry) => entry.observationId)).toEqual([ROUND])

        await new Promise((resolve) => setTimeout(resolve, 40))
        expect(stored.map((entry) => entry.id)).toEqual([ROUND])
        expect(stored[0]).toMatchObject({ revision: 0, observation: { outcome: "completed" } })

        // The stored observation is now the only copy: the recovery record is cleared and no
        // second revision of the same attempt is published.
        await finalizer.flush()
        expect(saves.at(-1)).toEqual([])
        expect(stored).toHaveLength(1)
    })

    it.each([
        "resolve",
        "reject",
    ] as const)("fences a pending append and its late claim when purge wins before %s", async (outcome) => {
        vi.useFakeTimers()
        try {
            let resolve!: () => void
            let reject!: (error: Error) => void
            const { finalizer, claims, saves, deadlines } = harness({
                appendObservation: () =>
                    new Promise<void>((done, fail) => {
                        resolve = done
                        reject = fail
                    }),
            })
            finalizer.record({ kind: "terminal", ...attempt() })
            finalizer.record({ kind: "tokens_final", roundId: ROUND })
            finalizer.record({ kind: "logical_execution", handle: attempt().handle, execution: execution() })

            const purging = finalizer.purge()
            if (outcome === "resolve") resolve()
            else reject(new Error("disk full"))
            await purging
            await finalizer.flush()

            expect(claims).toEqual([])
            expect(deadlines.size).toBe(0)
            expect(saves.flat()).toEqual([])
            expect(vi.getTimerCount()).toBe(0)
            // Purge is revocation, not permanent disposal: a new consent epoch may admit again.
            finalizer.record({ kind: "terminal", ...attempt() })
            await finalizer.flush()
            expect(saves.at(-1)?.map((entry) => entry.observationId)).toEqual([ROUND])
            await finalizer.purge()
        } finally {
            vi.useRealTimers()
        }
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
