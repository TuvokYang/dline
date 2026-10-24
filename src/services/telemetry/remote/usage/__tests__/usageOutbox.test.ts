import { describe, expect, it } from "vitest"
import { USAGE_GRANT_HARD_LIMITS, type UsageGrantContract } from "../../contracts/deviceGrant"
import { DEFAULT_INTERVAL_MS, GATE_MARGIN_MS, INITIAL_PACING } from "../../contracts/pacing"
import {
    estimateUsageWriteRowsV4,
    USAGE_MAX_ACTIVE_SECONDS,
    USAGE_SECOND_MS,
    type UsageAttemptBodyValidation,
    type UsageAttemptBodyWire,
    type UsageBodyWire,
    validateUsageAttemptBody,
    validateUsageBody,
} from "../../contracts/usageBody"
import type { UsageAttemptObservation } from "../attemptProjection"
import {
    alignUsagePolicyEpoch,
    attemptBacklogStorageBytes,
    boundUsageAttemptBacklog,
    dueUsageAttemptReplay,
    dueUsageReplay,
    emptyUsageAttemptOutbox,
    emptyUsageOutbox,
    foldUsageAttemptShards,
    foldUsageShards,
    type PendingUsageObservation,
    settleUsageAttemptInflight,
    settleUsageInflight,
    sha256Hex,
    takeUsageAttemptBatch,
    takeUsageBatch,
    type UsageAttemptOutboxState,
    type UsageOutboxState,
} from "../usageOutbox"
import { projectUsageSettlement, type UsageTally } from "../usageTally"

const CLIENT = { version: "0.12.0" }
const T0 = 1_792_456_800_000
const SECOND = USAGE_SECOND_MS
const SETTLE = 5 * SECOND
const REQUEST_A = "11111111-1111-4111-8111-111111111111"
const REQUEST_B = "22222222-2222-4222-8222-222222222222"
const ATTEMPT_CONTRACT: UsageGrantContract = {
    schemaVersion: 4,
    contractVersion: 4,
    ...USAGE_GRANT_HARD_LIMITS,
    defaultIntervalMs: 600_000,
    newBatchJitterMaxMs: 300_000,
}

function settling(inputTokens: number): UsageTally {
    return projectUsageSettlement({
        observationId: "obs",
        purpose: "task",
        outcome: "completed",
        inputTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 100,
        servedBy: { provider: "anthropic", model: "claude-opus-5-5" },
    })
}

function observation(id: string, receivedAt: number, inputTokens: number, policyEpoch = 1): PendingUsageObservation {
    return { id, receivedAt, policyEpoch, tally: settling(inputTokens) }
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

function fold(state: UsageOutboxState, observations: PendingUsageObservation[], now: number, name = "a.1.sealed.jsonl") {
    return foldUsageShards(state, [{ name, observations }], now)
}

function batch(state: UsageOutboxState, now: number, requestId = REQUEST_A) {
    return takeUsageBatch(state, { now, requestId, client: CLIENT, settleMs: SETTLE })
}

function sentBody(state: UsageOutboxState, now: number, requestId = REQUEST_A): UsageBodyWire {
    const decision = batch(state, now, requestId)
    if (decision.kind !== "batch") throw new Error(`expected a batch, got ${decision.kind}`)
    return decision.body
}

function inputTokensAt(state: UsageOutboxState, startedAt: number): number | undefined {
    return state.seconds.find((second) => second.startedAt === startedAt)?.tally.facts[0]?.tokens.input
}

function sentInputTokens(body: UsageBodyWire): number | undefined {
    return body.facts[0]?.tokens.input
}

// Folding clamps an observation to at most `now`, so a batch is taken one settle
// period after the fold rather than at the same instant.
const foldedAt = T0 + SECOND + SETTLE
const readyAt = foldedAt + SETTLE
const readyState: UsageOutboxState = {
    ...fold(emptyUsageOutbox(1), [observation("1", T0, 1)], foldedAt),
    pacing: { ...INITIAL_PACING, nextEligibleAt: 0 },
}

describe("foldUsageShards", () => {
    it("merges shards per second and does not fold a shard twice after a crash before its removal", () => {
        const shards = [
            { name: "a.jsonl", observations: [observation("1", T0, 10), observation("2", T0 + SECOND, 5)] },
            { name: "b.jsonl", observations: [observation("3", T0, 7)] },
        ]

        const folded = foldUsageShards(emptyUsageOutbox(1), shards, T0 + 2 * SECOND + SETTLE)
        const refolded = foldUsageShards(folded, shards, T0 + 2 * SECOND + SETTLE)
        const afterRemoval = foldUsageShards(refolded, [shards[1] as (typeof shards)[number]], T0 + 2 * SECOND + SETTLE)

        // The same second in two shards is one claimed second carrying both requests.
        expect(inputTokensAt(folded, T0)).toBe(17)
        expect(inputTokensAt(folded, T0 + SECOND)).toBe(5)
        expect(folded.seconds).toHaveLength(2)
        expect(refolded).toEqual(folded)
        // The remaining shard is remembered as folded, so its observations are not counted twice.
        expect(afterRemoval.seconds).toEqual(folded.seconds)
        expect(inputTokensAt(afterRemoval, T0)).toBe(17)
        expect(afterRemoval.foldedShards).toEqual(["b.jsonl"])
    })

    it("drops observations gathered under another policy epoch", () => {
        const folded = fold(emptyUsageOutbox(1), [observation("1", T0, 10, 2)], T0 + SECOND + SETTLE)

        expect(folded.seconds).toEqual([])
    })

    it("never places an observation before a second already sent", () => {
        const state = { ...emptyUsageOutbox(1), sealedThrough: T0 + 10 * SECOND }
        const folded = fold(state, [observation("1", T0, 10)], T0 + 11 * SECOND + SETTLE)

        expect(folded.seconds.map((second) => second.startedAt)).toEqual([T0 + 10 * SECOND])
    })

    it("keeps at most 3600 pending seconds and counts the rest as lost", () => {
        const references = Array.from({ length: 3602 }, (_, index) => observation(`${index}`, T0 + index * SECOND, 1))
        const folded = fold(emptyUsageOutbox(1), references, T0 + 3602 * SECOND + SETTLE)

        expect(folded.seconds).toHaveLength(3600)
        expect(folded.droppedSeconds).toBe(2)
        // The newest seconds survive, so a backlog drains from the far past onwards.
        expect(folded.seconds[0]?.startedAt).toBe(T0 + 2 * SECOND)
    })
})

describe("takeUsageBatch", () => {
    const pending = fold(
        { ...emptyUsageOutbox(1), droppedSeconds: 3 },
        [observation("1", T0, 10), observation("2", T0 + SECOND, 20), observation("3", T0 + 2 * SECOND, 40)],
        T0 + 3 * SECOND + SETTLE,
    )
    /** The newest carried second plus one settle period, with the device gate open. */
    const due = T0 + 3 * SECOND + SETTLE
    const openGate = { ...INITIAL_PACING, nextEligibleAt: 0 }
    const pendingAtDue: UsageOutboxState = { ...pending, pacing: openGate }

    it("waits for the gate, for a running inflight and for an unfinished second", () => {
        const gated = { ...pendingAtDue, pacing: { ...INITIAL_PACING, nextEligibleAt: due + 1 } }
        const busy = batch(pendingAtDue, due)
        if (busy.kind !== "batch") throw new Error("expected a batch")

        expect(batch(gated, due)).toEqual({ kind: "none" })
        expect(takeUsageBatch(busy.state, { now: due, requestId: REQUEST_B, client: CLIENT, settleMs: SETTLE })).toEqual({
            kind: "none",
        })
        // The newest second is not settled yet at this instant, so nothing may be taken.
        expect(
            takeUsageBatch(pending, { now: T0 + 2 * SECOND + 1, requestId: REQUEST_A, client: CLIENT, settleMs: SETTLE }),
        ).toEqual({
            kind: "none",
        })
    })

    it("publishes a body whose active seconds are the seconds it carries", () => {
        const decision = batch(pendingAtDue, due)
        if (decision.kind !== "batch") throw new Error("expected a batch")

        expect(decision.body.window).toEqual({
            started_at: T0,
            ended_at: T0 + 3 * SECOND,
            active_seconds: 3,
            dropped_seconds: 3,
        })
        expect(validateUsageBody(decision.body)).toEqual([])
        expect(sentInputTokens(decision.body)).toBe(70)
        expect(decision.inflight).toMatchObject({
            requestId: REQUEST_A,
            bodySha256: sha256Hex(decision.bytes),
            droppedSeconds: 3,
            attempts: 0,
        })
    })

    it("reports at most 3600 dropped seconds and preserves the remainder", () => {
        const state = { ...pendingAtDue, droppedSeconds: USAGE_MAX_ACTIVE_SECONDS + 1 }
        const decision = batch(state, due)
        if (decision.kind !== "batch") throw new Error("expected a batch")

        expect(decision.body.window.dropped_seconds).toBe(USAGE_MAX_ACTIVE_SECONDS)
        expect(decision.inflight.droppedSeconds).toBe(USAGE_MAX_ACTIVE_SECONDS)
        expect(decision.state.droppedSeconds).toBe(1)
        expect(validateUsageBody(decision.body)).toEqual([])
    })

    it("leaves the seconds it did not take in the queue and clears the reported loss", () => {
        // One millisecond before the last second settles the batch carries the two it
        // can and leaves that one behind.
        const takenAt = due - 1
        const decision = batch(pendingAtDue, takenAt)
        if (decision.kind !== "batch") throw new Error("expected a batch")

        expect(decision.state.seconds.map((second) => second.startedAt)).toEqual([T0 + 2 * SECOND])
        expect(decision.state).toMatchObject({ sealedThrough: T0 + 2 * SECOND, droppedSeconds: 0 })
        expect(decision.state.pacing.nextEligibleAt).toBe(takenAt + DEFAULT_INTERVAL_MS.usage)
    })

    it("takes at most the seconds inside the 60-minute span", () => {
        const hour = 60 * 60 * 1000
        const state = fold(emptyUsageOutbox(1), [observation("1", T0, 1)], T0 + hour + SETTLE)

        expect(sentBody(state, T0 + hour + SETTLE).window).toMatchObject({ started_at: T0, ended_at: T0 + SECOND })
    })

    it("isolates one malformed second instead of dropping the whole selected prefix", () => {
        const unrefusable = {
            ...pendingAtDue,
            seconds: pendingAtDue.seconds.map((second) => ({ ...second, startedAt: T0 + 1 })),
        }
        const decision = batch(unrefusable, due)

        expect(decision.kind).toBe("rejected")
        if (decision.kind !== "rejected") return
        expect(decision.violations).toContain("window")
        expect(decision.state.inflight).toBeUndefined()
        expect(decision.state.droppedSeconds).toBe(4)
        expect(decision.state.seconds).toHaveLength(2)
    })
})

describe("inflight settlement", () => {
    function sending(): { state: UsageOutboxState; requestId: string } {
        const decision = batch(readyState, readyAt)
        if (decision.kind !== "batch") throw new Error("expected a batch")
        return { state: decision.state, requestId: decision.inflight.requestId }
    }

    it("moves the gate to what the service named when the batch is acknowledged", () => {
        const { state, requestId } = sending()
        const settled = settleUsageInflight(
            state,
            requestId,
            { kind: "acknowledged", disposition: "accepted", nextEligibleAt: 0 },
            0,
        )

        expect(settled.inflight).toBeUndefined()
        expect(settled.pacing.nextEligibleAt).toBe(0 + GATE_MARGIN_MS)
    })

    it("ignores a settlement for a request another sender already replaced", () => {
        const { state } = sending()

        expect(settleUsageInflight(state, REQUEST_B, { kind: "discard", code: "x" }, 0)).toEqual(state)
    })

    it("keeps the same batch across a 429 wait so the bytes are replayed first", () => {
        const { state, requestId } = sending()
        const waitedFrom = readyAt + 1_000
        const waiting = settleUsageInflight(
            state,
            requestId,
            { kind: "wait", code: "rate_limited", retryAfterMs: 4_000 },
            waitedFrom,
        )

        expect(waiting.inflight?.seconds).toEqual(state.inflight?.seconds)
        expect(waiting.droppedSeconds).toBe(0)
        expect(dueUsageReplay(waiting, waiting.pacing.waitUntil - 1)).toBeUndefined()
        expect(dueUsageReplay(waiting, waiting.pacing.waitUntil)?.requestId).toBe(requestId)
    })

    it("counts the seconds of an abandoned batch as lost", () => {
        const { state, requestId } = sending()
        const discarded = settleUsageInflight(state, requestId, { kind: "too_large" }, 0)

        expect(discarded.inflight).toBeUndefined()
        expect(discarded.droppedSeconds).toBe(1)
    })

    it("counts both the seconds carried and the loss it reported when a batch is abandoned", () => {
        const pending = fold({ ...emptyUsageOutbox(1), droppedSeconds: 2 }, [observation("1", T0, 1)], foldedAt)
        const decision = batch({ ...pending, pacing: { ...INITIAL_PACING, nextEligibleAt: 0 } }, readyAt)
        if (decision.kind !== "batch") throw new Error("expected a batch")

        const discarded = settleUsageInflight(decision.state, decision.inflight.requestId, { kind: "body_lost" }, 0)

        expect(discarded.droppedSeconds).toBe(1 + 2)
    })
})

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

describe("policy epoch", () => {
    it("establishes the first real epoch without adopting unknown epoch-zero pending work", () => {
        const unknown = { ...readyState, policyEpoch: 0 }

        expect(alignUsagePolicyEpoch(unknown, 2)).toEqual({
            ...emptyUsageOutbox(2),
            pacing: unknown.pacing,
            foldedShards: unknown.foldedShards,
        })
    })

    it("preserves pending and inflight facts across allowed-to-allowed revisions", () => {
        const decision = batch(readyState, readyAt)
        if (decision.kind !== "batch") throw new Error("expected a batch")
        const waiting = settleUsageInflight(
            decision.state,
            decision.inflight.requestId,
            { kind: "wait", code: "rate_limited", retryAfterMs: 4_000 },
            readyAt,
        )

        expect(alignUsagePolicyEpoch(waiting, 2)).toBe(waiting)
        expect(alignUsagePolicyEpoch(waiting, 1)).toBe(waiting)
    })
})
