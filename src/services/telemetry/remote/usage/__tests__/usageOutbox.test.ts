import { describe, expect, it } from "vitest"
import { DEFAULT_INTERVAL_MS, GATE_MARGIN_MS, INITIAL_PACING } from "../../contracts/pacing"
import { USAGE_SECOND_MS, type UsageBodyWire, validateUsageBody } from "../../contracts/usageBody"
import {
    alignUsagePolicyEpoch,
    dueUsageReplay,
    emptyUsageOutbox,
    foldUsageShards,
    type PendingUsageObservation,
    settleUsageInflight,
    sha256Hex,
    takeUsageBatch,
    type UsageOutboxState,
} from "../usageOutbox"
import { projectUsageSettlement, type UsageTally } from "../usageTally"

const CLIENT = { version: "0.12.0" }
const T0 = 1_792_456_800_000
const SECOND = USAGE_SECOND_MS
const SETTLE = 5 * SECOND
const REQUEST_A = "11111111-1111-4111-8111-111111111111"
const REQUEST_B = "22222222-2222-4222-8222-222222222222"

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

    it("drops and counts a batch the service would refuse instead of sending it", () => {
        // A first second that is not second-aligned is the one thing the client can
        // still get wrong here, so the body must be refused rather than sent.
        const unrefusable = {
            ...pendingAtDue,
            seconds: pendingAtDue.seconds.map((second) => ({ ...second, startedAt: T0 + 1 })),
        }
        const decision = batch(unrefusable, due)

        expect(decision.kind).toBe("rejected")
        if (decision.kind !== "rejected") return
        expect(decision.violations).toContain("window")
        expect(decision.state.inflight).toBeUndefined()
        expect(decision.state.droppedSeconds).toBe(3 + 3)
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

describe("policy epoch", () => {
    it("drops the queue and the inflight but keeps the device gate when consent changes", () => {
        const decision = batch(readyState, readyAt)
        if (decision.kind !== "batch") throw new Error("expected a batch")
        const waiting = settleUsageInflight(
            decision.state,
            decision.inflight.requestId,
            { kind: "wait", code: "rate_limited", retryAfterMs: 4_000 },
            readyAt,
        )

        const aligned = alignUsagePolicyEpoch(waiting, 2)

        expect(aligned).toMatchObject({ policyEpoch: 2, seconds: [], droppedSeconds: 0, pacing: waiting.pacing })
        expect(aligned.inflight).toBeUndefined()
        expect(alignUsagePolicyEpoch(waiting, 1)).toBe(waiting)
    })
})
