import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { type LocalUsagePolicyInputs, RemotePolicyRepository } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { type PendingUsageAttemptObservation, UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import { API_REQUEST_ROUND_SCHEMA_VERSION } from "@/core/task/performance/api-request-round-types"
import type { FinalizedProviderAttempt } from "@/core/task/performance/provider-request-round-port"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import { SERVER_STOP_RETRY_INTERVAL_MS } from "../../policy/usagePolicy"
import { RemoteUsageCoordinator, type UsageScheduler } from "../RemoteUsageCoordinator"
import type { UsageCycleResult } from "../UsageDeliveryWorker"
import type { RemoteUsageLogLevel } from "../usageCycleLog"
import type { UsageTally } from "../usageTally"

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
        durationMs: 800,
    }
}

function finalizedLogicalAttempt(): FinalizedProviderAttempt {
    const attempt = finalizedAttempt()
    return {
        ...attempt,
        logicalExecution: {
            schemaVersion: 1,
            taskId: "task-1",
            executionId: attempt.handle.roundId,
            revision: 0,
            roundId: attempt.handle.roundId,
            logicalRequestId: attempt.handle.logicalRequestId,
            apiIndex: attempt.handle.apiIndex,
            taskAttempt: attempt.handle.taskAttempt,
            providerAttempt: attempt.handle.providerAttempt,
            startedAtMs: attempt.handle.startedAtMs,
            providerCompletedAtMs: attempt.record.completedAtMs,
            completedAtMs: attempt.record.completedAtMs,
            providerDurationMs: attempt.record.providerDurationMs ?? 1,
            executionDurationMs: attempt.record.providerDurationMs ?? 1,
            status: "completed",
            terminalKind: "provider_only",
            toolCount: 0,
            completedToolCount: 0,
            failedToolCount: 0,
            cancelledToolCount: 0,
        },
    }
}

function finalizedAttempt(): FinalizedProviderAttempt {
    const roundId = "task-1:request-1:provider:0"
    return {
        handle: {
            roundId,
            logicalRequestId: "request-1",
            apiIndex: 0,
            taskAttempt: 0,
            providerAttempt: 0,
            role: "task",
            provider: "openai",
            modelId: "gpt-5-private-wire-id",
            thinking: "state:disabled",
            policyGeneration: 7,
            startedAtMs: 1_899_999_999_000,
            startedMonotonicMs: 100,
        },
        record: {
            schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
            taskId: "task-1",
            roundId,
            revision: 1,
            logicalRequestId: "request-1",
            apiIndex: 0,
            taskAttempt: 0,
            providerAttempt: 0,
            startedAtMs: 1_899_999_999_000,
            completedAtMs: 1_899_999_999_400,
            providerDurationMs: 400,
            status: "completed",
            inputTokens: 10,
            outputTokens: 2,
            thoughtsTokens: 1,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            cacheUsageReported: true,
            usageQuality: "exact",
        },
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
    attemptAuthorityActive = false
    releases = 0
    next: UsageCycleResult = { kind: "idle" }
    hold: Promise<void> | undefined

    async refreshAttemptAuthority(): Promise<boolean> {
        return this.attemptAuthorityActive
    }

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
    let clearedProfiles: unknown[]
    let policy: RemotePolicyRepository
    let now: number
    let reportingChanges: boolean[]

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-coordinator-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        inputs = ALLOWED
        scheduler = new ManualScheduler()
        worker = new FakeWorker()
        tokenClears = 0
        clearedProfiles = []
        now = 1_900_000_000_000
        policy = new RemotePolicyRepository(layout, { clock: () => now })
        reportingChanges = []
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function coordinator(log?: (level: RemoteUsageLogLevel, message: string) => void): RemoteUsageCoordinator {
        return new RemoteUsageCoordinator({
            policy,
            credentials: {
                clearTokens: async (profiles) => {
                    tokenClears++
                    clearedProfiles.push(profiles)
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
            onReportingChanged: (allowed) => reportingChanges.push(allowed),
        })
    }

    async function spooled(): Promise<{ id: string; policyEpoch: number; tally: UsageTally }[]> {
        const names = await fs.readdir(layout.usageObservationsDir).catch(() => [] as string[])
        const lines: string[] = []
        for (const name of names.filter((name) => name.endsWith(".jsonl") && !name.endsWith(".attempts.jsonl"))) {
            lines.push(...(await fs.readFile(path.join(layout.usageObservationsDir, name), "utf8")).split("\n"))
        }
        return lines.filter((line) => line.trim()).map((line) => JSON.parse(line))
    }

    async function spooledAttempts(): Promise<PendingUsageAttemptObservation[]> {
        const names = await fs.readdir(layout.usageObservationsDir).catch(() => [] as string[])
        const lines: string[] = []
        for (const name of names.filter((name) => name.endsWith(".attempts.jsonl"))) {
            lines.push(...(await fs.readFile(path.join(layout.usageObservationsDir, name), "utf8")).split("\n"))
        }
        return lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as PendingUsageAttemptObservation)
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
        // Usage consent owns only the usage token; the diagnostics token is not touched.
        expect(clearedProfiles).toEqual([["usage"]])
        expect(await spooled()).toEqual([])
        expect((await new UsageOutboxRepository(layout).read())?.policyEpoch).toBe(now + 1)
        await usage.dispose()
    })

    it("projects a settlement onto one fact before it reaches the shard", async () => {
        const usage = coordinator()
        await usage.start()

        usage.record(settlement("obs-1"))
        await usage.dispose()

        const [entry] = await spooled()
        expect(entry).toMatchObject({ id: "obs-1", policyEpoch: now })
        expect(entry.tally.facts).toHaveLength(1)
        expect(entry.tally.facts[0]).toMatchObject({
            role: "task",
            requests: { completed: 1, cancelled: 0, failed: 0 },
            tokens: { input: 120 },
        })
    })

    it("rejects an unsafe projection without throwing into the task or writing a shard", async () => {
        const logs: { level: RemoteUsageLogLevel; message: string }[] = []
        const usage = coordinator((level, message) => logs.push({ level, message }))
        await usage.start()

        expect(() => usage.record({ ...settlement("unsafe"), inputTokens: Number.MAX_SAFE_INTEGER + 1 })).not.toThrow()
        await usage.dispose()

        expect(await spooled()).toEqual([])
        expect(logs).toContainEqual({
            level: "warn",
            message: expect.stringContaining("invalid_integer"),
        })
    })

    it("projects each finalized Provider attempt into the separate durable attempt shard", async () => {
        const usage = coordinator()
        await usage.start()

        usage.recordFinalizedAttempt(finalizedAttempt())
        await usage.dispose()

        const attempts = await spooledAttempts()
        expect(await spooled()).toEqual([])
        expect(attempts).toEqual([
            expect.objectContaining({
                id: "task-1:request-1:provider:0",
                revision: 1,
                receivedAt: now,
                observation: expect.objectContaining({
                    attemptObservationId: "task-1:request-1:provider:0",
                    logicalRequestId: "request-1",
                    identity: {
                        role: "task",
                        provider: "openai",
                        modelId: "state:unknown",
                        thinking: "state:disabled",
                    },
                    policyGeneration: 7,
                    durationMs: 400,
                    tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
                    tokenUsageReported: true,
                }),
            }),
        ])
        expect(JSON.stringify(attempts)).not.toContain("gpt-5-private-wire-id")
    })

    it("does not spool finalized attempts while the resolved policy denies reporting", async () => {
        inputs = { ...ALLOWED, usageConsent: "disabled" }
        const usage = coordinator()
        await usage.start()

        usage.recordFinalizedAttempt(finalizedAttempt())
        await usage.dispose()

        expect(await spooledAttempts()).toEqual([])
    })

    it("fails closed without a shard when finalized attempt identity is incomplete", async () => {
        const logs: { level: RemoteUsageLogLevel; message: string }[] = []
        const usage = coordinator((level, message) => logs.push({ level, message }))
        await usage.start()
        const attempt = finalizedAttempt()

        usage.recordFinalizedAttempt({ ...attempt, handle: { ...attempt.handle, modelId: undefined } })
        await usage.dispose()

        expect(await spooledAttempts()).toEqual([])
        expect(logs).toContainEqual({
            level: "warn",
            message: expect.stringContaining("finalized usage attempt was rejected before storage"),
        })
    })

    it("keeps schema 3 session authority before capability clean-cut", async () => {
        const usage = coordinator()
        await usage.start()
        usage.recordSessionStarted()
        usage.recordFinalizedAttempt(finalizedLogicalAttempt())
        await waitFor(spooledCount(1))

        expect(await spooled()).toEqual([
            expect.objectContaining({
                policyEpoch: now,
                tally: { sessions_started: 1, facts: [] },
            }),
        ])
        expect(await spooledAttempts()).toEqual([
            expect.objectContaining({
                observation: expect.not.objectContaining({ sessionsStarted: expect.any(Number) }),
            }),
        ])

        inputs = { ...ALLOWED, usageConsent: "disabled" }
        await usage.refresh()
        usage.recordSessionStarted()
        await usage.dispose()
        expect(await spooled()).toEqual([])

        const notStarted = coordinator()
        notStarted.recordSessionStarted()
        await notStarted.dispose()
        expect(await spooled()).toEqual([])
    })

    it("retires schema 3 logical and session intake once schema 4 is the active authority", async () => {
        worker.attemptAuthorityActive = true
        const usage = coordinator()
        await usage.start()

        usage.record(settlement("legacy-logical"))
        usage.recordSessionStarted()
        usage.recordFinalizedAttempt(finalizedLogicalAttempt())
        await usage.dispose()

        expect(await spooled()).toEqual([])
        expect(await spooledAttempts()).toEqual([
            expect.objectContaining({
                observation: expect.objectContaining({ sessionsStarted: 1, logicalExecution: expect.any(Object) }),
            }),
        ])
    })

    it("reports whether usage may be reported, which services riding on the consent follow", async () => {
        const usage = coordinator()
        expect(usage.reportingAllowed).toBe(false)
        expect(usage.activePolicyGeneration).toBeUndefined()

        await usage.start()
        expect(usage.reportingAllowed).toBe(true)
        expect(usage.activePolicyGeneration).toBe(now)

        inputs = { ...ALLOWED, usageConsent: "disabled" }
        await usage.refresh()
        expect(usage.reportingAllowed).toBe(false)
        expect(usage.activePolicyGeneration).toBeUndefined()

        inputs = ALLOWED
        await usage.refresh()
        expect(usage.reportingAllowed).toBe(true)
        expect(usage.activePolicyGeneration).toBe(now + 2)

        await usage.dispose()
        expect(usage.reportingAllowed).toBe(false)
        expect(usage.activePolicyGeneration).toBeUndefined()
    })

    it("announces every change of reporting permission, including one its own cycle finds", async () => {
        const usage = coordinator()
        await usage.start()
        expect(reportingChanges).toEqual([true])

        // Nobody calls refresh: the next cycle finds that consent was turned off.
        inputs = { ...ALLOWED, usageConsent: "disabled" }
        scheduler.fire()
        await waitFor(() => scheduler.pending.length === 1)
        expect(reportingChanges).toEqual([true, false])

        // A cycle that finds the same answer announces nothing.
        scheduler.fire()
        await waitFor(() => scheduler.pending.length === 1)
        expect(reportingChanges).toEqual([true, false])

        inputs = ALLOWED
        await usage.refresh()
        inputs = new Error("state not ready")
        await usage.refresh()
        inputs = ALLOWED
        await usage.refresh()
        await usage.dispose()

        // Unreadable inputs close reporting as well; shutting this host down does not change the permission.
        expect(reportingChanges).toEqual([true, false, true, false, true])
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

    it("tries a refused service again when the window starts and after the retry interval, not on every cycle", async () => {
        await policy.resolveUsage(ALLOWED)
        await policy.recordServerStop({ scope: "all", code: "edge_blocked" })
        const usage = coordinator()

        await usage.start()
        const allowedAtStart = usage.reportingAllowed
        worker.next = { kind: "stopped", scope: "all", code: "edge_blocked" }
        scheduler.fire()
        await waitFor(() => scheduler.pending.length === 1)
        const allowedAfterRefusal = usage.reportingAllowed
        worker.next = { kind: "idle" }
        scheduler.fire()
        await waitFor(() => scheduler.pending.length === 1)
        const attemptsWhileHeld = worker.epochs.length
        now += SERVER_STOP_RETRY_INTERVAL_MS
        scheduler.fire()
        await waitFor(() => scheduler.pending.length === 1)

        expect([allowedAtStart, allowedAfterRefusal, usage.reportingAllowed]).toEqual([true, false, true])
        expect(attemptsWhileHeld).toBe(1)
        expect(worker.epochs).toHaveLength(2)
        expect((await policy.read())?.serverStop).toBeUndefined()
        await usage.dispose()
    })

    it("logs policy permission as debug context and every delivery event, but a steady state only when entered", async () => {
        const logs: { level: RemoteUsageLogLevel; message: string }[] = []
        const usage = coordinator((level, message) => logs.push({ level, message }))
        await usage.start()
        const cycles: UsageCycleResult[] = [
            { kind: "idle" },
            { kind: "idle" },
            { kind: "delivered", requestId: "11111111-aaaa", disposition: "accepted" },
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
        expect(logs.map(({ level }) => level)).toEqual(["debug", "debug", "debug", "debug", "warn"])
        expect(logs[0]).toEqual({
            level: "debug",
            message: "[RemoteUsage] usage policy permits local collection and remote delivery attempts",
        })
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
