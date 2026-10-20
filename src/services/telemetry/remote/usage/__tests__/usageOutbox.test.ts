import { describe, expect, it } from "vitest"
import { DEFAULT_INTERVAL_MS, GATE_MARGIN_MS, INITIAL_PACING, MAX_REPLAY_ATTEMPTS } from "../../contracts/pacing"
import { USAGE_MINUTE_MS, type UsageBodyWire, validateUsageBody } from "../../contracts/usageBody"
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
import { projectUsageSettlement } from "../usageTally"

/** A UTC minute boundary. */
const T0 = 1_899_999_960_000
const MINUTE = USAGE_MINUTE_MS
const SETTLE = 15_000
const CLIENT = { version: "0.11.1", platform: "win32" }
const REQUEST_A = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a01"
const REQUEST_B = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a02"
const noJitter = () => 0

function observation(id: string, receivedAt: number, tokens: number, policyEpoch = 1): PendingUsageObservation {
    const tally = projectUsageSettlement({
        observationId: id,
        purpose: "task",
        outcome: "completed",
        inputTokens: tokens,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 100,
        servedBy: { provider: "anthropic", model: "claude-sonnet-4" },
    })
    return { id, receivedAt, policyEpoch, tally }
}

function tokensByMinute(state: UsageOutboxState): Record<number, number | undefined> {
    return Object.fromEntries(state.minutes.map((minute) => [minute.startedAt, minute.tally.purposes.task?.tokens.input]))
}

function fold(state: UsageOutboxState, observations: PendingUsageObservation[], now: number, name = "a.1.sealed.jsonl") {
    return foldUsageShards(state, [{ name, observations }], now)
}

function batch(state: UsageOutboxState, now: number, requestId = REQUEST_A) {
    const decision = takeUsageBatch(state, { now, requestId, client: CLIENT, settleMs: SETTLE })
    if (decision.kind !== "batch") throw new Error(`expected a batch, got ${decision.kind}`)
    return { ...decision, sent: JSON.parse(new TextDecoder().decode(decision.bytes)) as UsageBodyWire }
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
        expect(folded.minutes.find((minute) => minute.startedAt === T0)?.tally.purposes.task?.requests.completed).toBe(2)
        expect(refolded).toEqual(folded)
        expect(afterRemoval.foldedShards).toEqual(["b.1.sealed.jsonl"])
        expect(tokensByMinute(afterRemoval)).toEqual(tokensByMinute(folded))
    })

    it("drops another epoch, moves late arrivals past sent minutes and clamps future ones to now", () => {
        const state: UsageOutboxState = { ...emptyUsageOutbox(1), sealedThrough: T0 + 2 * MINUTE }

        const folded = fold(
            state,
            [
                observation("old-epoch", T0 + 2 * MINUTE + 1, 100, 0),
                observation("late", T0 + 1_000, 3),
                observation("future", T0 + 30 * MINUTE, 4),
            ],
            T0 + 3 * MINUTE + 1_000,
        )

        expect(tokensByMinute(folded)).toEqual({ [T0 + 2 * MINUTE]: 3, [T0 + 3 * MINUTE]: 4 })
    })

    it("keeps the newest 60 active minutes and counts the older ones as dropped", () => {
        const observations = Array.from({ length: 62 }, (_, index) => observation(String(index), T0 + index * MINUTE, index + 1))

        const folded = fold(emptyUsageOutbox(1), observations, T0 + 62 * MINUTE)

        expect(folded.minutes.map((minute) => minute.startedAt)).toEqual(
            Array.from({ length: 60 }, (_, index) => T0 + (index + 2) * MINUTE),
        )
        expect(folded.droppedMinutes).toBe(2)
    })
})

describe("takeUsageBatch", () => {
    const pending = fold(
        { ...emptyUsageOutbox(1), droppedMinutes: 3 },
        [observation("1", T0 + 1_000, 10), observation("2", T0 + MINUTE + 1, 20), observation("3", T0 + 2 * MINUTE, 40)],
        T0 + 2 * MINUTE + 1,
    )
    const due = T0 + 2 * MINUTE + SETTLE

    it("builds no new batch before the server gate, while a wait runs, or while a batch is inflight", () => {
        const input = { now: due, requestId: REQUEST_A, client: CLIENT, settleMs: SETTLE }
        const gated = { ...pending, pacing: { ...INITIAL_PACING, nextEligibleAt: due + 1 } }
        const waiting = { ...pending, pacing: { ...INITIAL_PACING, waitUntil: due + 1 } }
        const busy = batch(pending, due).state

        expect(takeUsageBatch(gated, input)).toEqual({ kind: "none" })
        expect(takeUsageBatch(waiting, input)).toEqual({ kind: "none" })
        expect(takeUsageBatch(busy, { ...input, now: due + DEFAULT_INTERVAL_MS.usage, requestId: REQUEST_B })).toEqual({
            kind: "none",
        })
    })

    it("takes only settled minutes into exact bytes and reserves the default interval", () => {
        const { state, inflight, sent, bytes } = batch(pending, due)

        expect(sent).toMatchObject({
            schema_version: 2,
            client: CLIENT,
            window: { started_at: T0, ended_at: T0 + 2 * MINUTE, active_minutes: 2, dropped_minutes: 3 },
        })
        expect(sent.purposes.task?.tokens.input).toBe(30)
        expect(validateUsageBody(sent)).toEqual([])
        expect(inflight).toMatchObject({ requestId: REQUEST_A, bodySha256: sha256Hex(bytes), droppedMinutes: 3, attempts: 0 })
        expect(tokensByMinute(state)).toEqual({ [T0 + 2 * MINUTE]: 40 })
        expect(state).toMatchObject({ sealedThrough: T0 + 2 * MINUTE, droppedMinutes: 0 })
        expect(state.pacing.nextEligibleAt).toBe(due + DEFAULT_INTERVAL_MS.usage)
    })

    it("sends a backlog of minutes that are not contiguous, and keeps one batch within a 60-minute span", () => {
        const backlog = fold(
            emptyUsageOutbox(1),
            [
                observation("1", T0, 1),
                observation("2", T0 + 5 * MINUTE, 2),
                observation("3", T0 + 59 * MINUTE, 4),
                observation("4", T0 + 60 * MINUTE, 8),
            ],
            T0 + 70 * MINUTE,
        )

        const first = batch(backlog, T0 + 70 * MINUTE)

        expect(first.sent.window).toEqual({ started_at: T0, ended_at: T0 + 60 * MINUTE, active_minutes: 3, dropped_minutes: 0 })
        expect(validateUsageBody(first.sent)).toEqual([])
        expect(tokensByMinute(first.state)).toEqual({ [T0 + 60 * MINUTE]: 8 })
    })

    it("drops and counts a batch the service would refuse instead of sending it", () => {
        const decision = takeUsageBatch(pending, {
            now: due,
            requestId: REQUEST_A,
            client: { version: "not a version" },
            settleMs: SETTLE,
        })

        expect(decision.kind).toBe("rejected")
        if (decision.kind !== "rejected") return
        expect(decision.violations).toEqual(["client"])
        expect(decision.state.inflight).toBeUndefined()
        expect(decision.state.droppedMinutes).toBe(3 + 2)
        expect(tokensByMinute(decision.state)).toEqual({ [T0 + 2 * MINUTE]: 40 })
    })
})

describe("settleUsageInflight", () => {
    const sentAt = T0 + 2 * MINUTE + SETTLE
    const sending = batch(fold(emptyUsageOutbox(1), [observation("1", T0 + 1, 10)], sentAt), sentAt)

    it.each([
        "accepted",
        "duplicate",
        "ignored_version",
    ] as const)("drops a batch acknowledged as %s and follows the server's gate", (disposition) => {
        const ackAt = sentAt + 5_000
        const gate = ackAt + 6 * 60 * MINUTE

        const settled = settleUsageInflight(
            sending.state,
            REQUEST_A,
            { kind: "acknowledged", disposition, nextEligibleAt: gate },
            ackAt,
        )

        expect(settled.inflight).toBeUndefined()
        expect(settled.droppedMinutes).toBe(0)
        expect(settled.pacing.nextEligibleAt).toBe(gate + GATE_MARGIN_MS)
        expect(takeUsageBatch(settled, { now: gate, requestId: REQUEST_B, client: CLIENT, settleMs: SETTLE })).toEqual({
            kind: "none",
        })
    })

    it("on a 429 merges the batch back, sends nothing until the wait ends, then rebuilds it under a new request ID", () => {
        const withLater = fold(
            sending.state,
            [observation("2", T0 + 1_500, 5), observation("3", T0 + 3 * MINUTE, 1)],
            T0 + 3 * MINUTE,
            "b.1.sealed.jsonl",
        )
        const waitedAt = sentAt + 1_000

        const waiting = settleUsageInflight(
            withLater,
            REQUEST_A,
            { kind: "wait", code: "quota_protected", retryAfterMs: 90 * MINUTE },
            waitedAt,
            noJitter,
        )
        const resumeAt = waiting.pacing.waitUntil
        const next = batch(waiting, resumeAt, REQUEST_B)

        expect(waiting.inflight).toBeUndefined()
        expect(waiting.droppedMinutes).toBe(0)
        expect(waiting.pacing).toMatchObject({ waitUntil: waitedAt + 90 * MINUTE, consecutiveWaits: 1 })
        expect(takeUsageBatch(waiting, { now: resumeAt - 1, requestId: REQUEST_B, client: CLIENT, settleMs: SETTLE })).toEqual({
            kind: "none",
        })
        expect(next.inflight).toMatchObject({ requestId: REQUEST_B, attempts: 0 })
        expect(next.sent.purposes.task?.tokens.input).toBe(16)
    })

    it("holds a due replay while a wait runs on the channel", () => {
        const replaying = settleUsageInflight(sending.state, REQUEST_A, { kind: "replay" }, sentAt)
        const dueAt = replaying.inflight?.notBefore ?? 0
        const paused: UsageOutboxState = { ...replaying, pacing: { ...replaying.pacing, waitUntil: dueAt + MINUTE } }

        expect(dueUsageReplay(replaying, dueAt)?.requestId).toBe(REQUEST_A)
        expect(dueUsageReplay(paused, dueAt)).toBeUndefined()
        expect(dueUsageReplay(paused, dueAt + MINUTE)?.requestId).toBe(REQUEST_A)
    })

    it("replays the same inflight with backoff and abandons it after the attempt budget", () => {
        let state = sending.state
        let now = sentAt
        for (let attempt = 1; attempt < MAX_REPLAY_ATTEMPTS; attempt++) {
            state = settleUsageInflight(state, REQUEST_A, { kind: "replay" }, now)
            expect(state.inflight?.attempts).toBe(attempt)
            expect(dueUsageReplay(state, now)).toBeUndefined()
            now = state.inflight?.notBefore ?? now
            expect(dueUsageReplay(state, now)?.requestId).toBe(REQUEST_A)
        }

        const abandoned = settleUsageInflight(state, REQUEST_A, { kind: "replay" }, now)

        expect(abandoned.inflight).toBeUndefined()
        expect(abandoned.droppedMinutes).toBe(1)
    })

    it("honours a server delay longer than its own backoff", () => {
        const replayed = settleUsageInflight(sending.state, REQUEST_A, { kind: "replay", retryAfterMs: 10 * MINUTE }, sentAt)

        expect(replayed.inflight?.notBefore).toBe(sentAt + 10 * MINUTE)
    })

    it.each([
        { kind: "discard", code: "invalid_usage" },
        { kind: "too_large" },
    ] as const)("drops a batch refused with $kind without retrying and counts its minutes", (resolution) => {
        const dropped = settleUsageInflight(sending.state, REQUEST_A, resolution, sentAt)

        expect(dropped.inflight).toBeUndefined()
        expect(dropped.droppedMinutes).toBe(1)
        expect(dueUsageReplay(dropped, sentAt + 24 * 60 * MINUTE)).toBeUndefined()
    })

    it("ignores an outcome for a request another sender already settled", () => {
        expect(settleUsageInflight(sending.state, REQUEST_B, { kind: "discard", code: "invalid" }, sentAt)).toBe(sending.state)
    })
})

describe("alignUsagePolicyEpoch", () => {
    it("drops everything gathered under another epoch but keeps the server gate and any wait", () => {
        const sentAt = T0 + 2 * MINUTE + SETTLE
        const { state } = batch(fold(emptyUsageOutbox(1), [observation("1", T0, 10)], sentAt), sentAt)
        const waiting: UsageOutboxState = { ...state, pacing: { ...state.pacing, waitUntil: sentAt + MINUTE } }

        const aligned = alignUsagePolicyEpoch(waiting, 2)

        expect(aligned).toMatchObject({ policyEpoch: 2, minutes: [], droppedMinutes: 0, pacing: waiting.pacing })
        expect(aligned.inflight).toBeUndefined()
        expect(alignUsagePolicyEpoch(aligned, 2)).toBe(aligned)
    })
})
