import { describe, expect, it } from "vitest"
import { USAGE_GRANT_HARD_LIMITS, type UsageGrantContract } from "../../contracts/deviceGrant"
import {
    estimateUsageWriteRowsV4,
    type UsageAttemptBodyValidation,
    type UsageAttemptBodyWire,
    validateUsageAttemptBody,
} from "../../contracts/usageBody"
import type { UsageAttemptObservation } from "../attemptProjection"
import {
    attemptBacklogStorageBytes,
    boundUsageAttemptBacklog,
    dueUsageAttemptReplay,
    emptyUsageAttemptOutbox,
    foldUsageAttemptShards,
    settleUsageAttemptInflight,
    takeUsageAttemptBatch,
    type UsageAttemptOutboxState,
} from "../usageOutbox"

const CLIENT = { version: "0.12.0" }
const T0 = 1_792_456_800_000
const REQUEST_A = "11111111-1111-4111-8111-111111111111"
const REQUEST_B = "22222222-2222-4222-8222-222222222222"
const ATTEMPT_CONTRACT: UsageGrantContract = {
    schemaVersion: 4,
    contractVersion: 4,
    ...USAGE_GRANT_HARD_LIMITS,
    defaultIntervalMs: 600_000,
    newBatchJitterMaxMs: 300_000,
}

function attemptObservation(
    id: string,
    admittedAt: number,
    durationMs: number,
    revision = 1,
    modelId = "catalog:claude-opus-4-1",
    logicalExecution?: UsageAttemptObservation["logicalExecution"],
    sessionsStarted = 0,
) {
    return {
        id,
        revision,
        receivedAt: admittedAt + durationMs,
        observation: {
            attemptObservationId: id,
            logicalRequestId: `logical-${id}`,
            identity: { role: "task" as const, provider: "anthropic", modelId, thinking: 2048 },
            policyGeneration: 7,
            admittedAt,
            outcome: "completed" as const,
            durationMs,
            tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
            tokenUsageReported: true,
            ...(sessionsStarted > 0 ? { sessionsStarted } : {}),
            ...(logicalExecution ? { logicalExecution } : {}),
        },
    }
}

function foldAttempts(
    state: UsageAttemptOutboxState,
    shards: Parameters<typeof foldUsageAttemptShards>[1],
    onRejected?: Parameters<typeof foldUsageAttemptShards>[2]["onRejected"],
) {
    let nextBucket = 0
    return foldUsageAttemptShards(state, shards, {
        currentPolicyGeneration: 7,
        newBucketId: () => `bucket-${++nextBucket}`,
        sealedAt: T0 + 100_000,
        onRejected,
    })
}

describe("foldUsageAttemptShards", () => {
    it("sorts cross-process observations before reducing and checkpoints the committed revisions", () => {
        const shards = [
            { name: "host-b.attempts.sealed.jsonl", observations: [attemptObservation("b", T0 + 20_000, 40_000)] },
            { name: "host-a.attempts.sealed.jsonl", observations: [attemptObservation("a", T0 + 10_000, 30_000)] },
        ]

        const folded = foldAttempts(emptyUsageAttemptOutbox(7), shards)
        const replayed = foldAttempts(folded, shards)

        expect(folded.buckets.open).toBeUndefined()
        expect(folded.buckets.sealed).toHaveLength(1)
        expect(folded.buckets.sealed[0]).toMatchObject({
            bucketId: "bucket-1",
            firstAttemptAt: T0 + 10_000,
            lastAttemptAt: T0 + 20_000,
            durationMs: 70_000,
            sealedAt: T0 + 100_000,
        })
        expect(folded.buckets.sealed[0].facts[0].requests.completed).toBe(2)
        expect(folded.observationRevisions).toEqual({
            a: { revision: 1, bucketId: "bucket-1" },
            b: { revision: 1, bucketId: "bucket-1" },
        })
        expect(replayed).toEqual(folded)
    })

    it("rejects a higher revision after the observation checkpoint instead of double-counting it", () => {
        const initial = foldAttempts(emptyUsageAttemptOutbox(7), [
            { name: "first.attempts.sealed.jsonl", observations: [attemptObservation("a", T0, 100, 1)] },
        ])
        const rejected: string[][] = []

        const retried = foldAttempts(
            initial,
            [{ name: "late.attempts.sealed.jsonl", observations: [attemptObservation("a", T0, 100, 2)] }],
            (entry) => rejected.push([...entry.violations]),
        )

        expect(retried.buckets).toEqual(initial.buckets)
        expect(retried.observationRevisions).toEqual({ a: { revision: 1, bucketId: "bucket-1" } })
        expect(rejected).toEqual([["revision_after_checkpoint"]])
    })
})

describe("takeUsageAttemptBatch", () => {
    function validation(
        contract: Partial<UsageGrantContract> = {},
        estimateWriteRows: UsageAttemptBodyValidation["estimateWriteRows"] = estimateUsageWriteRowsV4,
    ): UsageAttemptBodyValidation {
        return { contract: { ...ATTEMPT_CONTRACT, ...contract }, estimateWriteRows }
    }

    function takeAttempts(
        state: UsageAttemptOutboxState,
        bodyValidation: UsageAttemptBodyValidation = validation(),
        requestId = REQUEST_A,
        random: () => number = () => 0,
    ) {
        return takeUsageAttemptBatch(state, { now: T0 + 200_000, requestId, client: CLIENT, random, ...bodyValidation })
    }

    it("takes only the first eight complete buckets and persists the grant interval plus jitter", () => {
        const observations = Array.from({ length: 9 }, (_, index) => attemptObservation(`attempt-${index}`, T0 + index, 60_000))
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [{ name: "nine.attempts.sealed.jsonl", observations }])

        const decision = takeAttempts(state, validation(), REQUEST_A, () => 1)
        if (decision.kind !== "batch") throw new Error(`expected batch, got ${decision.kind}`)

        expect(decision.body.buckets).toHaveLength(8)
        expect(decision.inflight.bucketIds).toHaveLength(8)
        expect(decision.state.buckets.sealed).toHaveLength(9)
        expect(decision.state.pacing.nextEligibleAt).toBe(T0 + 200_000 + 600_000 + 300_000)
    })

    it("splits before the thirty-third joint fact without folding identities", () => {
        const observations = Array.from({ length: 33 }, (_, index) =>
            attemptObservation(
                `identity-${index}`,
                T0 + index,
                index === 31 || index === 32 ? 60_000 : 1,
                1,
                `catalog:model-${index}`,
            ),
        )
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [{ name: "facts.attempts.sealed.jsonl", observations }])

        const decision = takeAttempts(state)
        if (decision.kind !== "batch") throw new Error(`expected batch, got ${decision.kind}`)

        expect(decision.body.buckets).toHaveLength(1)
        expect(decision.body.buckets[0].facts).toHaveLength(32)
        expect(new Set(decision.body.buckets[0].facts.map((fact) => fact.model_id)).size).toBe(32)
    })

    it("uses exact UTF-8 bytes and the shared write-row estimator to stop before an illegal second bucket", () => {
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [
            {
                name: "bounds.attempts.sealed.jsonl",
                observations: [attemptObservation("a", T0, 60_000), attemptObservation("b", T0 + 1, 60_000)],
            },
        ])
        const first = takeAttempts(state, validation({ maxBuckets: 1 }))
        if (first.kind !== "batch") throw new Error(`expected batch, got ${first.kind}`)

        const byBytes = takeAttempts(state, validation({ maxBodyBytes: first.bytes.byteLength }), REQUEST_B)
        if (byBytes.kind !== "batch") throw new Error(`expected byte-bounded batch, got ${byBytes.kind}`)
        expect(byBytes.body.buckets).toHaveLength(1)
        expect(byBytes.bytes.byteLength).toBe(first.bytes.byteLength)

        const byRows = takeAttempts(
            state,
            validation({ maxWriteRows: 10 }, (body) => body.buckets.length * 10),
            "33333333-3333-4333-8333-333333333333",
        )
        if (byRows.kind !== "batch") throw new Error(`expected row-bounded batch, got ${byRows.kind}`)
        expect(byRows.body.buckets).toHaveLength(1)
    })

    it("encodes logical execution once and applies the shared execution plus named-tool row formula", () => {
        const logicalExecution: NonNullable<UsageAttemptObservation["logicalExecution"]> = {
            logicalRequests: { completed: 0, failed: 1, cancelled: 0, aborted: 0 },
            turnDurationMs: { count: 1, sum: 82_000, min: 82_000, max: 82_000 },
            tools: {
                completed: 2,
                failed: 1,
                cancelled: 0,
                by_name: {
                    execute_command: { completed: 0, failed: 1, cancelled: 0 },
                    read_file: { completed: 2, failed: 0, cancelled: 0 },
                },
                unlisted: { completed: 0, failed: 0, cancelled: 0 },
            },
            taskAttempts: { count: 1, sum: 2, min: 2, max: 2 },
        }
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [
            {
                name: "logical.attempts.sealed.jsonl",
                observations: [attemptObservation("final", T0, 60_000, 1, "catalog:claude-opus-4-1", logicalExecution, 1)],
            },
        ])
        const decision = takeAttempts(state)
        if (decision.kind !== "batch") throw new Error(`expected batch, got ${decision.kind}`)

        expect(decision.body.buckets[0].sessions_started).toBe(1)
        expect(decision.body.buckets[0].facts[0].logical_execution).toEqual({
            logical_requests: logicalExecution.logicalRequests,
            turn_duration_ms: logicalExecution.turnDurationMs,
            tools: logicalExecution.tools,
            task_attempts: logicalExecution.taskAttempts,
        })
        // Six fixed rows + fact + facet + execution + two named tools.
        expect(estimateUsageWriteRowsV4(decision.body)).toBe(11)
        expect(validateUsageAttemptBody(decision.body, validation())).toEqual([])
        expect(validateUsageAttemptBody(decision.body, validation({ maxToolRows: 1 }))).toContain("tool_rows")

        const invalid: UsageAttemptBodyWire = {
            ...decision.body,
            buckets: decision.body.buckets.map((bucket, bucketIndex) =>
                bucketIndex === 0
                    ? {
                          ...bucket,
                          facts: bucket.facts.map((fact, factIndex) =>
                              factIndex === 0 && fact.logical_execution
                                  ? {
                                        ...fact,
                                        logical_execution: {
                                            ...fact.logical_execution,
                                            task_attempts: { ...fact.logical_execution.task_attempts, count: 2 },
                                        },
                                    }
                                  : fact,
                          ),
                      }
                    : bucket,
            ),
        }
        expect(validateUsageAttemptBody(invalid, validation())).toContain("logical_execution")
    })

    it("bounds the retained FIFO prefix by bucket count and checkpoint bytes with explicit loss", () => {
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [
            {
                name: "backlog.attempts.sealed.jsonl",
                observations: [
                    attemptObservation("a", T0, 60_000),
                    attemptObservation("b", T0 + 1, 60_000),
                    attemptObservation("c", T0 + 2, 60_000),
                ],
            },
        ])
        const oneBucketState = {
            ...state,
            buckets: { sealed: state.buckets.sealed.slice(0, 1) },
            observationRevisions: { a: state.observationRevisions.a },
        }
        const byCount = boundUsageAttemptBacklog(state, T0 + 200_000, {
            maxAgeMs: 1_000_000,
            maxBuckets: 2,
            maxBytes: Number.MAX_SAFE_INTEGER,
        })
        const byBytes = boundUsageAttemptBacklog(state, T0 + 200_000, {
            maxAgeMs: 1_000_000,
            maxBuckets: 3,
            maxBytes: attemptBacklogStorageBytes(oneBucketState),
        })

        expect(byCount.state.buckets.sealed.map((bucket) => bucket.bucketId)).toEqual(["bucket-1", "bucket-2"])
        expect(byCount.state.observationRevisions).toEqual({
            a: { revision: 1, bucketId: "bucket-1" },
            b: { revision: 1, bucketId: "bucket-2" },
        })
        expect(byCount.losses).toEqual([{ bucketIds: ["bucket-3"], violations: ["backlog_capacity"] }])
        expect(byBytes.state.buckets.sealed).toHaveLength(1)
        expect(byBytes.retainedBytes).toBeLessThanOrEqual(attemptBacklogStorageBytes(oneBucketState))
        expect(byBytes.losses).toEqual([{ bucketIds: ["bucket-2", "bucket-3"], violations: ["backlog_capacity"] }])
    })

    it("expires an immutable inflight as one unit and releases its checkpoints with age loss evidence", () => {
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [
            { name: "aged.attempts.sealed.jsonl", observations: [attemptObservation("a", T0, 60_000)] },
        ])
        const decision = takeAttempts(state)
        if (decision.kind !== "batch") throw new Error(`expected batch, got ${decision.kind}`)

        const bounded = boundUsageAttemptBacklog(decision.state, T0 + 101_000, {
            maxAgeMs: 1_000,
            maxBuckets: 8,
            maxBytes: USAGE_GRANT_HARD_LIMITS.maxBodyBytes * 2,
        })

        expect(bounded.state.inflight).toBeUndefined()
        expect(bounded.state.buckets.sealed).toEqual([])
        expect(bounded.state.observationRevisions).toEqual({})
        expect(bounded.losses).toEqual([{ bucketIds: ["bucket-1"], violations: ["backlog_age"] }])
    })

    it("keeps one immutable inflight across wait and replay, then releases buckets only on acknowledgement", () => {
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [
            { name: "replay.attempts.sealed.jsonl", observations: [attemptObservation("a", T0, 60_000)] },
        ])
        const decision = takeAttempts(state)
        if (decision.kind !== "batch") throw new Error(`expected batch, got ${decision.kind}`)
        const waiting = settleUsageAttemptInflight(
            decision.state,
            decision.inflight.requestId,
            { kind: "wait", code: "rate_limited", retryAfterMs: 5_000 },
            T0 + 201_000,
            () => 0,
        )
        expect(dueUsageAttemptReplay(waiting, waiting.pacing.waitUntil - 1)).toBeUndefined()
        expect(dueUsageAttemptReplay(waiting, waiting.pacing.waitUntil)).toEqual(waiting.inflight)
        const replaying = settleUsageAttemptInflight(
            waiting,
            decision.inflight.requestId,
            { kind: "replay" },
            waiting.pacing.waitUntil,
        )
        expect(replaying.inflight).toMatchObject({ requestId: decision.inflight.requestId, attempts: 1 })
        expect(replaying.buckets.sealed).toHaveLength(1)
        const acknowledged = settleUsageAttemptInflight(
            replaying,
            decision.inflight.requestId,
            { kind: "acknowledged", disposition: "duplicate", nextEligibleAt: 0 },
            replaying.inflight?.notBefore ?? 0,
        )
        expect(acknowledged.inflight).toBeUndefined()
        expect(acknowledged.buckets.sealed).toEqual([])
        expect(acknowledged.observationRevisions).toEqual({})
    })
})
