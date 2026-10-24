import { describe, expect, it } from "vitest"
import {
    ATTEMPT_BUCKET_MAX_OPEN_AGE_MS,
    appendAttemptToBuckets,
    emptyAttemptBucketState,
    sealOpenAttemptBucketIfDue,
    validateAttemptBucket,
} from "../attemptBucket"
import type { UsageAttemptObservation } from "../attemptProjection"

function logicalExecution(
    overrides: Partial<NonNullable<UsageAttemptObservation["logicalExecution"]>> = {},
): NonNullable<UsageAttemptObservation["logicalExecution"]> {
    return {
        logicalRequests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 },
        turnDurationMs: { count: 1, sum: 1_500, min: 1_500, max: 1_500 },
        taskAttempts: { count: 1, sum: 1, min: 1, max: 1 },
        ...overrides,
    }
}

function attempt(overrides: Partial<UsageAttemptObservation> = {}): UsageAttemptObservation {
    return {
        attemptObservationId: "attempt-1",
        logicalRequestId: "request-1",
        identity: {
            role: "task",
            provider: "anthropic",
            modelId: "catalog:claude-opus-4-1",
            thinking: "level:high",
        },
        policyGeneration: 12,
        admittedAt: 1_000,
        outcome: "completed",
        durationMs: 1_000,
        tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5 },
        tokenUsageReported: true,
        ...overrides,
    }
}

describe("schema 4 attempt bucket reducer", () => {
    it("seals after full-duration overshoot without clipping the attempt", () => {
        let nextBucket = 0
        const options = { newBucketId: () => `bucket-${++nextBucket}`, sealedAt: () => 99_000 }
        let state = emptyAttemptBucketState()
        state = appendAttemptToBuckets(state, attempt({ attemptObservationId: "a", durationMs: 58_400 }), options)
        state = appendAttemptToBuckets(state, attempt({ attemptObservationId: "b", durationMs: 18_500 }), options)

        expect(state.sealed).toHaveLength(1)
        expect(state.sealed[0].durationMs).toBe(76_900)
        expect(state.sealed[0].facts[0].duration.sum).toBe(76_900)
        expect(state.open).toBeUndefined()

        state = appendAttemptToBuckets(state, attempt({ attemptObservationId: "c", durationMs: 500 }), options)
        expect(state.open?.durationMs).toBe(500)
    })

    it("seals a low-frequency bucket at its bounded open-age boundary without waiting for another attempt", () => {
        const opened = appendAttemptToBuckets(emptyAttemptBucketState(), attempt({ admittedAt: 1_000, durationMs: 500 }), {
            newBucketId: () => "bucket-1",
            sealedAt: () => 2_000,
        })

        expect(sealOpenAttemptBucketIfDue(opened, ATTEMPT_BUCKET_MAX_OPEN_AGE_MS - 1)).toBe(opened)
        const sealed = sealOpenAttemptBucketIfDue(opened, ATTEMPT_BUCKET_MAX_OPEN_AGE_MS)

        expect(sealed.open).toBeUndefined()
        expect(sealed.sealed).toHaveLength(1)
        expect(sealed.sealed[0]).toMatchObject({ bucketId: "bucket-1", durationMs: 500, sealedAt: 600_000 })
    })

    it("keeps numeric budgets and string levels as distinct joint identities", () => {
        let nextBucket = 0
        const options = { newBucketId: () => `bucket-${++nextBucket}`, sealedAt: () => 99_000 }
        let state = emptyAttemptBucketState()
        state = appendAttemptToBuckets(
            state,
            attempt({ attemptObservationId: "number", identity: { ...attempt().identity, thinking: 2048 } }),
            options,
        )
        state = appendAttemptToBuckets(
            state,
            attempt({ attemptObservationId: "string", identity: { ...attempt().identity, thinking: "level:high" } }),
            options,
        )

        expect(state.open?.facts).toHaveLength(2)
        expect(state.open?.facts.map((fact) => fact.identity.thinking)).toEqual([2048, "level:high"])
    })

    it("splits before mutating when a thirty-third legal identity arrives", () => {
        let nextBucket = 0
        const options = { newBucketId: () => `bucket-${++nextBucket}`, sealedAt: () => 99_000 }
        let state = emptyAttemptBucketState()
        for (let index = 0; index < 33; index++) {
            state = appendAttemptToBuckets(
                state,
                attempt({
                    attemptObservationId: `attempt-${index}`,
                    durationMs: 1,
                    identity: { ...attempt().identity, modelId: `catalog:model-${index}` },
                }),
                options,
            )
        }

        expect(state.sealed).toHaveLength(1)
        expect(state.sealed[0].facts).toHaveLength(32)
        expect(state.open?.facts).toHaveLength(1)
        expect(state.open?.facts[0].identity.modelId).toBe("catalog:model-32")
    })

    it("matches an independent reference reduction for requests, tokens, coverage and full duration", () => {
        const observations = [
            attempt({ attemptObservationId: "a", durationMs: 10_000, tokens: { ...attempt().tokens, input: 11 } }),
            attempt({
                attemptObservationId: "b",
                outcome: "failed",
                durationMs: 20_000,
                tokenUsageReported: false,
                tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            }),
            attempt({
                attemptObservationId: "c",
                durationMs: 5_000,
                identity: { ...attempt().identity, role: "reviewer" },
                tokens: { ...attempt().tokens, input: 7 },
            }),
        ]
        let state = emptyAttemptBucketState()
        let nextBucket = 0
        for (const observation of observations) {
            state = appendAttemptToBuckets(state, observation, {
                newBucketId: () => `bucket-${++nextBucket}`,
                sealedAt: () => 99_000,
            })
        }
        const bucket = state.open
        if (!bucket) throw new Error("expected reference bucket")

        const reference = new Map<
            string,
            { requests: number; input: number; reported: number; unreported: number; duration: number }
        >()
        for (const observation of observations) {
            const key = JSON.stringify(observation.identity)
            const current = reference.get(key) ?? { requests: 0, input: 0, reported: 0, unreported: 0, duration: 0 }
            current.requests += 1
            current.duration += observation.durationMs
            current.reported += observation.tokenUsageReported ? 1 : 0
            current.unreported += observation.tokenUsageReported ? 0 : 1
            current.input += observation.tokenUsageReported ? observation.tokens.input : 0
            reference.set(key, current)
        }

        expect(bucket.durationMs).toBe(observations.reduce((sum, observation) => sum + observation.durationMs, 0))
        for (const fact of bucket.facts) {
            const expected = reference.get(JSON.stringify(fact.identity))
            expect(expected).toBeDefined()
            expect(Object.values(fact.requests).reduce((sum, count) => sum + count, 0)).toBe(expected?.requests)
            expect(fact.tokens.input).toBe(expected?.input)
            expect(fact.tokenCoverage).toEqual({ reported: expected?.reported, unreported: expected?.unreported })
            expect(fact.duration.sum).toBe(expected?.duration)
        }
    })

    it("rejects an unsafe attempt without mutating the prior state", () => {
        const state = emptyAttemptBucketState()
        expect(() =>
            appendAttemptToBuckets(state, attempt({ durationMs: Number.MAX_SAFE_INTEGER + 1 }), {
                newBucketId: () => "bucket-1",
                sealedAt: () => 99_000,
            }),
        ).toThrow(/duration/i)
        expect(state).toEqual({ sealed: [] })
    })

    it("merges final-only logical execution independently from Provider attempt totals", () => {
        let nextBucket = 0
        const options = { newBucketId: () => `bucket-${++nextBucket}`, sealedAt: () => 99_000 }
        let state = emptyAttemptBucketState()
        state = appendAttemptToBuckets(
            state,
            attempt({
                attemptObservationId: "final-a",
                logicalExecution: logicalExecution({
                    tools: {
                        completed: 1,
                        failed: 0,
                        cancelled: 0,
                        by_name: { read_file: { completed: 1, failed: 0, cancelled: 0 } },
                    },
                }),
            }),
            options,
        )
        state = appendAttemptToBuckets(
            state,
            attempt({
                attemptObservationId: "retry-before-final-b",
                durationMs: 500,
            }),
            options,
        )
        state = appendAttemptToBuckets(
            state,
            attempt({
                attemptObservationId: "final-b",
                outcome: "failed",
                logicalExecution: logicalExecution({
                    logicalRequests: { completed: 0, failed: 1, cancelled: 0, aborted: 0 },
                    turnDurationMs: { count: 1, sum: 3_000, min: 3_000, max: 3_000 },
                    tools: {
                        completed: 0,
                        failed: 1,
                        cancelled: 0,
                        by_name: { execute_command: { completed: 0, failed: 1, cancelled: 0 } },
                    },
                    taskAttempts: { count: 1, sum: 3, min: 3, max: 3 },
                }),
            }),
            options,
        )

        const bucket = state.open
        if (!bucket) throw new Error("expected open attempt bucket")
        validateAttemptBucket(bucket)
        expect(bucket.facts[0]).toMatchObject({
            requests: { completed: 2, failed: 1, cancelled: 0, aborted: 0 },
            logicalExecution: {
                logicalRequests: { completed: 1, failed: 1, cancelled: 0, aborted: 0 },
                turnDurationMs: { count: 2, sum: 4_500, min: 1_500, max: 3_000 },
                tools: {
                    completed: 1,
                    failed: 1,
                    cancelled: 0,
                    by_name: {
                        execute_command: { completed: 0, failed: 1, cancelled: 0 },
                        read_file: { completed: 1, failed: 0, cancelled: 0 },
                    },
                },
                taskAttempts: { count: 2, sum: 4, min: 1, max: 3 },
            },
        })
    })

    it("rejects a logical observation whose summaries do not conserve one request", () => {
        expect(() =>
            appendAttemptToBuckets(
                emptyAttemptBucketState(),
                attempt({
                    logicalExecution: logicalExecution({
                        turnDurationMs: { count: 2, sum: 3_000, min: 1_500, max: 1_500 },
                    }),
                }),
                { newBucketId: () => "bucket-1", sealedAt: () => 99_000 },
            ),
        ).toThrow(/logical/i)
    })
})
