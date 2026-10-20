import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { USAGE_SENDER_LEASE_MS, UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { AcquireOptions, TokenAcquisition } from "../../auth/DeviceTokenBroker"
import type { WireResponse } from "../../contracts/classification"
import { DEFAULT_INTERVAL_MS, GATE_MARGIN_MS } from "../../contracts/pacing"
import { USAGE_MINUTE_MS, type UsageBodyWire } from "../../contracts/usageBody"
import { DlineOtelTransportError, type UsageDelivery, type UsageTransport } from "../../transport/DlineOtelHttpClient"
import { USAGE_TOKEN_REJECTED, UsageDeliveryWorker } from "../UsageDeliveryWorker"
import { minuteStartOf } from "../usageBatch"
import { projectUsageSettlement } from "../usageTally"

const MINUTE = USAGE_MINUTE_MS
const SETTLE = 20_000
const HOUR = 60 * MINUTE

class FakeTokens {
    readonly calls: AcquireOptions[] = []
    private issued = 0
    next: TokenAcquisition | undefined

    async acquire(_profile: "usage", options: AcquireOptions = {}): Promise<TokenAcquisition> {
        this.calls.push(options)
        if (this.next) return this.next
        this.issued++
        return {
            status: "ready",
            token: { accessToken: `token-${this.issued}`, deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER, obtainedAt: 0 },
        }
    }
}

class FakeTransport implements UsageTransport {
    readonly deliveries: { requestId: string; accessToken: string; body: string }[] = []
    readonly replies: (WireResponse | DlineOtelTransportError)[] = []

    async sendUsage(delivery: UsageDelivery): Promise<WireResponse> {
        this.deliveries.push({
            requestId: delivery.requestId,
            accessToken: delivery.accessToken,
            body: new TextDecoder().decode(delivery.body),
        })
        const reply = this.replies.shift() ?? accepted()
        if (reply instanceof DlineOtelTransportError) throw reply
        return reply
    }

    sent(index: number): UsageBodyWire {
        return JSON.parse(this.deliveries[index].body) as UsageBodyWire
    }
}

function accepted(disposition = "accepted", nextEligibleAt?: number): WireResponse {
    const gate = nextEligibleAt === undefined ? {} : { next_eligible_at: nextEligibleAt }
    return { status: 200, json: { ok: true, disposition, ...gate }, retryAfter: null }
}

function inputTokens(body: UsageBodyWire): number | undefined {
    return body.purposes.task?.tokens.input
}

describe("UsageDeliveryWorker", () => {
    let root: string
    let layout: OtelStorageLayout
    let now: number
    let start: number
    let requestCounter: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-worker-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        // A minute boundary ahead of the wall clock, so shard settling follows the fake clock rather than file times.
        start = minuteStartOf(Date.now()) + 2 * MINUTE
        now = start
        requestCounter = 0
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function worker(ownerId: string, tokens: FakeTokens, transport: FakeTransport): UsageDeliveryWorker {
        return new UsageDeliveryWorker({
            outbox: new UsageOutboxRepository(layout, { clock: () => now }),
            spool: new UsageObservationSpool(layout, ownerId),
            tokens,
            transport,
            client: { version: "0.11.1", platform: "win32" },
            ownerId,
            batchSettleMs: SETTLE,
            clock: () => now,
            newRequestId: () => `0b4f8a52-5d0e-4e55-9a0c-${String(++requestCounter).padStart(12, "0")}`,
            random: () => 0,
        })
    }

    async function observe(id: string, at: number, tokens: number, policyEpoch = 1): Promise<void> {
        const tally = projectUsageSettlement({
            observationId: id,
            purpose: "task",
            outcome: "completed",
            inputTokens: tokens,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            durationMs: 100,
        })
        await new UsageObservationSpool(layout, "host-observer").append({ id, receivedAt: at, policyEpoch, tally })
    }

    async function pacing() {
        return (await new UsageOutboxRepository(layout).read())?.pacing
    }

    /** Seal now, then come back once the minute and its settle time have passed. */
    async function sendMinute(sender: UsageDeliveryWorker, minuteStart: number) {
        now = Math.max(now, minuteStart + 2_000)
        await sender.runCycle(1)
        now = minuteStart + MINUTE + SETTLE
        return sender.runCycle(1)
    }

    it("delivers a settled minute once and leaves no shard, body or inflight behind", async () => {
        const tokens = new FakeTokens()
        const transport = new FakeTransport()
        transport.replies.push(accepted("accepted", start + 20 * MINUTE))
        const sender = worker("window-a", tokens, transport)
        await observe("1", start + 1_000, 7)
        await observe("2", start + 50_000, 5)

        const result = await sendMinute(sender, start)
        const repeat = await sender.runCycle(1)

        expect(result).toEqual({ kind: "delivered", requestId: transport.deliveries[0].requestId, disposition: "accepted" })
        expect(repeat).toEqual({ kind: "idle" })
        expect(transport.deliveries).toHaveLength(1)
        expect(transport.deliveries[0].accessToken).toBe("token-1")
        expect(transport.sent(0).window).toEqual({
            started_at: start,
            ended_at: start + MINUTE,
            active_minutes: 1,
            dropped_minutes: 0,
        })
        expect(inputTokens(transport.sent(0))).toBe(12)
        expect((await pacing())?.nextEligibleAt).toBe(start + 20 * MINUTE + GATE_MARGIN_MS)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
    })

    it("builds no new batch before the gate the service named, and sends everything gathered once it opens", async () => {
        const transport = new FakeTransport()
        transport.replies.push(accepted("ignored_version", start + 6 * HOUR))
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const ignored = await sendMinute(sender, start)
        await observe("2", start + 2 * MINUTE, 3)
        await observe("3", start + 30 * MINUTE, 4)
        now = start + 6 * HOUR - MINUTE
        await sender.runCycle(1)
        now = start + 6 * HOUR + GATE_MARGIN_MS
        const next = await sender.runCycle(1)

        expect(ignored).toMatchObject({ kind: "delivered", disposition: "ignored_version" })
        expect(transport.deliveries).toHaveLength(2)
        expect(next.kind).toBe("delivered")
        expect(transport.sent(1).window).toMatchObject({ started_at: start + 2 * MINUTE, active_minutes: 2 })
        expect(inputTokens(transport.sent(1))).toBe(7)
    })

    it("replays an unknown outcome with the same request ID and bytes only once it is due", async () => {
        const transport = new FakeTransport()
        transport.replies.push(new DlineOtelTransportError("network"), accepted("duplicate"))
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const first = await sendMinute(sender, start)
        now += 1_000
        const early = await sender.runCycle(1)
        now += 60_000
        const replayed = await sender.runCycle(1)

        expect(first.kind).toBe("retrying")
        expect(early).toEqual({ kind: "idle" })
        expect(replayed).toMatchObject({ kind: "delivered", disposition: "duplicate" })
        expect(transport.deliveries).toHaveLength(2)
        expect(transport.deliveries[1].requestId).toBe(transport.deliveries[0].requestId)
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
    })

    it("exchanges once after a 401 and resends the same bytes, and stops when the fresh token is refused too", async () => {
        const unauthorized: WireResponse = {
            status: 401,
            json: { ok: false, error: { code: "token_expired" } },
            retryAfter: null,
        }
        const tokens = new FakeTokens()
        const transport = new FakeTransport()
        transport.replies.push(unauthorized, accepted())
        const sender = worker("window-a", tokens, transport)
        await observe("1", start + 1_000, 7)

        const refreshed = await sendMinute(sender, start)
        await observe("2", start + MINUTE + SETTLE + 1_000, 3)
        transport.replies.push(unauthorized, unauthorized)
        now += DEFAULT_INTERVAL_MS.usage
        await sender.runCycle(1)
        now += MINUTE
        const refused = await sender.runCycle(1)

        expect(refreshed.kind).toBe("delivered")
        expect(tokens.calls.slice(0, 2).map((call) => call.rejectedAccessToken)).toEqual([undefined, "token-1"])
        expect(transport.deliveries.slice(0, 2).map((delivery) => delivery.accessToken)).toEqual(["token-1", "token-2"])
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
        expect(refused).toEqual({ kind: "stopped", scope: "profile", code: USAGE_TOKEN_REJECTED })
    })

    it("on a pause sends nothing until it ends, even after a restart, then replays the same batch before a new one", async () => {
        const transport = new FakeTransport()
        transport.replies.push({
            status: 429,
            json: { ok: false, retry_after_ms: 2 * HOUR, error: { code: "telemetry_paused" } },
            retryAfter: "7200",
        })
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const paused = await sendMinute(sender, start)
        const pausedAt = now
        await observe("2", start + MINUTE + 1_000, 3)
        now = pausedAt + 2 * HOUR - 10_000
        const restarted = worker("window-a", new FakeTokens(), transport)
        const early = await restarted.runCycle(1)
        now = pausedAt + 2 * HOUR
        transport.replies.push(accepted("accepted", now))
        const replayed = await restarted.runCycle(1)
        now += GATE_MARGIN_MS
        const next = await restarted.runCycle(1)

        expect(paused).toMatchObject({ kind: "paused", code: "telemetry_paused", until: pausedAt + 2 * HOUR })
        expect(early).toEqual({ kind: "idle" })
        expect(replayed).toMatchObject({ kind: "delivered", requestId: transport.deliveries[0].requestId })
        expect(next.kind).toBe("delivered")
        expect(transport.deliveries).toHaveLength(3)
        expect(transport.deliveries[1].requestId).toBe(transport.deliveries[0].requestId)
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
        expect(transport.deliveries[2].requestId).not.toBe(transport.deliveries[0].requestId)
        expect(inputTokens(transport.sent(2))).toBe(3)
        expect((await pacing())?.consecutiveWaits).toBe(0)
    })

    it("after a timeout and a 429, replays the same bytes and takes a duplicate as delivered without counting twice", async () => {
        const transport = new FakeTransport()
        transport.replies.push(new DlineOtelTransportError("timeout"), {
            status: 429,
            json: undefined,
            retryAfter: null,
        })
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        await sendMinute(sender, start)
        const inflight = (await new UsageOutboxRepository(layout).read())?.inflight
        now = inflight?.notBefore ?? now
        const edgeLimited = await sender.runCycle(1)
        const waiting = await new UsageOutboxRepository(layout).read()
        const waitUntil = waiting?.pacing.waitUntil ?? 0
        now = waitUntil - 1
        const held = await sender.runCycle(1)
        now = waitUntil
        transport.replies.push(accepted("duplicate"))
        const replayed = await sender.runCycle(1)
        now += DEFAULT_INTERVAL_MS.usage + GATE_MARGIN_MS
        const after = await sender.runCycle(1)

        expect(edgeLimited).toMatchObject({ kind: "paused", code: "edge_rate_limited" })
        expect(waitUntil - (inflight?.notBefore ?? 0)).toBe(MINUTE)
        expect(waiting?.inflight).toMatchObject({ requestId: inflight?.requestId, attempts: 1 })
        expect(held).toEqual({ kind: "idle" })
        expect(replayed).toMatchObject({ kind: "delivered", disposition: "duplicate" })
        expect(after).toEqual({ kind: "idle" })
        expect(transport.deliveries).toHaveLength(3)
        expect(new Set(transport.deliveries.map((delivery) => delivery.requestId)).size).toBe(1)
        expect(new Set(transport.deliveries.map((delivery) => delivery.body)).size).toBe(1)
        expect((await new UsageOutboxRepository(layout).read())?.droppedMinutes).toBe(0)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
    })

    it("drops a batch the service refuses with 422 without retrying, and reports its minute with the next batch", async () => {
        const transport = new FakeTransport()
        transport.replies.push({ status: 422, json: { ok: false, error: { code: "invalid_usage" } }, retryAfter: null })
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const discarded = await sendMinute(sender, start)
        await observe("2", start + 2 * MINUTE, 3)
        now += DEFAULT_INTERVAL_MS.usage
        await sender.runCycle(1)
        now += MINUTE
        await sender.runCycle(1)

        expect(discarded).toMatchObject({ kind: "discarded", code: "invalid_usage" })
        expect(transport.deliveries).toHaveLength(2)
        expect(transport.sent(1).window.dropped_minutes).toBe(1)
        expect(inputTokens(transport.sent(1))).toBe(3)
    })

    it("keeps a second window on standby and lets it take over the inflight once the lease lapsed", async () => {
        const transport = new FakeTransport()
        transport.replies.push(new DlineOtelTransportError("timeout"))
        const first = worker("window-a", new FakeTokens(), transport)
        const second = worker("window-b", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const stalled = await sendMinute(first, start)
        const standby = await second.runCycle(1)
        now += USAGE_SENDER_LEASE_MS
        const takeover = await second.runCycle(1)
        const formerOwner = await first.runCycle(1)

        expect(stalled.kind).toBe("retrying")
        expect(standby).toEqual({ kind: "standby" })
        expect(takeover).toMatchObject({ kind: "delivered", requestId: transport.deliveries[0].requestId })
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
        expect(formerOwner).toEqual({ kind: "standby" })
    })

    it("reports a refusal without sending, and an edge block as a stop of every profile", async () => {
        const tokens = new FakeTokens()
        tokens.next = { status: "stopped", scope: "all", code: "ip_blocked" }
        const transport = new FakeTransport()
        const sender = worker("window-a", tokens, transport)
        await observe("1", start + 1_000, 7)

        const refused = await sendMinute(sender, start)
        tokens.next = undefined
        transport.replies.push({ status: 403, json: undefined, retryAfter: null })
        now += MINUTE
        const blocked = await sender.runCycle(1)

        expect(refused).toEqual({ kind: "stopped", scope: "all", code: "ip_blocked" })
        expect(blocked).toMatchObject({ kind: "stopped", scope: "all" })
        expect(transport.deliveries).toHaveLength(1)
    })

    it("leaves the inflight untouched when the cycle is aborted mid-send", async () => {
        const transport = new FakeTransport()
        transport.replies.push(new DlineOtelTransportError("aborted"))
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const aborted = await sendMinute(sender, start)
        const resumed = await sender.runCycle(1)

        expect(aborted).toEqual({ kind: "aborted" })
        expect(resumed).toMatchObject({ kind: "delivered", requestId: transport.deliveries[0].requestId })
    })

    it("never sends usage gathered under another policy epoch", async () => {
        const transport = new FakeTransport()
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7, 1)

        now = start + 2_000
        await sender.runCycle(2)
        now = start + MINUTE + SETTLE
        const result = await sender.runCycle(2)

        expect(result).toEqual({ kind: "idle" })
        expect(transport.deliveries).toHaveLength(0)
    })
})
