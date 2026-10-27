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
import type { UsageBodyGrant, UsageBodyWire } from "../../contracts/usageBody"
import { canonicalUsageBodyBytes, validateUsageBodySchema } from "../../contracts/usageBodySchema"
import { DlineOtelTransportError, type UsageDelivery, type UsageTransport } from "../../transport/DlineOtelHttpClient"
import { UsageDeliveryWorker } from "../UsageDeliveryWorker"

const SECOND = 1_000
const MINUTE = 60 * SECOND
const SETTLE = 20_000
const ATTEMPT_CONTRACT: UsageGrantContract = {
    schemaVersion: 5,
    contractVersion: 1,
    ...USAGE_GRANT_HARD_LIMITS,
    defaultIntervalMs: 600_000,
    newBatchJitterMaxMs: 0,
}
const ATTEMPT_VALIDATION: UsageBodyGrant = { contract: ATTEMPT_CONTRACT }

class FakeTokens {
    readonly calls: AcquireOptions[] = []
    private issued = 0
    next: TokenAcquisition | undefined
    onAcquire: (() => void) | undefined

    async acquire(_profile: "usage", options: AcquireOptions = {}): Promise<TokenAcquisition> {
        this.calls.push(options)
        this.onAcquire?.()
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

    sentAttempt(index: number): UsageBodyWire {
        return JSON.parse(this.deliveries[index].body) as UsageBodyWire
    }
}

/** A `UsageAck` (usage-contract §15): flat body, and `next_eligible_at` is mandatory. */
function accepted(disposition = "accepted", nextEligibleAt = 0): WireResponse {
    return { status: 200, json: { disposition, next_eligible_at: nextEligibleAt }, retryAfter: null }
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
        start = Math.floor(Date.now() / SECOND) * SECOND + 2 * MINUTE
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
        attemptGrant?: UsageBodyGrant,
        readAttemptGrant?: () => Promise<UsageBodyGrant | undefined>,
    ): UsageDeliveryWorker {
        return new UsageDeliveryWorker({
            outbox: new UsageOutboxRepository(layout, { clock: () => now }),
            spool: new UsageObservationSpool(layout, ownerId),
            tokens,
            transport,
            client: { version: "0.11.1", platform: "win32" },
            ownerId,
            clock: () => now,
            newRequestId: () => `0b4f8a52-5d0e-4e55-9a0c-${String(++requestCounter).padStart(12, "0")}`,
            random: () => 0,
            attemptGrant,
            readAttemptGrant,
        })
    }

    async function observeAttempt(
        id: string,
        admittedAt: number,
        durationMs: number,
        role: "task" | "subagent" | "compaction" = "task",
    ): Promise<void> {
        await new UsageObservationSpool(layout, "host-observer").appendAttempt({
            id,
            revision: 1,
            receivedAt: admittedAt + durationMs,
            localSessionId: "worker-session",
            observation: {
                attemptObservationId: id,
                logicalRequestId: `logical-${id}`,
                identity: {
                    role,
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

    it("does not create legacy authority when schema 4 grant bootstrap publishes no contract", async () => {
        const transport = new FakeTransport()
        const tokens = new FakeTokens()
        const sender = worker("window-a", tokens, transport, undefined, async () => undefined)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await observeAttempt("attempt-a", start + 1_000, 58_400)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })

        expect(tokens.calls).toHaveLength(1)
        expect(await outbox.readAttempts()).toBeUndefined()
        expect(transport.deliveries).toEqual([])
        expect((await fs.readdir(layout.usageObservationsDir)).some((name) => name.endsWith(".attempts.jsonl"))).toBe(true)
    })

    it("bootstraps the schema 5 grant before selecting a delivery contract", async () => {
        const transport = new FakeTransport()
        const tokens = new FakeTokens()
        let activeValidation: UsageBodyGrant | undefined
        tokens.onAcquire = () => {
            activeValidation = ATTEMPT_VALIDATION
        }
        const sender = worker("window-a", tokens, transport, undefined, async () => activeValidation)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await observeAttempt("attempt-a", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        expect(tokens.calls).toHaveLength(1)
        expect(await outbox.readAttempts()).toBeDefined()
        expect(transport.deliveries).toEqual([])

        now = start + MINUTE + SETTLE
        expect(await sender.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "accepted" })
        expect(transport.deliveries).toHaveLength(1)
        expect(transport.sentAttempt(0).schema_version).toBe(5)
    })

    it("preserves auxiliary roles in the final schema 4 delivery body", async () => {
        const transport = new FakeTransport()
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        await observeAttempt("attempt-subagent", start + 1_000, 30_000, "subagent")
        await observeAttempt("attempt-compaction", start + 2_000, 31_000, "compaction")

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now = start + MINUTE + SETTLE
        expect(await sender.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "accepted" })

        expect(transport.deliveries).toHaveLength(1)
        expect(
            transport
                .sentAttempt(0)
                .buckets.flatMap((bucket) => bucket.facts.map((fact) => fact.role))
                .sort(),
        ).toEqual(["compaction", "subagent"])
    })

    it("uses the live grant for clean cut and stops sending after that grant expires", async () => {
        const transport = new FakeTransport()
        let activeValidation: UsageBodyGrant | undefined
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
        const validation: UsageBodyGrant = {
            ...ATTEMPT_VALIDATION,
            contract: { ...ATTEMPT_CONTRACT, maxBodyBytes: 1 },
        }
        const sender = worker("window-a", new FakeTokens(), transport, validation)
        await observeAttempt("attempt-a", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toEqual({ kind: "rejected", violations: ["payload_too_large:body_size"] })

        const names = (await fs.readdir(layout.remoteQuarantineDir)).filter((name) => name.startsWith("usage-attempt-loss-"))
        expect(names).toHaveLength(1)
        const evidence = JSON.parse(await fs.readFile(path.join(layout.remoteQuarantineDir, names[0]), "utf8"))
        expect(evidence).toMatchObject({
            schema_version: 1,
            kind: "usage_attempt_bucket_loss",
            stage: "validation",
            bucket_ids: [expect.any(String)],
            violations: ["payload_too_large:body_size"],
        })
        expect(transport.deliveries).toEqual([])
    })

    it("records permanent delivery loss before releasing the immutable bucket", async () => {
        const transport = new FakeTransport()
        transport.replies.push({
            status: 422,
            json: { disposition: "rejected", code: "invalid_usage_body", path: "buckets[0].facts[0].errors" },
            retryAfter: null,
        })
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        await observeAttempt("attempt-a", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toMatchObject({ kind: "discarded", code: "invalid_usage_body" })

        const names = (await fs.readdir(layout.remoteQuarantineDir)).filter((name) => name.startsWith("usage-attempt-loss-"))
        expect(names).toHaveLength(1)
        const evidence = JSON.parse(await fs.readFile(path.join(layout.remoteQuarantineDir, names[0]), "utf8"))
        expect(evidence).toMatchObject({
            kind: "usage_attempt_bucket_loss",
            stage: "delivery",
            violations: ["invalid_usage_body"],
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
        const nextEligibleAt = start + SEALED_SHARD_SETTLE_MS + 120_000
        transport.replies.push({
            status: 429,
            json: { disposition: "rejected", code: "quota_limited", next_eligible_at: nextEligibleAt },
            // The body names the gate; the header disagrees and must lose.
            retryAfter: "5",
        })
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        await observeAttempt("attempt-paused", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        const paused = await sender.runCycle(7)
        const waitUntil = (await new UsageOutboxRepository(layout).readAttempts())?.pacing.waitUntil ?? 0
        expect(waitUntil).toBe(nextEligibleAt)
        const restarted = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        now = waitUntil - 1
        expect(await restarted.runCycle(7)).toEqual({ kind: "idle" })
        now = waitUntil
        transport.replies.push(accepted("duplicate"))
        expect(await restarted.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "duplicate" })

        expect(paused).toMatchObject({ kind: "paused", code: "quota_limited", until: waitUntil })
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

    it("replays a 200 that is not a UsageAck and confirms ignored_version without a business write", async () => {
        const transport = new FakeTransport()
        // A confirmation without its gate is not a UsageAck: the outcome stays unknown.
        transport.replies.push({ status: 200, json: { disposition: "accepted" }, retryAfter: null })
        transport.replies.push(accepted("ignored_version", start))
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await observeAttempt("attempt-ignored", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toMatchObject({ kind: "retrying" })
        now = (await outbox.readAttempts())?.inflight?.notBefore ?? now
        expect(await sender.runCycle(7)).toMatchObject({ kind: "delivered", disposition: "ignored_version" })

        expect(transport.deliveries).toHaveLength(2)
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
        expect((await outbox.readAttempts())?.buckets.sealed).toEqual([])
    })

    it("dead-letters a request ID conflict without rebuilding the request", async () => {
        const transport = new FakeTransport()
        transport.replies.push({
            status: 409,
            json: { disposition: "rejected", code: "request_id_conflict", path: "request_id" },
            retryAfter: null,
        })
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        await observeAttempt("attempt-conflict", start + 1_000, 60_000)

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toMatchObject({ kind: "discarded", code: "request_id_conflict" })
        now += 10 * MINUTE
        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })

        expect(transport.deliveries).toHaveLength(1)
        expect((await outbox.readAttempts())?.buckets.sealed).toEqual([])
    })

    it("sends RFC 8785 canonical bytes whose hash is the stored manifest hash", async () => {
        const transport = new FakeTransport()
        const sender = worker("window-a", new FakeTokens(), transport, ATTEMPT_VALIDATION)
        await observeAttempt("attempt-z", start + 1_000, 30_000, "subagent")
        await observeAttempt("attempt-y", start + 2_000, 31_000, "compaction")

        expect(await sender.runCycle(7)).toEqual({ kind: "idle" })
        now += SEALED_SHARD_SETTLE_MS
        expect(await sender.runCycle(7)).toMatchObject({ kind: "delivered" })

        const sent = transport.deliveries[0].body
        expect(sent).toBe(new TextDecoder().decode(canonicalUsageBodyBytes(JSON.parse(sent))))
        expect(transport.sentAttempt(0).buckets[0].facts.map((fact) => fact.role)).toEqual(["compaction", "subagent"])
        expect(validateUsageBodySchema(transport.sentAttempt(0), { limits: ATTEMPT_CONTRACT, clientVersion: "0.11.1" })).toEqual(
            [],
        )
    })

    it("publishes immutable schema 5 bytes only when complete grant validation is present", async () => {
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
        expect(transport.sentAttempt(0)).toMatchObject({
            schema_version: 5,
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
})
