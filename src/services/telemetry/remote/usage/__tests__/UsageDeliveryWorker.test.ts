import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { SEALED_SHARD_SETTLE_MS, UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { USAGE_SENDER_LEASE_MS, UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { AcquireOptions, TokenAcquisition } from "../../auth/DeviceTokenBroker"
import type { WireResponse } from "../../contracts/classification"
import { USAGE_GRANT_HARD_LIMITS, type UsageGrantContract } from "../../contracts/deviceGrant"
import { DEFAULT_INTERVAL_MS, GATE_MARGIN_MS } from "../../contracts/pacing"
import {
    USAGE_MINUTE_MS,
    USAGE_SECOND_MS,
    type UsageAttemptBodyValidation,
    type UsageAttemptBodyWire,
    type UsageBodyWire,
} from "../../contracts/usageBody"
import { DlineOtelTransportError, type UsageDelivery, type UsageTransport } from "../../transport/DlineOtelHttpClient"
import { USAGE_TOKEN_REJECTED, UsageDeliveryWorker } from "../UsageDeliveryWorker"
import { secondStartOf } from "../usageBatch"
import { projectUsageSettlement } from "../usageTally"

const MINUTE = USAGE_MINUTE_MS
const SECOND = USAGE_SECOND_MS
const SETTLE = 20_000
const HOUR = 60 * MINUTE
const ATTEMPT_CONTRACT: UsageGrantContract = {
    schemaVersion: 4,
    contractVersion: 4,
    ...USAGE_GRANT_HARD_LIMITS,
    defaultIntervalMs: 600_000,
    newBatchJitterMaxMs: 0,
}
const ATTEMPT_VALIDATION: UsageAttemptBodyValidation = {
    contract: ATTEMPT_CONTRACT,
    estimateWriteRows: (body) => 1 + body.buckets.length + body.buckets.reduce((sum, bucket) => sum + bucket.facts.length, 0),
}

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
    readonly deliveries: { requestId: string; accessToken: string; body: string; contractVersion?: 3 | 4 }[] = []
    readonly replies: (WireResponse | DlineOtelTransportError)[] = []

    async sendUsage(delivery: UsageDelivery): Promise<WireResponse> {
        this.deliveries.push({
            requestId: delivery.requestId,
            accessToken: delivery.accessToken,
            body: new TextDecoder().decode(delivery.body),
            contractVersion: delivery.contractVersion,
        })
        const reply = this.replies.shift() ?? accepted()
        if (reply instanceof DlineOtelTransportError) throw reply
        return reply
    }

    sent(index: number): UsageBodyWire {
        return JSON.parse(this.deliveries[index].body) as UsageBodyWire
    }

    sentAttempt(index: number): UsageAttemptBodyWire {
        return JSON.parse(this.deliveries[index].body) as UsageAttemptBodyWire
    }
}

function accepted(disposition = "accepted", nextEligibleAt?: number): WireResponse {
    const gate = nextEligibleAt === undefined ? {} : { next_eligible_at: nextEligibleAt }
    return { status: 200, json: { ok: true, disposition, ...gate }, retryAfter: null }
}

function inputTokens(body: UsageBodyWire): number | undefined {
    // One fact per identity, so the batch's input is the sum of its facts.
    return body.facts.reduce((sum, fact) => sum + fact.tokens.input, 0)
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
        start = secondStartOf(Date.now()) + 2 * MINUTE
        now = start
        requestCounter = 0
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function worker(
        ownerId: string,
        tokens: FakeTokens,
        transport: FakeTransport,
        attemptValidation?: UsageAttemptBodyValidation,
        readAttemptValidation?: () => Promise<UsageAttemptBodyValidation | undefined>,
    ): UsageDeliveryWorker {
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
            attemptValidation,
            readAttemptValidation,
        })
    }

    async function observeAttempt(id: string, admittedAt: number, durationMs: number): Promise<void> {
        await new UsageObservationSpool(layout, "host-observer").appendAttempt({
            id,
            revision: 1,
            receivedAt: admittedAt + durationMs,
            observation: {
                attemptObservationId: id,
                logicalRequestId: `logical-${id}`,
                identity: {
                    role: "task",
                    provider: "anthropic",
                    modelId: "catalog:claude-opus-4-1",
                    thinking: 2048,
                },
                policyGeneration: 7,
                admittedAt,
                outcome: "completed",
                durationMs,
                tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
                tokenUsageReported: true,
            },
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

    it("does not cut over or consume attempt shards without an active schema 4 grant", async () => {
        const transport = new FakeTransport()
        const sender = worker("window-a", new FakeTokens(), transport, undefined, async () => undefined)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await observeAttempt("attempt-a", start + 1_000, 58_400)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })

        expect(await outbox.readAttempts()).toBeUndefined()
        expect(await outbox.read()).toBeDefined()
        expect(transport.deliveries).toEqual([])
        expect((await fs.readdir(layout.usageObservationsDir)).some((name) => name.endsWith(".attempts.jsonl"))).toBe(true)
    })

    it("uses the live grant for clean cut and stops sending after that grant expires", async () => {
        const transport = new FakeTransport()
        let activeValidation: UsageAttemptBodyValidation | undefined
        const sender = worker("window-a", new FakeTokens(), transport, undefined, async () => activeValidation)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await observeAttempt("attempt-a", start + 1_000, 58_400)
        await observeAttempt("attempt-b", start + 2_000, 18_500)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        expect(await outbox.readAttempts()).toBeUndefined()

        activeValidation = ATTEMPT_VALIDATION
        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        expect(await outbox.readAttempts()).toBeDefined()

        activeValidation = undefined
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        expect(transport.deliveries).toEqual([])
        expect((await outbox.readAttempts())?.buckets.sealed).toHaveLength(1)

        activeValidation = ATTEMPT_VALIDATION
        expect(await sender.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "accepted" })
        expect(transport.deliveries).toHaveLength(1)
    })

    it("fsyncs deterministic loss evidence before rejecting an unsendable sealed bucket", async () => {
        const transport = new FakeTransport()
        const validation: UsageAttemptBodyValidation = {
            ...ATTEMPT_VALIDATION,
            contract: { ...ATTEMPT_CONTRACT, maxBodyBytes: 1 },
        }
        const sender = worker("window-a", new FakeTokens(), transport, validation)
        await observeAttempt("attempt-a", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toEqual({ kind: "rejected", violations: ["body_size"] })

        const names = (await fs.readdir(layout.remoteQuarantineDir)).filter((name) => name.startsWith("usage-attempt-loss-"))
        expect(names).toHaveLength(1)
        const evidence = JSON.parse(await fs.readFile(path.join(layout.remoteQuarantineDir, names[0]), "utf8"))
        expect(evidence).toMatchObject({
            schema_version: 1,
            kind: "usage_attempt_bucket_loss",
            stage: "validation",
            bucket_ids: [expect.any(String)],
            violations: ["body_size"],
        })
        expect(transport.deliveries).toEqual([])
    })

    it("records permanent delivery loss before releasing the immutable bucket", async () => {
        const transport = new FakeTransport()
        transport.replies.push({ status: 422, json: { ok: false, error: { code: "invalid_usage" } }, retryAfter: null })
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        await observeAttempt("attempt-a", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toMatchObject({ kind: "discarded", code: "invalid_usage" })

        const names = (await fs.readdir(layout.remoteQuarantineDir)).filter((name) => name.startsWith("usage-attempt-loss-"))
        expect(names).toHaveLength(1)
        const evidence = JSON.parse(await fs.readFile(path.join(layout.remoteQuarantineDir, names[0]), "utf8"))
        expect(evidence).toMatchObject({
            kind: "usage_attempt_bucket_loss",
            stage: "delivery",
            violations: ["invalid_usage"],
        })
        expect((await new UsageOutboxRepository(layout).readAttempts())?.buckets.sealed).toEqual([])
    })

    it("folds settled schema 4 attempt shards into the fenced machine repository before delivery", async () => {
        const tokens = new FakeTokens()
        const transport = new FakeTransport()
        const sender = worker("window-a", tokens, transport)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await outbox.activateAttempts(7)
        await observeAttempt("attempt-a", start + 1_000, 58_400)
        await observeAttempt("attempt-b", start + 2_000, 18_500)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })

        const state = await outbox.readAttempts()
        expect(state?.buckets.open).toBeUndefined()
        expect(state?.buckets.sealed).toHaveLength(1)
        expect(state?.buckets.sealed[0].durationMs).toBe(76_900)
        const bucketId = state?.buckets.sealed[0].bucketId
        expect(state?.observationRevisions).toEqual({
            "attempt-a": { revision: 1, bucketId },
            "attempt-b": { revision: 1, bucketId },
        })
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
        expect(transport.deliveries).toEqual([])
    })

    it("seals and delivers a low-frequency schema 4 bucket when its event window ends", async () => {
        const transport = new FakeTransport()
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await observeAttempt("attempt-low", start + 1_000, 500)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        const open = (await outbox.readAttempts())?.buckets.open
        if (!open) throw new Error("expected a low-frequency open bucket")

        now = open.windowEndedAt
        expect(await sender.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "accepted" })
        expect(transport.sentAttempt(0).buckets[0]).toMatchObject({ duration_ms: 500 })
        expect((await outbox.readAttempts())?.observationRevisions).toEqual({})
    })

    it("persists a schema 4 429 wait across restart and replays the exact request before later work", async () => {
        const transport = new FakeTransport()
        transport.replies.push({
            status: 429,
            json: { ok: false, retry_after_ms: 120_000, error: { code: "telemetry_paused" } },
            retryAfter: "120",
        })
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        await observeAttempt("attempt-paused", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        const paused = await sender.runCycle(7)
        const waitUntil = (await new UsageOutboxRepository(layout).readAttempts())?.pacing.waitUntil ?? 0
        const restarted = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        now = waitUntil - 1
        expect(await restarted.runCycle(7)).toEqual({ kind: "idle" })
        now = waitUntil
        transport.replies.push(accepted("duplicate"))
        expect(await restarted.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "duplicate" })

        expect(paused).toMatchObject({ kind: "paused", code: "telemetry_paused", until: waitUntil })
        expect(transport.deliveries).toHaveLength(2)
        expect(transport.deliveries[1].requestId).toBe(transport.deliveries[0].requestId)
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
    })

    it("lets a schema 4 sender take over an unknown-outcome inflight and replay the exact bytes", async () => {
        const transport = new FakeTransport()
        transport.replies.push(new DlineOtelTransportError("timeout"))
        const first = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        const second = worker("window-b", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        await observeAttempt("attempt-takeover", start + 1_000, 60_000)

        expect(await first.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await first.runCycle(7)).toMatchObject({ kind: "retrying" })
        expect(await second.runCycle(7)).toEqual({ kind: "standby" })
        now += USAGE_SENDER_LEASE_MS
        expect(await second.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "accepted" })
        expect(await first.runCycle(7)).toEqual({ kind: "standby" })

        expect(transport.deliveries).toHaveLength(2)
        expect(transport.deliveries[1].requestId).toBe(transport.deliveries[0].requestId)
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
    })

    it("publishes immutable schema 4 bytes only when complete grant validation is present", async () => {
        const tokens = new FakeTokens()
        const transport = new FakeTransport()
        const sender = worker("window-a", tokens, transport, ATTEMPT_VALIDATION)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await outbox.activateAttempts(7)
        await observeAttempt("attempt-a", start + 1_000, 58_400)
        await observeAttempt("attempt-b", start + 2_000, 18_500)

        await sender.runCycle(7)
        now += SEALED_SHARD_SETTLE_MS
        const result = await sender.runCycle(7)

        expect(result).toMatchObject({ kind: "delivered", disposition: "accepted" })
        expect(transport.deliveries).toHaveLength(1)
        expect(transport.deliveries[0].contractVersion).toBe(4)
        expect(transport.sentAttempt(0)).toMatchObject({
            schema_version: 4,
            buckets: [
                {
                    duration_ms: 76_900,
                    facts: [
                        {
                            role: "task",
                            provider: "anthropic",
                            model_id: "catalog:claude-opus-4-1",
                            thinking: 2048,
                            requests: { completed: 2 },
                        },
                    ],
                },
            ],
        })
        expect((await outbox.readAttempts())?.buckets.sealed).toEqual([])
        expect((await outbox.readAttempts())?.inflight).toBeUndefined()
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
    })

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
        expect(transport.deliveries[0].contractVersion).toBe(3)
        // The two observations land in their own seconds, so the window names those
        // seconds rather than the minute they started in.
        expect(transport.sent(0).window).toMatchObject({
            started_at: start + 1_000,
            ended_at: start + 50_000 + SECOND,
            active_seconds: 2,
            dropped_seconds: 0,
        })
        expect(inputTokens(transport.sent(0))).toBe(12)
        expect((await pacing())?.nextEligibleAt).toBe(start + 20 * MINUTE + GATE_MARGIN_MS)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
    })

    it("builds no new batch before the gate the service named, and sends everything gathered once it opens", async () => {
        const transport = new FakeTransport()
        transport.replies.push(accepted("accepted", start + 6 * HOUR))
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const delivered = await sendMinute(sender, start)
        await observe("2", start + 2 * MINUTE, 3)
        await observe("3", start + 30 * MINUTE, 4)
        now = start + 6 * HOUR - MINUTE
        const held = await sender.runCycle(1)
        now = start + 6 * HOUR + GATE_MARGIN_MS
        const next = await sender.runCycle(1)

        expect(delivered).toMatchObject({ kind: "delivered", disposition: "accepted" })
        // The gate the acknowledgement named holds the next batch back.
        expect(held).toEqual({ kind: "idle" })
        expect(transport.deliveries).toHaveLength(2)
        expect(next.kind).toBe("delivered")
        expect(transport.sent(1).window).toMatchObject({ started_at: start + 2 * MINUTE, active_seconds: 2 })
        expect(inputTokens(transport.sent(1))).toBe(7)
    })

    it("replays a batch whose answer names no confirmation instead of dropping it", async () => {
        const transport = new FakeTransport()
        transport.replies.push(accepted("version_not_stored", start + 6 * HOUR))
        const sender = worker("window-a", new FakeTokens(), transport)
        await observe("1", start + 1_000, 7)

        const first = await sendMinute(sender, start)

        // An unrecognised disposition is not a confirmation: nothing was stored as
        // far as the client knows, so the same bytes are retried rather than lost.
        expect(first).toEqual({ kind: "retrying", requestId: transport.deliveries[0].requestId })
        expect(transport.deliveries).toHaveLength(1)
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
        expect((await new UsageOutboxRepository(layout).read())?.droppedSeconds).toBe(0)
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
        expect(transport.sent(1).window.dropped_seconds).toBe(1)
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
