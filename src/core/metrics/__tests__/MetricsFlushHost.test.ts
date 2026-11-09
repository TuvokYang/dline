import fs from "node:fs/promises"
import path from "node:path"
import type { UsageEvent } from "@shared/metrics/events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MetricsFlushHost, type MetricsWorkerCommand, type MetricsWorkerPort, type MetricsWorkerReply } from "../MetricsFlushHost"
import type { MetricsScope } from "../MetricsScope"

/**
 * A worker whose replies the test decides.
 *
 * It records every posted command so a case can assert what the host actually handed
 * over, and it never answers on its own: a silent worker is the only way to reproduce
 * a request that outlives its reply.
 */
class ManualWorker implements MetricsWorkerPort {
    readonly commands: MetricsWorkerCommand[] = []
    terminated = 0
    /** True once the thread is gone, mirroring a real worker after `exit`. */
    exited = false
    private messageListeners = new Set<(reply: MetricsWorkerReply) => void>()
    private errorListeners = new Set<(error: Error) => void>()
    private exitListeners = new Set<(code: number) => void>()

    postMessage(message: MetricsWorkerCommand): void {
        this.commands.push(message)
    }

    /** Emulate a worker that dies while a command is unanswered. */
    crash(code: number): void {
        this.exited = true
        for (const listener of this.exitListeners) listener(code)
    }

    onOnline(listener: () => void): void {
        listener()
    }

    onMessage(listener: (reply: MetricsWorkerReply) => void): void {
        this.messageListeners.add(listener)
    }

    /** Mirrors the production port, where the listener survives rejected replies. */
    listenerCount(): number {
        return this.messageListeners.size
    }

    offMessage(listener: (reply: MetricsWorkerReply) => void): void {
        this.messageListeners.delete(listener)
    }

    onError(listener: (error: Error) => void): void {
        this.errorListeners.add(listener)
    }

    offError(listener: (error: Error) => void): void {
        this.errorListeners.delete(listener)
    }

    onExit(listener: (code: number) => void): void {
        this.exitListeners.add(listener)
    }

    offExit(listener: (code: number) => void): void {
        this.exitListeners.delete(listener)
    }

    terminate(): Promise<number> {
        this.terminated += 1
        return Promise.resolve(0)
    }

    /** Answer the oldest unanswered command, echoing its request id. */
    reply(reply: Omit<MetricsWorkerReply, "requestId">): void {
        const [listener] = [...this.messageListeners]
        if (!listener) return
        const pending = [...this.commands].filter((command) => command.type === "flush").at(-1)
        listener({ ...reply, requestId: pending?.requestId ?? 0 })
    }

    /** Answer with an explicit request id, so a case can replay a late reply. */
    replyTo(requestId: number, reply: Omit<MetricsWorkerReply, "requestId">): void {
        for (const listener of this.messageListeners) listener({ ...reply, requestId })
    }
}

function settleMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

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

describe("MetricsFlushHost", () => {
    let root: string
    const hosts: MetricsFlushHost[] = []

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "metrics-host-"))
    })

    afterEach(async () => {
        await Promise.allSettled(hosts.splice(0).map((host) => host.stop()))
        await fs.rm(root, { recursive: true, force: true })
    })

    function host(
        options: { workerPath?: string; worker?: MetricsWorkerPort; requestTimeoutMs?: number; flushIntervalMs?: number } = {},
    ): MetricsFlushHost {
        const scope: MetricsScope = { level: "task", scopeId: "task-a", databasePath: path.join(root, "metrics.db") }
        const created = new MetricsFlushHost({
            scope,
            // A path that does not exist keeps every test off a real worker unless it
            // supplies one; the point of these cases is the host's own bookkeeping.
            workerPath: options.workerPath ?? path.join(root, "missing-worker.js"),
            capacity: 2,
            // Short enough that an unanswered command is a fast failure, not a stall.
            requestTimeoutMs: options.requestTimeoutMs ?? 300,
            // A background pass would retry the rejected batch and change the counters
            // these cases assert; each one drives `flush()` explicitly.
            flushIntervalMs: options.flushIntervalMs ?? 60_000,
            ...(options.worker ? { createWorker: () => options.worker as MetricsWorkerPort } : {}),
        })
        hosts.push(created)
        return created
    }

    /** One started host backed by a worker the test answers by hand. */
    async function startedHost(): Promise<{ created: MetricsFlushHost; worker: ManualWorker }> {
        const worker = new ManualWorker()
        const created = host({ worker })
        await created.start()
        return { created, worker }
    }

    it("accepts events synchronously without any IO", () => {
        const created = host()
        const startedAt = process.hrtime.bigint()
        for (let index = 0; index < 1_000; index += 1) created.emit(usage(`usage:${index}`))
        const elapsedNs = Number(process.hrtime.bigint() - startedAt)

        // The bound is deliberately loose compared with AC-09's 10µs: this asserts the
        // synchronous path performs no IO and no awaits, not a machine-specific rate.
        expect(elapsedNs / 1_000).toBeLessThan(1_000_000)
        expect(created.snapshot().queue.accepted).toBe(2)
        expect(created.snapshot().queue.dropped.queue_full).toBe(998)
    })

    it("does not open a database when started without a loadable worker", async () => {
        const created = host()
        await created.start()
        created.emit(usage("usage:1"))
        // A worker that cannot load its entry script must degrade the write path, never
        // reject the caller and never write through the host thread. An unanswered
        // command must fail within the request deadline instead of waiting forever.
        await expect(created.flush()).resolves.toBeUndefined()
        // Fewer than the degradation threshold, so the state still reads `ok`; the
        // failure is nevertheless visible, names the real cause (the entry script cannot
        // load), and the buffered event is still held for a recovery attempt — it was
        // never lost, and nothing was written on this thread.
        const snapshot = created.snapshot()
        expect(snapshot.state).toBe("ok")
        expect(snapshot.consecutiveFailures).toBeGreaterThanOrEqual(1)
        expect(snapshot.lastFailure).toContain("Cannot find module")
        expect(snapshot.lostEvents).toBe(false)
        expect(snapshot.queue.pending).toBe(1)
        expect(snapshot.lastSuccessAtMs).toBeUndefined()

        await expect(fs.stat(path.join(root, "metrics.db"))).rejects.toThrow()
        expect(created.snapshot().queue.pending).toBe(1)
    })

    it("reports a bounded stop and releases when there is no worker", async () => {
        const created = host()
        const result = await created.stop()

        expect(result).toMatchObject({ outcome: "stopped", released: true })
        expect(result.waitedMs).toBeLessThan(2_000)
        expect(created.snapshot().state).toBe("closed")
    })

    it("is idempotent on stop and refuses later events", async () => {
        const created = host()
        const first = await created.stop()
        const second = await created.stop()

        expect(first.released).toBe(true)
        expect(second.outcome).toBe("already_stopped")
        created.emit(usage("usage:1"))
        expect(created.snapshot().queue.dropped.scope_closed).toBe(1)
    })

    it("does not start again after a stop", async () => {
        const created = host()
        await created.stop()
        await created.start()

        created.emit(usage("usage:1"))
        expect(created.snapshot().queue.accepted).toBe(0)
    })

    it("hands one batch at a time and never exceeds the queue bound", async () => {
        const { created, worker } = await startedHost()

        created.emit(usage("usage:1"))
        created.emit(usage("usage:2"))
        created.emit(usage("usage:3"))
        expect(created.snapshot().queue.pending).toBe(2)

        const first = created.flush()
        await settleMicrotasks()

        // Two concurrent passes must not both reach the worker: the second joins the
        // chain instead of draining another batch it would only hand over later.
        expect(worker.commands).toHaveLength(1)
        const second = created.flush()
        created.emit(usage("usage:3"))
        await settleMicrotasks()
        expect(worker.commands).toHaveLength(1)
        expect(created.snapshot().queue.pending).toBe(1)

        worker.reply({ type: "flushed", storedEvents: 2, lostEvents: 0 })
        await first
        await settleMicrotasks()
        expect(worker.commands).toHaveLength(2)
        const secondBatch = worker.commands[1]
        expect(secondBatch.type).toBe("flush")
        expect(secondBatch.type === "flush" ? secondBatch.events : []).toHaveLength(1)

        worker.reply({ type: "flushed", storedEvents: 1, lostEvents: 0 })
        await second
        expect(created.snapshot().queue.pending).toBe(0)
    })

    it("finishes a stop when the worker never answers", async () => {
        const worker = new ManualWorker()
        const created = host({ worker, requestTimeoutMs: 60_000 })
        await created.start()

        created.emit(usage("usage:1"))
        created.emit(usage("usage:2"))
        const inFlight = created.flush()
        await settleMicrotasks()
        expect(worker.commands).toHaveLength(1)

        // The worker is terminated without a reply. The pass must settle, otherwise the
        // caller and the drained batch stay pending for the process lifetime.
        const stopped = await created.stop()
        await expect(inFlight).resolves.toBeUndefined()

        expect(stopped).toMatchObject({ outcome: "stopped", released: true })
        expect(worker.terminated).toBe(1)
    })

    // Stopping must write what was already accepted. The pass guard refuses after
    // `stopped` is set, so a drain that joined the normal pass chain would silently
    // leave those events in a closed queue that nothing reads again.
    it("writes buffered events during a stop", async () => {
        const worker = new ManualWorker()
        const created = host({ worker })
        await created.start()

        created.emit(usage("usage:1"))
        created.emit(usage("usage:2"))
        const stopping = created.stop()
        await settleMicrotasks()

        const command = worker.commands[0]
        expect(command.type).toBe("flush")
        expect(command.type === "flush" ? command.events.map((event) => event.eventId) : []).toEqual(["usage:1", "usage:2"])
        worker.reply({ type: "flushed", storedEvents: 2, lostEvents: 0 })

        const stopped = await stopping
        expect(stopped.released).toBe(true)
        expect(created.snapshot().queue.pending).toBe(0)
        expect(created.snapshot().lostEvents).toBe(false)
    })

    // `SQLITE_BUSY` is the ordinary outcome when another window holds the global
    // database, so a failed batch must survive for the next pass. It must also survive
    // at full capacity: the returning batch was itself counted as in flight, and a
    // reservation that competes with the batch it released would report a loss on
    // exactly the retry the queue exists to perform.
    it("keeps a failed batch when the queue is already full", async () => {
        const { created, worker } = await startedHost()

        created.emit(usage("usage:1"))
        created.emit(usage("usage:2"))
        expect(created.snapshot().queue.pending).toBe(2)

        const pass = created.flush()
        await settleMicrotasks()
        const handed = worker.commands[0]
        expect(handed.type === "flush" ? handed.events.map((event) => event.eventId) : []).toEqual(["usage:1", "usage:2"])

        worker.reply({ type: "failed", message: "database is locked" })
        await pass

        const snapshot = created.snapshot()
        expect(snapshot.queue.pending).toBe(2)
        expect(snapshot.queue.dropped.receiver_failed).toBe(0)
        expect(snapshot.queue.dropped.queue_full).toBe(0)

        // The retained batch is written by the next pass, in its original order.
        const retry = created.flush()
        await settleMicrotasks()
        const second = worker.commands[1]
        expect(second.type === "flush" ? second.events.map((event) => event.eventId) : []).toEqual(["usage:1", "usage:2"])
        worker.reply({ type: "flushed", storedEvents: 2, lostEvents: 0 })
        await retry
        expect(created.snapshot().queue.pending).toBe(0)
    })

    // A reply that outlives its own deadline is not an answer to whatever the host is
    // waiting for now. Treating it as one would clear a batch the worker never received
    // and report it stored, so the correlation id — not arrival order — decides.
    it("ignores a reply that answers an earlier request", async () => {
        const { created, worker } = await startedHost()

        created.emit(usage("usage:1"))
        const first = created.flush()
        await settleMicrotasks()
        const firstCommand = worker.commands[0]
        expect(firstCommand.type).toBe("flush")
        const staleRequestId = firstCommand.type === "flush" ? firstCommand.requestId : -1
        expect(staleRequestId).toBeGreaterThan(0)

        worker.reply({ type: "failed", message: "database is locked" })
        await first
        expect(created.snapshot().queue.pending).toBe(1)

        const second = created.flush()
        await settleMicrotasks()
        expect(worker.commands).toHaveLength(2)
        const secondCommand = worker.commands[1]
        expect(secondCommand.type === "flush" ? secondCommand.requestId : staleRequestId).not.toBe(staleRequestId)

        // The stale `flushed` claims the first batch committed; it must not settle the
        // second request, which is still in flight.
        let secondSettled = false
        void second.then(() => {
            secondSettled = true
        })
        worker.replyTo(staleRequestId, { type: "flushed", storedEvents: 1, lostEvents: 0 })
        await settleMicrotasks()
        expect(secondSettled).toBe(false)
        expect(worker.terminated).toBe(0)

        // Only the matching reply settles the pass, and it carries a fresh id.
        worker.reply({ type: "flushed", storedEvents: 1, lostEvents: 0 })
        await second
        expect(secondSettled).toBe(true)
        expect(created.snapshot().queue.pending).toBe(0)
    })
})
