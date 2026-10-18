import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { type LocalUsagePolicyInputs, RemotePolicyRepository } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import { RemoteUsageCoordinator, type UsageScheduler } from "../RemoteUsageCoordinator"
import type { UsageCycleResult } from "../UsageDeliveryWorker"
import type { RemoteUsageLogLevel } from "../usageCycleLog"

const ALLOWED: LocalUsagePolicyInputs = {
    usageConsent: "enabled",
    organizationDisabled: false,
    hostTelemetryLevel: "all",
}

function settlement(observationId: string): UsageSettlement {
    return {
        observationId,
        purpose: "task",
        outcome: "completed",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 450,
        durationMs: 800,
    }
}

class ManualScheduler implements UsageScheduler {
    readonly pending: { callback: () => void; delayMs: number }[] = []

    schedule(callback: () => void, delayMs: number): () => void {
        const entry = { callback, delayMs }
        this.pending.push(entry)
        return () => {
            const index = this.pending.indexOf(entry)
            if (index >= 0) this.pending.splice(index, 1)
        }
    }

    /** Fire the next timer; the cycle it starts is awaited through the returned promise chain by the caller. */
    fire(): void {
        this.pending.shift()?.callback()
    }
}

class FakeWorker {
    readonly epochs: number[] = []
    readonly signals: AbortSignal[] = []
    releases = 0
    next: UsageCycleResult = { kind: "idle" }
    hold: Promise<void> | undefined

    async runCycle(policyEpoch: number, signal?: AbortSignal): Promise<UsageCycleResult> {
        this.epochs.push(policyEpoch)
        if (signal) this.signals.push(signal)
        if (this.hold) await this.hold
        return signal?.aborted ? { kind: "aborted" } : this.next
    }

    async release(): Promise<void> {
        this.releases++
    }
}

describe("RemoteUsageCoordinator", () => {
    let root: string
    let layout: OtelStorageLayout
    let inputs: LocalUsagePolicyInputs | Error
    let scheduler: ManualScheduler
    let worker: FakeWorker
    let tokenClears: number
    let policy: RemotePolicyRepository
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-coordinator-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        inputs = ALLOWED
        scheduler = new ManualScheduler()
        worker = new FakeWorker()
        tokenClears = 0
        now = 1_900_000_000_000
        policy = new RemotePolicyRepository(layout, { clock: () => now })
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function coordinator(log?: (level: RemoteUsageLogLevel, message: string) => void): RemoteUsageCoordinator {
        return new RemoteUsageCoordinator({
            policy,
            credentials: {
                clearTokens: async () => {
                    tokenClears++
                },
            },
            outbox: new UsageOutboxRepository(layout, { clock: () => now }),
            spool: new UsageObservationSpool(layout, "host-test"),
            worker,
            readPolicyInputs: async () => {
                if (inputs instanceof Error) throw inputs
                return inputs
            },
            clock: () => now,
            scheduler,
            log,
        })
    }

    async function spooled(): Promise<{ id: string; policyEpoch: number; counters: Record<string, number> }[]> {
        const names = await fs.readdir(layout.usageObservationsDir).catch(() => [] as string[])
        const lines: string[] = []
        for (const name of names)
            lines.push(...(await fs.readFile(path.join(layout.usageObservationsDir, name), "utf8")).split("\n"))
        return lines.filter((line) => line.trim()).map((line) => JSON.parse(line))
    }

    /** Wait for background appends or the cycle chain, which run on real file I/O. */
    async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
        const deadline = Date.now() + 5_000
        while (!(await condition())) {
            if (Date.now() > deadline) throw new Error("condition not reached")
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
    }

    const spooledCount = (count: number) => async () => (await spooled()).length === count

    it("spools settled usage under the current epoch only while reporting is allowed", async () => {
        const usage = coordinator()
        await usage.start()
        usage.record(settlement("obs-1"))
        await waitFor(spooledCount(1))
        const epoch = (await policy.read())?.usage?.epoch

        inputs = { ...ALLOWED, usageConsent: "disabled" }
        await usage.refresh()
        usage.record(settlement("obs-2"))

        expect(epoch).toBe(now)
        expect(tokenClears).toBe(1)
        expect(await spooled()).toEqual([])
        expect((await new UsageOutboxRepository(layout).read())?.policyEpoch).toBe(now + 1)
        await usage.dispose()
    })

    it("projects a settlement onto the catalog before it reaches the shard", async () => {
        const usage = coordinator()
        await usage.start()

        usage.record(settlement("obs-1"))
        await usage.dispose()

        expect(await spooled()).toEqual([
            expect.objectContaining({
                id: "obs-1",
                policyEpoch: now,
                counters: expect.objectContaining({
                    "dline.usage.requests.task.completed": 1,
                    "dline.usage.tokens.input.task": 120,
                    "dline.usage.cost_micro_usd.task": 450,
                }),
            }),
        ])
    })

    it("purges unsent usage but keeps the device tokens when the host or organization turns reporting off", async () => {
        const usage = coordinator()
        await usage.start()
        usage.record(settlement("obs-1"))
        await waitFor(spooledCount(1))

        inputs = { ...ALLOWED, hostTelemetryLevel: "error" }
        await usage.refresh()

        expect(await spooled()).toEqual([])
        expect(tokenClears).toBe(0)
        await usage.dispose()
    })

    it("runs delivery under the current epoch and turns a service refusal into a persisted stop", async () => {
        const usage = coordinator()
        await usage.start()
        worker.next = { kind: "stopped", scope: "profile", code: "usage_profile_required" }

        scheduler.fire()
        await waitFor(() => scheduler.pending.length === 1)
        usage.record(settlement("after-stop"))
        scheduler.fire()
        await waitFor(() => scheduler.pending.length === 1)

        expect(worker.epochs).toEqual([now])
        expect(await policy.read()).toMatchObject({
            serverStop: { scope: "profile", code: "usage_profile_required" },
            usage: { decision: { allowed: false, reason: "server_stopped" } },
        })
        expect(await spooled()).toEqual([])
        expect(scheduler.pending).toHaveLength(1)
        await usage.dispose()
    })

    it("logs every delivery event but a steady state only when it is entered", async () => {
        const levels: RemoteUsageLogLevel[] = []
        const usage = coordinator((level) => levels.push(level))
        await usage.start()
        const cycles: UsageCycleResult[] = [
            { kind: "idle" },
            { kind: "idle" },
            { kind: "delivered", requestId: "11111111-aaaa", duplicate: false },
            { kind: "idle" },
            { kind: "waiting", reason: "enrollment_backoff", retryAt: now + 1_000 },
            { kind: "waiting", reason: "enrollment_backoff", retryAt: now + 2_000 },
            { kind: "discarded", requestId: "22222222-bbbb", code: "payload_too_large" },
        ]

        for (const cycle of cycles) {
            worker.next = cycle
            scheduler.fire()
            await waitFor(() => scheduler.pending.length === 1)
        }
        await usage.dispose()

        // Policy line, first idle, delivery, first wait, discard: repeats of a held state stay silent.
        expect(levels).toEqual(["info", "debug", "debug", "debug", "warn"])
    })

    it("closes intake without deleting anything when the policy inputs cannot be read", async () => {
        const usage = coordinator()
        await usage.start()
        usage.record(settlement("obs-1"))
        await waitFor(spooledCount(1))

        inputs = new Error("state not ready")
        await usage.refresh()
        usage.record(settlement("obs-2"))
        await usage.dispose()

        expect((await spooled()).map((entry) => entry.id)).toEqual(["obs-1"])
        expect(tokenClears).toBe(0)
    })

    it("shuts down by closing intake, aborting the cycle, flushing appends and returning the lease", async () => {
        const usage = coordinator()
        await usage.start()
        let releaseCycle: () => void = () => undefined
        worker.hold = new Promise((resolve) => {
            releaseCycle = resolve
        })
        scheduler.fire()
        await waitFor(() => worker.epochs.length === 1)
        usage.record(settlement("obs-1"))

        const disposed = usage.dispose()
        usage.record(settlement("late"))
        releaseCycle()
        await disposed

        expect(worker.signals[0]?.aborted).toBe(true)
        expect((await spooled()).map((entry) => entry.id)).toEqual(["obs-1"])
        expect(worker.releases).toBe(1)
        expect(scheduler.pending).toHaveLength(0)
    })
})
