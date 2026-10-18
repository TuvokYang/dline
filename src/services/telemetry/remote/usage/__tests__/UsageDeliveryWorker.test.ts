import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { USAGE_SENDER_LEASE_MS, UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { AcquireOptions, TokenAcquisition } from "../../auth/DeviceTokenBroker"
import type { WireResponse } from "../../contracts/classification"
import { USAGE_WINDOW_MS, type UsageAggregateWire } from "../../contracts/wire"
import { DlineOtelTransportError, type UsageDelivery, type UsageTransport } from "../../transport/DlineOtelHttpClient"
import { USAGE_TOKEN_REJECTED, UsageDeliveryWorker } from "../UsageDeliveryWorker"
import { USAGE_GATE_MARGIN_MS } from "../usageOutbox"
import { windowStartOf } from "../usageWindow"

const MINUTE = USAGE_WINDOW_MS
const SETTLE = 20_000
const TOKENS = "dline.usage.tokens.input.task"

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

    sent(index: number): UsageAggregateWire {
        return JSON.parse(this.deliveries[index].body) as UsageAggregateWire
    }
}

function accepted(duplicate = false): WireResponse {
    return { status: 200, json: { ok: true, disposition: duplicate ? "duplicate" : "accepted" }, retryAfter: null }
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
        start = windowStartOf(Date.now()) + 2 * MINUTE
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
            attributes: { platform: "win32" },
            ownerId,
            batchSettleMs: SETTLE,
            clock: () => now,
            newRequestId: () => `0b4f8a52-5d0e-4e55-9a0c-${String(++requestCounter).padStart(12, "0")}`,
        })
    }

    async function observe(id: string, at: number, tokens: number, policyEpoch = 1): Promise<void> {
        await new UsageObservationSpool(layout, "host-observer").append({
            id,
            receivedAt: at,
            policyEpoch,
            counters: { [TOKENS]: tokens },
            measurements: {},
        })
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
        const sender = worker("window-a", tokens, transport)
        await observe("1", start + 1_000, 7)
        await observe("2", start + 50_000, 5)

        const result = await sendMinute(sender, start)
        const repeat = await sender.runCycle(1)

        expect(result).toEqual({ kind: "delivered", requestId: transport.deliveries[0].requestId, duplicate: false })
        expect(repeat).toEqual({ kind: "idle" })
        expect(transport.deliveries).toHaveLength(1)
        expect(transport.deliveries[0].accessToken).toBe("token-1")
        expect(transport.sent(0)).toMatchObject({
            window_started_at: start,
            window_ended_at: start + MINUTE,
            counters: { [TOKENS]: 12 },
        })
        expect((await new UsageOutboxRepository(layout).read())?.nextEligibleAt).toBe(now + MINUTE + USAGE_GATE_MARGIN_MS)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
    })

    it("replays an unknown outcome with the same request ID and bytes only once it is due", async () => {
        const transport = new FakeTransport()
        transport.replies.push(new DlineOtelTransportError("network"), accepted(true))
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const first = await sendMinute(sender, start)
        now += 1_000
        const early = await sender.runCycle(1)
        now += 60_000
        const replayed = await sender.runCycle(1)

        expect(first.kind).toBe("retrying")
        expect(early).toEqual({ kind: "idle" })
        expect(replayed).toMatchObject({ kind: "delivered", duplicate: true })
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
        now += 2 * MINUTE
        await sender.runCycle(1)
        now += MINUTE
        const refused = await sender.runCycle(1)

        expect(refreshed.kind).toBe("delivered")
        expect(tokens.calls.slice(0, 2).map((call) => call.rejectedAccessToken)).toEqual([undefined, "token-1"])
        expect(transport.deliveries.slice(0, 2).map((delivery) => delivery.accessToken)).toEqual(["token-1", "token-2"])
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
        expect(refused).toEqual({ kind: "stopped", scope: "profile", code: USAGE_TOKEN_REJECTED })
    })

    it("merges a batch the server deferred into the next one under a new request ID after the gate", async () => {
        const transport = new FakeTransport()
        transport.replies.push({
            status: 429,
            json: { ok: false, retry_after_ms: 45_000, error: { code: "usage_interval_not_elapsed" } },
            retryAfter: "45",
        })
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const deferred = await sendMinute(sender, start)
        const gate = (await new UsageOutboxRepository(layout).read())?.nextEligibleAt ?? 0
        await observe("2", start + MINUTE + 1_000, 3)
        now = gate - 10_000
        const early = await sender.runCycle(1)
        now = gate
        const merged = await sender.runCycle(1)

        expect(deferred).toMatchObject({ kind: "deferred", code: "usage_interval_not_elapsed" })
        expect(gate).toBeGreaterThanOrEqual(start + MINUTE + SETTLE + 45_000 + USAGE_GATE_MARGIN_MS)
        expect(early).toEqual({ kind: "idle" })
        expect(merged.kind).toBe("delivered")
        expect(transport.deliveries[1].requestId).not.toBe(transport.deliveries[0].requestId)
        expect(transport.sent(1).counters[TOKENS]).toBe(10)
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
