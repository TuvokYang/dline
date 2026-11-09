import type { PerformanceEvent, UsageEvent } from "@shared/metrics/events"
import { describe, expect, it } from "vitest"
import { MetricsEventQueue } from "../EventQueue"
import { MetricsHealth } from "../MetricsHealth"
import { type MetricsBatchSink, MetricsReceiver } from "../MetricsReceiver"

const T0 = Date.UTC(2026, 0, 2, 3, 4, 0)

function usage(eventId: string): UsageEvent {
    return {
        kind: "usage",
        eventId,
        observedAtMs: T0,
        sequence: 1,
        workspaceId: "ws",
        taskId: "task-a",
        profileId: "profile-a",
        providerId: "provider-a",
        modelId: "model-a",
        keyFingerprint: "fp",
        logicalRequestId: "request-a",
        roundId: eventId,
        inputTokens: 1,
        outputTokens: 1,
        usageReported: true,
        costComplete: false,
        currencyMixed: false,
        usageQuality: "exact",
    }
}

function performance(eventId: string, factKind: PerformanceEvent["factKind"]): PerformanceEvent {
    return {
        kind: "performance",
        eventId,
        observedAtMs: T0,
        sequence: 1,
        workspaceId: "ws",
        taskId: "task-a",
        profileId: "profile-a",
        providerId: "provider-a",
        modelId: "model-a",
        keyFingerprint: "fp",
        logicalRequestId: "request-a",
        roundId: eventId,
        factKind,
        status: "completed",
        perfQuality: "exact",
    }
}

/** A sink that records what it was asked to write and can be made to fail. */
class RecordingSink implements MetricsBatchSink {
    readonly batches: string[][] = []
    failures = 0
    private attempts = 0

    async commitBatch(events: readonly { eventId: string }[]) {
        this.attempts += 1
        if (this.attempts <= this.failures) throw new Error("database is busy")
        this.batches.push(events.map((event) => event.eventId))
        return {
            accepted: events.length,
            usageRows: events.length,
            performanceRows: 0,
            duplicate: 0,
            lateExpired: 0,
        }
    }

    get attemptCount(): number {
        return this.attempts
    }
}

describe("MetricsEventQueue", () => {
    it("drops the overflow instead of growing without bound", () => {
        const queue = new MetricsEventQueue({ capacity: 2 })
        expect(queue.offer(usage("usage:1"))).toBe(true)
        expect(queue.offer(usage("usage:2"))).toBe(true)
        expect(queue.offer(usage("usage:3"))).toBe(false)

        expect(queue.pending).toBe(2)
        expect(queue.stats().dropped.queue_full).toBe(1)
        expect(queue.drain().map((event) => event.eventId)).toEqual(["usage:1", "usage:2"])
    })

    it("refuses events after close and records the reason", () => {
        const queue = new MetricsEventQueue({ capacity: 4 })
        queue.close()

        expect(queue.offer(usage("usage:1"))).toBe(false)
        expect(queue.stats()).toMatchObject({ pending: 0, accepted: 0 })
        expect(queue.stats().dropped.scope_closed).toBe(1)
    })

    it("requeues a failed batch in arrival order without exceeding capacity", () => {
        const queue = new MetricsEventQueue({ capacity: 3 })
        queue.requeue([usage("usage:1"), usage("usage:2")])
        queue.requeue([usage("usage:3"), usage("usage:4")])

        expect(queue.drain().map((event) => event.eventId)).toEqual(["usage:3", "usage:1", "usage:2"])
        expect(queue.stats().dropped.receiver_failed).toBe(1)
    })
})

describe("MetricsReceiver", () => {
    it("writes everything that was offered", async () => {
        const queue = new MetricsEventQueue()
        const health = new MetricsHealth()
        const sink = new RecordingSink()
        const receiver = new MetricsReceiver({ queue, health, sink, sleep: async () => {} })

        receiver.offer(usage("usage:1"))
        receiver.offer(performance("provider:1", "provider"))
        const result = await receiver.flush()

        expect(result).toMatchObject({ committedBatches: 1, storedEvents: 2, lostEvents: 0, drained: true })
        expect(sink.batches).toEqual([["usage:1", "provider:1"]])
    })

    it("splits work into batches of the configured size", async () => {
        const queue = new MetricsEventQueue()
        const sink = new RecordingSink()
        const receiver = new MetricsReceiver({
            queue,
            health: new MetricsHealth(),
            sink,
            batchSize: 2,
            sleep: async () => {},
        })

        for (const id of ["usage:1", "usage:2", "usage:3"]) receiver.offer(usage(id))
        const result = await receiver.flush()

        expect(result.committedBatches).toBe(2)
        expect(sink.batches).toEqual([["usage:1", "usage:2"], ["usage:3"]])
    })

    it("retries a failing batch and recovers", async () => {
        const queue = new MetricsEventQueue()
        const health = new MetricsHealth()
        const sink = new RecordingSink()
        sink.failures = 2
        const receiver = new MetricsReceiver({ queue, health, sink, sleep: async () => {} })

        receiver.offer(usage("usage:1"))
        const result = await receiver.flush()

        expect(result).toMatchObject({ committedBatches: 1, storedEvents: 1, lostEvents: 0 })
        expect(sink.attemptCount).toBe(3)
        expect(health.state()).toBe("ok")
    })

    it("gives up after the attempt budget and reports the loss honestly", async () => {
        const queue = new MetricsEventQueue()
        const health = new MetricsHealth({ degradedAfterFailures: 2 })
        const sink = new RecordingSink()
        sink.failures = 10
        const receiver = new MetricsReceiver({ queue, health, sink, maxAttempts: 2, sleep: async () => {} })

        receiver.offer(usage("usage:1"))
        const result = await receiver.flush()

        expect(result).toMatchObject({ committedBatches: 0, storedEvents: 0, lostEvents: 1 })
        expect(queue.stats().dropped.receiver_failed).toBe(1)
        expect(health.state()).toBe("degraded")
        expect(receiver.healthSnapshot().lostEvents).toBe(true)
    })

    it("shares one pass between concurrent flushes", async () => {
        const queue = new MetricsEventQueue()
        const sink = new RecordingSink()
        const receiver = new MetricsReceiver({ queue, health: new MetricsHealth(), sink, sleep: async () => {} })
        receiver.offer(usage("usage:1"))

        const [first, second] = await Promise.all([receiver.flush(), receiver.flush()])

        expect(first).toBe(second)
        expect(sink.batches).toHaveLength(1)
    })
})

describe("MetricsHealth", () => {
    it("reports degraded only after the failure threshold", () => {
        const health = new MetricsHealth({ degradedAfterFailures: 2 })
        health.recordFailure("busy")
        expect(health.state()).toBe("ok")
        health.recordFailure("busy")
        expect(health.state()).toBe("degraded")
        health.recordSuccess(T0)
        expect(health.state()).toBe("ok")
    })

    it("reports closed instead of ok or degraded", () => {
        const health = new MetricsHealth()
        health.markClosed()
        expect(health.state()).toBe("closed")
        expect(health.snapshot(new MetricsEventQueue().stats()).state).toBe("closed")
    })
})
