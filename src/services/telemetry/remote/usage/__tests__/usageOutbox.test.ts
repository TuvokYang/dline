import { describe, expect, it } from "vitest"
import type { PendingUsageLogicalClaim, SettledUsageAttemptShard } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { USAGE_GRANT_HARD_LIMITS, type UsageGrantContract } from "../../contracts/deviceGrant"
import { DEFAULT_REPLAY_BUDGET, usageReplayBudget } from "../../contracts/pacing"
import type { UsageBodyGrant, UsageBodyWire } from "../../contracts/usageBody"
import { estimateUsageWriteRows, validateUsageBodySchema } from "../../contracts/usageBodySchema"
import { sealOpenAttemptBucket } from "../attemptBucket"
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
const REPLAY_BUDGET = usageReplayBudget(USAGE_GRANT_HARD_LIMITS.maxRequestReplayAgeMs)
const T0 = 1_792_456_800_000
const REQUEST_A = "11111111-1111-4111-8111-111111111111"
const REQUEST_B = "22222222-2222-4222-8222-222222222222"
const ATTEMPT_CONTRACT: UsageGrantContract = {
    schemaVersion: 5,
    contractVersion: 1,
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
    localSessionId = "session-default",
) {
    return {
        id,
        revision,
        receivedAt: admittedAt + durationMs,
        localSessionId,
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
            ...(logicalExecution ? { logicalExecution } : {}),
        },
    }
}

const ONE_COMPLETED_EXECUTION: NonNullable<UsageAttemptObservation["logicalExecution"]> = {
    logicalRequests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 },
    turnDurationMs: { count: 1, sum: 5_000, min: 5_000, max: 5_000 },
    taskAttempts: { count: 1, sum: 1, min: 1, max: 1 },
}

function lateClaim(attemptId: string, logicalRequestId = `logical-${attemptId}`): PendingUsageLogicalClaim {
    return { logicalRequestId, attemptObservationId: attemptId, receivedAt: T0 + 50_000, execution: ONE_COMPLETED_EXECUTION }
}

type TestShard = Omit<SettledUsageAttemptShard, "claims"> & { readonly claims?: SettledUsageAttemptShard["claims"] }

function foldAttempts(
    state: UsageAttemptOutboxState,
    shards: readonly TestShard[],
    onRejected?: Parameters<typeof foldUsageAttemptShards>[2]["onRejected"],
    firstBucket = 0,
) {
    let nextBucket = firstBucket
    return foldUsageAttemptShards(
        state,
        shards.map((shard) => ({ claims: [], ...shard })),
        {
            currentPolicyGeneration: 7,
            newBucketId: () => `bucket-${++nextBucket}`,
            sealedAt: T0 + 100_000,
            onRejected,
        },
    )
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

    it("counts each local session once, in the bucket of its first observation, across folds and replays", () => {
        const first = foldAttempts(emptyUsageAttemptOutbox(7), [
            {
                name: "one.attempts.sealed.jsonl",
                observations: [attemptObservation("a", T0, 100, 1, undefined, undefined, "session-one")],
            },
        ])
        const second = foldAttempts(first, [
            {
                name: "two.attempts.sealed.jsonl",
                observations: [
                    attemptObservation("b", T0 + 10, 100, 1, undefined, undefined, "session-one"),
                    attemptObservation("c", T0 + 20, 100, 1, undefined, undefined, "session-two"),
                ],
            },
        ])
        const replayed = foldAttempts(second, [
            {
                name: "two.attempts.sealed.jsonl",
                observations: [attemptObservation("c", T0 + 20, 100, 1, undefined, undefined, "session-two")],
            },
        ])

        expect(second.buckets.open?.sessionsStarted).toBe(2)
        expect(second.sessionClaims).toEqual([
            { sessionId: "session-one", bucketId: "bucket-1" },
            { sessionId: "session-two", bucketId: "bucket-1" },
        ])
        expect(replayed).toEqual(second)
    })

    it("attaches a late logical claim to its open fact exactly once and reports it at seal", () => {
        const open = foldAttempts(emptyUsageAttemptOutbox(7), [
            { name: "attempt.attempts.sealed.jsonl", observations: [attemptObservation("a", T0, 100)] },
        ])
        expect(open.buckets.open?.logicalCandidates).toEqual({ "logical-a": { attemptObservationId: "a", factIndex: 0 } })

        const claimed = foldAttempts(open, [{ name: "claim.attempts.sealed.jsonl", observations: [], claims: [lateClaim("a")] }])
        const duplicate = foldAttempts(claimed, [
            { name: "again.attempts.sealed.jsonl", observations: [], claims: [lateClaim("a")] },
        ])
        const sealed = sealOpenAttemptBucket(duplicate.buckets, T0 + 100_000).sealed[0]

        expect(claimed.logicalClaims).toEqual({ "logical-a": "bucket-1" })
        expect(duplicate.buckets).toEqual(claimed.buckets)
        expect(sealed.facts[0].logicalExecution?.logicalRequests.completed).toBe(1)
        expect(sealed.facts[0].logicalExecutionCoverage).toEqual({ reported: 1, unreported: 0 })
        expect(sealed.logicalCandidates).toBeUndefined()
    })

    it("leaves a request unreported when its bucket sealed before the late claim arrived", () => {
        const open = foldAttempts(emptyUsageAttemptOutbox(7), [
            { name: "attempt.attempts.sealed.jsonl", observations: [attemptObservation("a", T0, 100)] },
        ])
        const sealedFirst = { ...open, buckets: sealOpenAttemptBucket(open.buckets, T0 + 1_000) }

        const late = foldAttempts(sealedFirst, [
            { name: "claim.attempts.sealed.jsonl", observations: [], claims: [lateClaim("a")] },
        ])

        expect(late.buckets.sealed[0].facts[0].logicalExecution).toBeUndefined()
        expect(late.buckets.sealed[0].facts[0].logicalExecutionCoverage).toEqual({ reported: 0, unreported: 1 })
        // Recorded anyway, so the request can never claim coverage twice.
        expect(late.logicalClaims).toEqual({ "logical-a": "bucket-1" })
    })

    it("lets a retry supersede its early attempt in the same bucket, so the early attempt counts in neither coverage", () => {
        const early = attemptObservation("early", T0, 100)
        const retry = attemptObservation("retry", T0 + 10, 100)
        const sameRequest = {
            ...retry,
            observation: { ...retry.observation, logicalRequestId: early.observation.logicalRequestId },
        }

        const folded = foldAttempts(emptyUsageAttemptOutbox(7), [
            { name: "retry.attempts.sealed.jsonl", observations: [early, sameRequest] },
        ])
        const staleClaim = foldAttempts(folded, [
            { name: "stale.attempts.sealed.jsonl", observations: [], claims: [lateClaim("early", "logical-early")] },
        ])
        const sealed = sealOpenAttemptBucket(staleClaim.buckets, T0 + 100_000).sealed[0]

        expect(sealed.facts[0].requests.completed).toBe(2)
        // A claim naming the superseded attempt is not the result-producing identity: it attaches and blocks nothing.
        expect(staleClaim.logicalClaims).toEqual({})
        expect(sealed.facts[0].logicalExecutionCoverage).toEqual({ reported: 0, unreported: 1 })
    })
})

describe("takeUsageAttemptBatch", () => {
    function validation(contract: Partial<UsageGrantContract> = {}): UsageBodyGrant {
        return { contract: { ...ATTEMPT_CONTRACT, ...contract } }
    }

    function schemaViolations(body: UsageBodyWire, contract: Partial<UsageGrantContract> = {}) {
        return validateUsageBodySchema(body, { limits: { ...ATTEMPT_CONTRACT, ...contract }, clientVersion: CLIENT.version })
    }

    function takeAttempts(
        state: UsageAttemptOutboxState,
        grant: UsageBodyGrant = validation(),
        requestId = REQUEST_A,
        random: () => number = () => 0,
    ) {
        return takeUsageAttemptBatch(state, { now: T0 + 200_000, requestId, client: CLIENT, random, ...grant })
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

    it("uses canonical UTF-8 bytes and the shared write-row formula to stop before an illegal second bucket", () => {
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

        // One fact per bucket: 6 + 2 rows fit, 6 + 2 × 2 do not.
        const byRows = takeAttempts(state, validation({ maxWriteRows: 9 }), "33333333-3333-4333-8333-333333333333")
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
                observations: [attemptObservation("final", T0, 60_000, 1, "catalog:claude-opus-4-1", logicalExecution)],
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
        expect(estimateUsageWriteRows(decision.body)).toBe(11)
        expect(schemaViolations(decision.body)).toEqual([])
        expect(schemaViolations(decision.body, { maxToolRows: 1 }).map((violation) => violation.rule)).toContain("capacity")

        const invalid: UsageBodyWire = {
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
        expect(schemaViolations(invalid).map((violation) => violation.rule)).toContain("task_attempts_count")
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
            REPLAY_BUDGET,
            () => 0,
        )
        expect(dueUsageAttemptReplay(waiting, waiting.pacing.waitUntil - 1)).toBeUndefined()
        expect(dueUsageAttemptReplay(waiting, waiting.pacing.waitUntil)).toEqual(waiting.inflight)
        const replaying = settleUsageAttemptInflight(
            waiting,
            decision.inflight.requestId,
            { kind: "replay" },
            waiting.pacing.waitUntil,
            REPLAY_BUDGET,
        )
        expect(replaying.inflight).toMatchObject({ requestId: decision.inflight.requestId, attempts: 1 })
        expect(replaying.buckets.sealed).toHaveLength(1)
        const acknowledged = settleUsageAttemptInflight(
            replaying,
            decision.inflight.requestId,
            { kind: "acknowledged", disposition: "duplicate", nextEligibleAt: 0 },
            replaying.inflight?.notBefore ?? 0,
            REPLAY_BUDGET,
        )
        expect(acknowledged.inflight).toBeUndefined()
        expect(acknowledged.buckets.sealed).toEqual([])
        expect(acknowledged.observationRevisions).toEqual({})
    })

    it("replays an unknown outcome past a day and past twelve attempts until the grant's replay age ends", () => {
        const DAY_MS = 24 * 60 * 60_000
        const state = foldAttempts(emptyUsageAttemptOutbox(7), [
            { name: "horizon.attempts.sealed.jsonl", observations: [attemptObservation("a", T0, 60_000)] },
        ])
        const decision = takeAttempts(state)
        if (decision.kind !== "batch") throw new Error(`expected batch, got ${decision.kind}`)
        const { requestId, createdAt } = decision.inflight
        const grantBudget = usageReplayBudget(3 * DAY_MS)

        // The logs budget would already have dropped it: a day has passed.
        const underLogsBudget = settleUsageAttemptInflight(
            decision.state,
            requestId,
            { kind: "replay" },
            createdAt + DAY_MS,
            DEFAULT_REPLAY_BUDGET,
        )
        let replaying = decision.state
        for (let replay = 1; replay <= 13; replay++) {
            replaying = settleUsageAttemptInflight(
                replaying,
                requestId,
                { kind: "replay" },
                createdAt + DAY_MS + replay,
                grantBudget,
            )
        }
        const atHorizon = settleUsageAttemptInflight(
            replaying,
            requestId,
            { kind: "replay" },
            createdAt + 3 * DAY_MS,
            grantBudget,
        )

        expect(underLogsBudget.inflight).toBeUndefined()
        expect(replaying.inflight).toMatchObject({ requestId, attempts: 13 })
        expect(replaying.buckets.sealed).toHaveLength(1)
        expect(atHorizon.inflight).toBeUndefined()
        expect(atHorizon.buckets.sealed).toEqual([])
    })
})
