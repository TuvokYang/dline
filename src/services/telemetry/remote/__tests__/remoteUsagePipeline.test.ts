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
import { USAGE_WINDOW_MS, type UsageAggregateWire, validateUsageAggregate } from "../contracts/wire"
import { DlineOtelTransportError, type UsageDelivery, type UsageTransport } from "../transport/DlineOtelHttpClient"
import { RemoteUsageCoordinator, type UsageScheduler } from "../usage/RemoteUsageCoordinator"
import { UsageDeliveryWorker } from "../usage/UsageDeliveryWorker"
import { windowStartOf } from "../usage/usageWindow"

/**
 * The remote usage path assembled from its real parts: coordinator, observation
 * spool, outbox and delivery worker on disk, with only the token broker and the
 * HTTP transport replaced. It proves what actually leaves the machine.
 */

const MINUTE = USAGE_WINDOW_MS
const SETTLE = 20_000
const ATTRIBUTES = { client_version: "0.11.0", platform: "win32", architecture: "x64", is_dev: false } as const
const ALLOWED: LocalUsagePolicyInputs = {
    usageConsent: "enabled",
    organizationDisabled: false,
    hostTelemetryLevel: "all",
}
const WIRE_KEYS = new Set([
    "schema_version",
    "window_started_at",
    "window_ended_at",
    "aggregation_count",
    "dropped_windows",
    "counters",
    "measurements",
    "attributes",
])

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
        start = windowStartOf(Date.now()) + 2 * MINUTE
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
            attributes: ATTRIBUTES,
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

    it("sends only catalog counts and allowlisted attributes, and keeps no trace of the request identities", async () => {
        // Canaries stand in for the identities a caller could put into an observation ID.
        const canaries = ["C:/Users/alice/secret-project/billing.ts", "task-1792149608241"]
        const transport = new FakeTransport()
        const host = extensionHost("window-a", transport)
        await host.coordinator.start()

        host.coordinator.record(settlement(canaries[0], { costMicroUsd: 450 }))
        host.coordinator.record(settlement(canaries[1], { purpose: "subagent", outcome: "failed" }))
        await waitFor(async () => (await spooledLines()) === 2)
        await deliverFirstMinute(host)

        expect(transport.deliveries).toHaveLength(1)
        const raw = transport.deliveries[0].body
        for (const canary of canaries) expect(raw).not.toContain(canary)
        const sent = JSON.parse(raw) as UsageAggregateWire
        expect(Object.keys(sent).filter((key) => !WIRE_KEYS.has(key))).toEqual([])
        expect(validateUsageAggregate(sent, now)).toEqual([])
        expect(sent).toMatchObject({ window_started_at: start, window_ended_at: start + MINUTE, attributes: ATTRIBUTES })
        expect(sent.counters).toEqual({
            "dline.usage.requests.task.completed": 1,
            "dline.usage.tokens.input.task": 120,
            "dline.usage.tokens.output.task": 30,
            "dline.usage.cost_micro_usd.task": 450,
            "dline.usage.requests.subagent.failed": 1,
            "dline.usage.tokens.input.subagent": 120,
            "dline.usage.tokens.output.subagent": 30,
        })
        expect(sent.measurements).toEqual({
            "dline.usage.request_duration_ms.task": { count: 1, sum: 800, min: 800, max: 800 },
            "dline.usage.request_duration_ms.subagent": { count: 1, sum: 800, min: 800, max: 800 },
        })
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        const outbox = await fs.readFile(layout.usageOutboxPath, "utf8")
        for (const canary of canaries) expect(outbox).not.toContain(canary)
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
