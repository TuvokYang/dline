import fs from "node:fs/promises"
import path from "node:path"
import type { UsageEvent } from "@shared/metrics/events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MetricsEventQueue } from "../EventQueue"
import {
    currentGlobalMetricsRuntime,
    offerGlobalMetrics,
    openGlobalMetricsRuntime,
    resetGlobalMetricsRuntimeForTests,
} from "../GlobalMetricsRuntime"

const T0 = Date.UTC(2026, 0, 2, 3, 4, 0)

function usage(eventId: string, taskId = "task-a"): UsageEvent {
    return {
        kind: "usage",
        eventId,
        observedAtMs: T0,
        sequence: 1,
        workspaceId: "ws",
        taskId,
        profileId: "profile-a",
        providerId: "provider-a",
        modelId: "model-a",
        keyFingerprint: "fp",
        logicalRequestId: "request-a",
        roundId: eventId,
        inputTokens: 10,
        outputTokens: 2,
        usageReported: true,
        costComplete: false,
        currencyMixed: false,
        usageQuality: "exact",
    }
}

describe("GlobalMetricsRuntime", () => {
    let root: string

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "metrics-global-"))
        resetGlobalMetricsRuntimeForTests()
    })

    afterEach(async () => {
        // Release before forgetting, so no worker outlives the case that started it.
        await currentGlobalMetricsRuntime()?.release()
        resetGlobalMetricsRuntimeForTests()
        await fs.rm(root, { recursive: true, force: true })
    })

    function open(): ReturnType<typeof openGlobalMetricsRuntime> {
        // A missing worker keeps every case off a real thread: what these cases assert
        // is the single-instance contract, not a write.
        return openGlobalMetricsRuntime({ workerPath: path.join(root, "missing-worker.js") })
    }

    // The whole point of the module: one Task opening must not add a second writer.
    // A fresh instance per caller would give every Task its own queue and connection to
    // the same `global/metrics.db`, which is the contention this exists to remove.
    it("hands every caller the same instance", () => {
        const first = open()
        const second = open()

        expect(second).toBe(first)
        expect(second.sink).toBe(first.sink)
        expect(second.reader).toBe(first.reader)
        expect(currentGlobalMetricsRuntime()).toBe(first)
        expect(first.scope).toMatchObject({ level: "global", scopeId: "" })
    })

    // A settlement must never wait. Offering with no runtime open is not an error: the
    // Task recorded its own row already, and the global level is a secondary record.
    it("accepts an offer only while a runtime is open", () => {
        expect(offerGlobalMetrics(usage("usage:before"))).toBe(false)

        const runtime = open()
        expect(offerGlobalMetrics(usage("usage:after"))).toBe(true)
        expect(runtime.snapshot().queue.pending).toBe(1)
    })

    // A released runtime must not be handed out again. Its worker is gone, so reusing it
    // would drop every later global event while the queue still looked healthy.
    it("reopens a fresh instance after the previous one released", async () => {
        const first = open()
        await first.release()

        expect(currentGlobalMetricsRuntime()).toBeUndefined()
        expect(offerGlobalMetrics(usage("usage:orphan"))).toBe(false)

        const second = open()
        expect(second).not.toBe(first)
        expect(offerGlobalMetrics(usage("usage:after-reopen"))).toBe(true)
    })

    // A full queue is reported, not thrown: the hot path must not fail a Task because
    // the secondary level lost its buffer.
    it("reports a refused offer instead of throwing when the queue is full", () => {
        const runtime = open()
        // The runtime's own queue is bounded, so offering past its capacity must return
        // false rather than raise into the caller's settlement path.
        const capacity = runtime.snapshot().queue.pending
        expect(capacity).toBe(0)

        const accepted: boolean[] = []
        for (let index = 0; index < 5_000; index += 1) accepted.push(offerGlobalMetrics(usage(`usage:${index}`)))

        expect(accepted).toContain(false)
        expect(runtime.snapshot().queue.dropped.queue_full).toBeGreaterThan(0)
    })

    // The same fact offered twice is one row: a retried settlement reuses the event id,
    // and the receipt key is derived from it, so a duplicate must reach the ledger as a
    // duplicate rather than as a second accumulation.
    it("keeps both offers of one event so the ledger can deduplicate them", () => {
        const runtime = open()
        const event = usage("usage:same")

        expect(offerGlobalMetrics(event)).toBe(true)
        expect(offerGlobalMetrics(event)).toBe(true)

        // The queue does not deduplicate; the receipt does. Buffering both keeps that
        // decision in the ledger, which is the only place that can apply it atomically.
        expect(runtime.snapshot().queue.pending).toBe(2)
        expect(runtime.snapshot().queue.accepted).toBe(2)
    })

    // A caller that arrives while the writer is shutting down must not be handed that
    // runtime: its queue is already closed, so every later offer would be refused while
    // the health snapshot still looked writable. It must also get *one* replacement, not
    // one per call, or the release window reintroduces the multiple-writer problem.
    it("serves one replacement while the previous runtime is releasing", async () => {
        const first = open()
        const releasing = first.release()

        const duringRelease = open()
        const againDuringRelease = open()

        expect(duringRelease).not.toBe(first)
        expect(againDuringRelease).toBe(duringRelease)
        expect(currentGlobalMetricsRuntime()).toBe(duringRelease)
        // Offers reach the replacement instead of the closing queue.
        expect(offerGlobalMetrics(usage("usage:during-release"))).toBe(true)
        expect(duringRelease.snapshot().queue.pending).toBe(1)

        await releasing
        // The replacement survives the finishing release rather than being cleared with it.
        expect(currentGlobalMetricsRuntime()).toBe(duringRelease)
        expect(offerGlobalMetrics(usage("usage:after-release"))).toBe(true)

        await duringRelease.release()
    })

    // A.release → open(B) → B.release must not hand B out to a third caller. Both queues
    // are closed, so returning either one would accept every event and drop it.
    it("does not return a successor that is itself releasing", async () => {
        const first = open()
        const firstRelease = first.release()
        const second = open()
        const secondRelease = second.release()

        const third = open()
        expect(third).not.toBe(first)
        expect(third).not.toBe(second)
        expect(offerGlobalMetrics(usage("usage:third"))).toBe(true)
        expect(third.snapshot().queue.pending).toBe(1)

        await firstRelease
        await secondRelease
        await third.release()
    })

    // Two overlapping releases must not clear each other's guard: the `finally` of the
    // first would otherwise expose the second, still-closing runtime to the next caller.
    it("keeps a closing runtime out of reach across overlapping releases", async () => {
        const first = open()
        const firstRelease = first.release()
        const second = open()
        const secondRelease = second.release()

        await firstRelease

        const third = open()
        expect(third).not.toBe(first)
        expect(third).not.toBe(second)
        expect(offerGlobalMetrics(usage("usage:during-second-release"))).toBe(true)

        await secondRelease
        await third.release()
    })

    // Distinct Tasks settle into one queue, in arrival order, so a contended process
    // writes them through a single connection instead of one per Task.
    it("interleaves offers from different tasks in one queue", () => {
        const runtime = open()
        offerGlobalMetrics(usage("usage:a1", "task-a"))
        offerGlobalMetrics(usage("usage:b1", "task-b"))
        offerGlobalMetrics(usage("usage:a2", "task-a"))

        const queue = runtime.snapshot().queue
        expect(queue.pending).toBe(3)
        expect(queue.accepted).toBe(3)
        expect(queue.dropped.receiver_failed).toBe(0)
    })
})

describe("MetricsEventQueue requeue", () => {
    // A batch that cannot be written returns to the front: the ledger's inputs stay in
    // arrival order, and only the storage bound may force a counted loss.
    it("keeps the earliest events when only part of a batch fits", () => {
        const queue = new MetricsEventQueue({ capacity: 2 })
        queue.offer(usage("usage:new"))

        queue.requeue([usage("usage:old-1"), usage("usage:old-2")])

        const stats = queue.stats()
        expect(stats.pending).toBe(2)
        expect(stats.accepted).toBe(1)
        // One of the two returning events had no room, and it is the later one.
        expect(stats.dropped.receiver_failed).toBe(1)
    })

    it("refuses a requeue once the queue is closed and counts it", () => {
        const queue = new MetricsEventQueue({ capacity: 4 })
        queue.close()

        queue.requeue([usage("usage:1"), usage("usage:2")])

        const stats = queue.stats()
        expect(stats.pending).toBe(0)
        expect(stats.dropped.scope_closed).toBe(2)
    })
})
