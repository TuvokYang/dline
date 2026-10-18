import { describe, expect, it } from "vitest"
import { USAGE_WINDOW_MS, type UsageAggregateWire } from "../../contracts/wire"
import {
    alignUsagePolicyEpoch,
    dueUsageReplay,
    emptyUsageOutbox,
    foldUsageShards,
    MAX_USAGE_REPLAY_ATTEMPTS,
    type PendingUsageObservation,
    settleUsageInflight,
    sha256Hex,
    takeUsageBatch,
    USAGE_GATE_MARGIN_MS,
    type UsageOutboxState,
} from "../usageOutbox"

/** A UTC minute boundary. */
const T0 = 1_899_999_960_000
const MINUTE = USAGE_WINDOW_MS
const SETTLE = 15_000
const TOKENS = "dline.usage.tokens.input.task"
const REQUESTS = "dline.usage.requests.task.completed"
const REQUEST_A = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a01"
const REQUEST_B = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a02"

function observation(id: string, receivedAt: number, tokens: number, policyEpoch = 1): PendingUsageObservation {
    return {
        id,
        receivedAt,
        policyEpoch,
        counters: { [REQUESTS]: 1, [TOKENS]: tokens },
        measurements: { "dline.usage.request_duration_ms.task": { count: 1, sum: tokens, min: tokens, max: tokens } },
    }
}

function tokensByMinute(state: UsageOutboxState): Record<number, number> {
    return Object.fromEntries(state.windows.map((window) => [window.startedAt, window.counters[TOKENS]]))
}

function batch(state: UsageOutboxState, now: number, requestId = REQUEST_A) {
    const decision = takeUsageBatch(state, { now, requestId, attributes: { platform: "win32" }, settleMs: SETTLE })
    if (decision.kind !== "batch") throw new Error(`expected a batch, got ${decision.kind}`)
    return { ...decision, sent: JSON.parse(new TextDecoder().decode(decision.body)) as UsageAggregateWire }
}

describe("foldUsageShards", () => {
    it("merges shards per minute and does not fold a shard twice after a crash before its removal", () => {
        const shards = [
            { name: "a.1.sealed.jsonl", observations: [observation("1", T0 + 1_000, 10), observation("2", T0 + MINUTE, 5)] },
            { name: "b.1.sealed.jsonl", observations: [observation("3", T0 + 59_999, 7)] },
        ]

        const folded = foldUsageShards(emptyUsageOutbox(1), shards, T0 + 2 * MINUTE)
        const refolded = foldUsageShards(folded, shards, T0 + 2 * MINUTE)
        const afterRemoval = foldUsageShards(refolded, [shards[1]], T0 + 2 * MINUTE)

        expect(tokensByMinute(folded)).toEqual({ [T0]: 17, [T0 + MINUTE]: 5 })
        expect(folded.windows.find((window) => window.startedAt === T0)?.counters[REQUESTS]).toBe(2)
        expect(refolded).toEqual(folded)
        expect(afterRemoval.foldedShards).toEqual(["b.1.sealed.jsonl"])
        expect(tokensByMinute(afterRemoval)).toEqual(tokensByMinute(folded))
    })

    it("drops another epoch, moves late arrivals past sent minutes and clamps future ones to now", () => {
        const state: UsageOutboxState = { ...emptyUsageOutbox(1), sealedThrough: T0 + 2 * MINUTE }
        const now = T0 + 3 * MINUTE + 1_000

        const folded = foldUsageShards(
            state,
            [
                {
                    name: "a.1.sealed.jsonl",
                    observations: [
                        observation("old-epoch", T0 + 2 * MINUTE + 1, 100, 0),
                        observation("late", T0 + 1_000, 3),
                        observation("future", T0 + 30 * MINUTE, 4),
                    ],
                },
            ],
            now,
        )

        expect(tokensByMinute(folded)).toEqual({ [T0 + 2 * MINUTE]: 3, [T0 + 3 * MINUTE]: 4 })
    })

    it("keeps the newest eleven pending minutes and counts the older ones as dropped", () => {
        const observations = Array.from({ length: 13 }, (_, index) => observation(String(index), T0 + index * MINUTE, index + 1))

        const folded = foldUsageShards(emptyUsageOutbox(1), [{ name: "a.1.sealed.jsonl", observations }], T0 + 13 * MINUTE)

        expect(folded.windows.map((window) => window.startedAt)).toEqual(
            Array.from({ length: 11 }, (_, index) => T0 + (index + 2) * MINUTE),
        )
        expect(folded.droppedWindows).toBe(2)
    })
})

describe("takeUsageBatch", () => {
    const pending = foldUsageShards(
        { ...emptyUsageOutbox(1), droppedWindows: 3 },
        [
            {
                name: "a.1.sealed.jsonl",
                observations: [
                    observation("1", T0 + 1_000, 10),
                    observation("2", T0 + MINUTE + 1, 20),
                    observation("3", T0 + 2 * MINUTE, 40),
                ],
            },
        ],
        T0 + 2 * MINUTE + 1,
    )

    it("sends nothing before the machine gate opens or while a batch is inflight", () => {
        const now = T0 + 2 * MINUTE + SETTLE
        const gated = { ...pending, nextEligibleAt: now + 1 }
        const busy = batch(pending, now).state

        expect(takeUsageBatch(gated, { now, requestId: REQUEST_A, attributes: {}, settleMs: SETTLE })).toEqual({ kind: "none" })
        expect(takeUsageBatch(busy, { now: now + 10 * MINUTE, requestId: REQUEST_B, attributes: {}, settleMs: SETTLE })).toEqual({
            kind: "none",
        })
    })

    it("takes only settled minutes into exact bytes and closes the gate for a full interval", () => {
        const now = T0 + 2 * MINUTE + SETTLE

        const { state, inflight, sent, body } = batch(pending, now)

        expect(sent).toMatchObject({
            window_started_at: T0,
            window_ended_at: T0 + 2 * MINUTE,
            aggregation_count: 2,
            dropped_windows: 3,
            attributes: { platform: "win32" },
        })
        expect(sent.counters[TOKENS]).toBe(30)
        expect(inflight).toMatchObject({ requestId: REQUEST_A, bodySha256: sha256Hex(body), droppedWindows: 3, attempts: 0 })
        expect(tokensByMinute(state)).toEqual({ [T0 + 2 * MINUTE]: 40 })
        expect(state).toMatchObject({
            sealedThrough: T0 + 2 * MINUTE,
            droppedWindows: 0,
            nextEligibleAt: now + MINUTE + USAGE_GATE_MARGIN_MS,
        })
    })

    it("drops and counts a batch the server would refuse instead of sending it", () => {
        const decision = takeUsageBatch(pending, {
            now: T0 + 2 * MINUTE + SETTLE,
            requestId: REQUEST_A,
            attributes: { platform: "not/allowed" },
            settleMs: SETTLE,
        })

        expect(decision.kind).toBe("rejected")
        if (decision.kind !== "rejected") return
        expect(decision.violations).toEqual(["attribute_value"])
        expect(decision.state.inflight).toBeUndefined()
        expect(decision.state.droppedWindows).toBe(3 + 2)
        expect(tokensByMinute(decision.state)).toEqual({ [T0 + 2 * MINUTE]: 40 })
    })
})

describe("settleUsageInflight", () => {
    const sentAt = T0 + 2 * MINUTE + SETTLE
    const sending = batch(
        foldUsageShards(emptyUsageOutbox(1), [{ name: "a", observations: [observation("1", T0 + 1, 10)] }], sentAt),
        sentAt,
    )

    it("clears the inflight on acknowledgement and keeps the next batch a full interval away", () => {
        const ackAt = sentAt + 5_000

        const settled = settleUsageInflight(sending.state, REQUEST_A, { kind: "acknowledged", duplicate: false }, ackAt)

        expect(settled.inflight).toBeUndefined()
        expect(settled.nextEligibleAt).toBe(ackAt + MINUTE + USAGE_GATE_MARGIN_MS)
    })

    it("merges a deferred batch into the next one under a new request ID", () => {
        const withLater = foldUsageShards(
            sending.state,
            [{ name: "b", observations: [observation("2", T0 + 1_500, 5), observation("3", T0 + 3 * MINUTE, 1)] }],
            T0 + 3 * MINUTE,
        )
        const deferredAt = sentAt + 1_000

        const deferred = settleUsageInflight(
            withLater,
            REQUEST_A,
            { kind: "defer", code: "rate_limited", retryAfterMs: 90_000 },
            deferredAt,
        )
        const next = batch(deferred, deferred.nextEligibleAt + 4 * MINUTE, REQUEST_B)

        expect(deferred.inflight).toBeUndefined()
        expect(deferred.nextEligibleAt).toBe(deferredAt + 90_000 + USAGE_GATE_MARGIN_MS)
        expect(next.inflight.requestId).toBe(REQUEST_B)
        expect(next.sent.counters[TOKENS]).toBe(16)
    })

    it("replays the same inflight with backoff and abandons it after the attempt budget", () => {
        let state = sending.state
        let now = sentAt
        for (let attempt = 1; attempt < MAX_USAGE_REPLAY_ATTEMPTS; attempt++) {
            state = settleUsageInflight(state, REQUEST_A, { kind: "replay" }, now)
            expect(state.inflight?.attempts).toBe(attempt)
            expect(dueUsageReplay(state, now)).toBeUndefined()
            now = state.inflight?.notBefore ?? now
            expect(dueUsageReplay(state, now)?.requestId).toBe(REQUEST_A)
        }

        const abandoned = settleUsageInflight(state, REQUEST_A, { kind: "replay" }, now)

        expect(abandoned.inflight).toBeUndefined()
        expect(abandoned.droppedWindows).toBe(1)
    })

    it("honours a server delay longer than its own backoff", () => {
        const replayed = settleUsageInflight(sending.state, REQUEST_A, { kind: "replay", retryAfterMs: 10 * MINUTE }, sentAt)

        expect(replayed.inflight?.notBefore).toBe(sentAt + 10 * MINUTE)
    })

    it("ignores an outcome for a request another sender already settled", () => {
        expect(settleUsageInflight(sending.state, REQUEST_B, { kind: "discard", code: "invalid" }, sentAt)).toBe(sending.state)
    })
})

describe("alignUsagePolicyEpoch", () => {
    it("drops everything gathered under another epoch but keeps the server gate", () => {
        const sentAt = T0 + 2 * MINUTE + SETTLE
        const { state } = batch(
            foldUsageShards(emptyUsageOutbox(1), [{ name: "a", observations: [observation("1", T0, 10)] }], sentAt),
            sentAt,
        )

        const aligned = alignUsagePolicyEpoch(state, 2)

        expect(aligned).toMatchObject({ policyEpoch: 2, windows: [], droppedWindows: 0, nextEligibleAt: state.nextEligibleAt })
        expect(aligned.inflight).toBeUndefined()
        expect(alignUsagePolicyEpoch(aligned, 2)).toBe(aligned)
    })
})
