import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { type LocalUsagePolicyInputs, RemotePolicyRepository } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { USAGE_SENDER_LEASE_MS, UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import type { AcquireOptions, TokenAcquisition } from "../auth/DeviceTokenBroker"
import type { WireResponse } from "../contracts/classification"
import { USAGE_MINUTE_MS, USAGE_SECOND_MS, type UsageBodyWire, validateUsageBody } from "../contracts/usageBody"
import { DlineOtelTransportError, type UsageDelivery, type UsageTransport } from "../transport/DlineOtelHttpClient"
import { RemoteUsageCoordinator, type UsageScheduler } from "../usage/RemoteUsageCoordinator"
import { UsageDeliveryWorker } from "../usage/UsageDeliveryWorker"
import { secondStartOf } from "../usage/usageBatch"

/**
 * The remote usage path assembled from its real parts: coordinator, observation
 * spool, outbox and delivery worker on disk, with only the token broker and the
 * HTTP transport replaced. It proves what actually leaves the machine.
 */

const MINUTE = USAGE_MINUTE_MS
const SECOND = USAGE_SECOND_MS
const SETTLE = 20_000
const CLIENT = { version: "0.11.1", platform: "win32", architecture: "x64", host_editor: "vscode", is_dev: false } as const
const ALLOWED: LocalUsagePolicyInputs = {
    usageConsent: "enabled",
    organizationDisabled: false,
    hostTelemetryLevel: "all",
}
const WIRE_KEYS = new Set(["schema_version", "client", "window", "sessions_started", "facts"])

class FakeTokens {
    async acquire(_profile: "usage", _options: AcquireOptions = {}): Promise<TokenAcquisition> {
        return {
            status: "ready",
            token: { accessToken: "token-1", deviceId: "device", expiresAt: Number.MAX_SAFE_INTEGER, obtainedAt: 0 },
        }
    }
}

class FakeTransport implements UsageTransport {
    readonly deliveries: { requestId: string; body: string }[] = []
    readonly replies: (WireResponse | DlineOtelTransportError)[] = []

    async sendUsage(delivery: UsageDelivery): Promise<WireResponse> {
        this.deliveries.push({ requestId: delivery.requestId, body: new TextDecoder().decode(delivery.body) })
        const reply = this.replies.shift() ?? { status: 200, json: { ok: true, disposition: "accepted" }, retryAfter: null }
        if (reply instanceof DlineOtelTransportError) throw reply
        return reply
    }
}

class ManualScheduler implements UsageScheduler {
    readonly pending: (() => void)[] = []

    schedule(callback: () => void): () => void {
        this.pending.push(callback)
        return () => {
            const index = this.pending.indexOf(callback)
            if (index >= 0) this.pending.splice(index, 1)
        }
    }
}

interface ExtensionHost {
    readonly coordinator: RemoteUsageCoordinator
    readonly scheduler: ManualScheduler
}

describe("remote usage pipeline", () => {
    let root: string
    let layout: OtelStorageLayout
    let start: number
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-pipeline-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        // A minute boundary ahead of the wall clock, so shard settling follows the fake clock rather than file times.
        start = secondStartOf(Date.now()) + 2 * MINUTE
        now = start + 1_000
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function extensionHost(ownerId: string, transport: FakeTransport): ExtensionHost {
        const scheduler = new ManualScheduler()
        const outbox = new UsageOutboxRepository(layout, { clock: () => now })
        const spool = new UsageObservationSpool(layout, ownerId)
        const worker = new UsageDeliveryWorker({
            outbox,
            spool,
            tokens: new FakeTokens(),
            transport,
            client: CLIENT,
            ownerId,
            batchSettleMs: SETTLE,
            clock: () => now,
        })
        const coordinator = new RemoteUsageCoordinator({
            policy: new RemotePolicyRepository(layout, { clock: () => now }),
            credentials: { clearTokens: async () => undefined },
            outbox,
            spool,
            worker,
            readPolicyInputs: async () => ALLOWED,
            clock: () => now,
            scheduler,
        })
        return { coordinator, scheduler }
    }

    /** Fire the scheduled cycle and wait until it finished and scheduled the next one. */
    async function runCycle(host: ExtensionHost): Promise<void> {
        host.scheduler.pending.shift()?.()
        await waitFor(() => host.scheduler.pending.length > 0)
    }

    /** Seal the minute that holds the observations, then send it once it settled. */
    async function deliverFirstMinute(host: ExtensionHost): Promise<void> {
        now = start + 2_000
        await runCycle(host)
        now = start + MINUTE + SETTLE
        await runCycle(host)
    }

    async function spooledLines(): Promise<number> {
        const names = await fs.readdir(layout.usageObservationsDir).catch(() => [] as string[])
        let lines = 0
        for (const name of names) {
            const text = await fs.readFile(path.join(layout.usageObservationsDir, name), "utf8")
            lines += text.split("\n").filter((line) => line.trim()).length
        }
        return lines
    }

    it("sends only the canonical sections, and keeps no trace of the request identities", async () => {
        // Canaries stand in for the identities a caller could put into an observation ID.
        const canaries = ["C:/Users/alice/secret-project/billing.ts", "task-1792149608241"]
        const transport = new FakeTransport()
        const host = extensionHost("window-a", transport)
        await host.coordinator.start()

        host.coordinator.record(settlement(canaries[0], { servedBy: { provider: "anthropic", model: "claude-sonnet-4.5" } }))
        host.coordinator.record(settlement(canaries[1], { purpose: "subagent", outcome: "failed" }))
        await waitFor(async () => (await spooledLines()) === 2)
        await deliverFirstMinute(host)

        expect(transport.deliveries).toHaveLength(1)
        const raw = transport.deliveries[0].body
        for (const canary of canaries) expect(raw).not.toContain(canary)
        const sent = JSON.parse(raw) as UsageBodyWire
        const duration = { count: 1, sum: 800, min: 800, max: 800 }
        const tokens = { input: 120, output: 30, cache_read: 0, cache_write: 0 }
        expect(Object.keys(sent).filter((key) => !WIRE_KEYS.has(key))).toEqual([])
        expect(validateUsageBody(sent)).toEqual([])
        expect(sent).toMatchObject({
            schema_version: 3,
            client: CLIENT,
            // Both settlements arrive inside one second, so the window claims one second
            // rather than counting requests. Which second that is depends on the fake
            // clock, so only the claim itself is asserted here.
            window: {
                started_at: expect.any(Number),
                ended_at: expect.any(Number),
                active_seconds: 1,
                dropped_seconds: 0,
            },
            sessions_started: 0,
        })
        // The two facts are independent, so the batch names each of them exactly once
        // regardless of the order their seconds were folded in.
        expect(sent.facts).toHaveLength(2)
        expect(sent.facts.find((fact) => fact.role === "task")).toEqual({
            role: "task",
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            custom: false,
            requests: { completed: 1, cancelled: 0, failed: 0 },
            tokens,
            duration_ms: { ...duration, buckets: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
            errors: {},
            retries: 0,
            // One logical request, sent once.
            task_attempts: { count: 1, sum: 1, min: 1, max: 1 },
        })
        expect(sent.facts.find((fact) => fact.role === "subagent")).toEqual({
            role: "subagent",
            // A handler that reported no provider is the explicit unnamed identity,
            // exactly as an unnamed model is.
            provider: "_unknown",
            model: "_unknown",
            custom: false,
            requests: { completed: 0, cancelled: 0, failed: 1 },
            tokens,
            duration_ms: { ...duration, buckets: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
            errors: { other: 1 },
            retries: 0,
            task_attempts: { count: 1, sum: 1, min: 1, max: 1 },
        })
        // A one-second claim must fit the span it names.
        expect(sent.window.ended_at - sent.window.started_at).toBe(SECOND)
        expect(sent.window.started_at % SECOND).toBe(0)
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        const outbox = await fs.readFile(layout.usageOutboxPath, "utf8")
        for (const canary of canaries) expect(outbox).not.toContain(canary)
        await host.coordinator.dispose()
    })

    it("quarantines only the ninth model identity and still delivers the valid prefix", async () => {
        const transport = new FakeTransport()
        const host = extensionHost("window-a", transport)
        await host.coordinator.start()

        for (let index = 0; index < 9; index += 1) {
            host.coordinator.record(
                settlement(`capacity-${index}`, {
                    servedBy: { provider: "anthropic", model: `model-${index}` },
                }),
            )
        }
        await waitFor(async () => (await spooledLines()) === 9)
        await deliverFirstMinute(host)

        expect(transport.deliveries).toHaveLength(1)
        const sent = JSON.parse(transport.deliveries[0].body) as UsageBodyWire
        expect(validateUsageBody(sent)).toEqual([])
        expect(sent.facts).toHaveLength(8)
        const sentModels = sent.facts.map((fact) => fact.model)
        expect(new Set(sentModels).size).toBe(8)
        const quarantine = (await fs.readdir(layout.remoteQuarantineDir)).filter((name) => name.startsWith("usage-observation-"))
        expect(quarantine).toHaveLength(1)
        const evidence = JSON.parse(await fs.readFile(path.join(layout.remoteQuarantineDir, quarantine[0]), "utf8")) as {
            kind: string
            observation: { id: string }
            violations: string[]
        }
        expect(evidence).toMatchObject({
            kind: "usage_observation_rejected",
            observation: { id: expect.stringMatching(/^capacity-[0-8]$/u) },
            violations: expect.arrayContaining([expect.any(String)]),
        })
        const rejectedModel = `model-${Number(evidence.observation.id.slice("capacity-".length))}`
        expect([...sentModels, rejectedModel].sort()).toEqual(Array.from({ length: 9 }, (_, index) => `model-${index}`))
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        await host.coordinator.dispose()
    })

    it("replays the exact bytes from a host that died mid-send once another host takes over the lease", async () => {
        const transport = new FakeTransport()
        transport.replies.push(new DlineOtelTransportError("network"))
        const crashed = extensionHost("window-a", transport)
        await crashed.coordinator.start()
        crashed.coordinator.record(settlement("observation-1"))
        await waitFor(async () => (await spooledLines()) === 1)
        await deliverFirstMinute(crashed)
        // The first host is abandoned without dispose, as after a crash: its lease and inflight stay on disk.

        const relaunched = extensionHost("window-b", transport)
        await relaunched.coordinator.start()
        now += USAGE_SENDER_LEASE_MS + MINUTE
        await runCycle(relaunched)

        expect(transport.deliveries).toHaveLength(2)
        expect(transport.deliveries[1].requestId).toBe(transport.deliveries[0].requestId)
        expect(transport.deliveries[1].body).toBe(transport.deliveries[0].body)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        await relaunched.coordinator.dispose()
    })
})

function settlement(observationId: string, overrides: Partial<UsageSettlement> = {}): UsageSettlement {
    return {
        observationId,
        purpose: "task",
        outcome: "completed",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 800,
        ...overrides,
    }
}

/** Background appends and cycles run on real file I/O, so the test waits for their effect. */
async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error("condition not reached")
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}
