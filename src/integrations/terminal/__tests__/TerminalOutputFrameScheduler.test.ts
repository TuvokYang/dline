import { describe, expect, it, vi } from "vitest"
import { TerminalOutputFrameScheduler } from "../TerminalOutputFrameScheduler"
import type { TerminalOutputLine } from "../types"

function line(value: string): TerminalOutputLine {
    return { line: value, stream: "combined" }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

describe("TerminalOutputFrameScheduler", () => {
    it("flushes one frame for all entries collected in one 20ms interval", async () => {
        vi.useFakeTimers()
        const frames: TerminalOutputLine[][] = []
        const scheduler = new TerminalOutputFrameScheduler({
            sink: async (frame) => {
                frames.push([...frame])
            },
        })

        scheduler.enqueue(line("one"))
        scheduler.enqueue(line("two"))
        scheduler.enqueue(line("three"))

        await vi.advanceTimersByTimeAsync(19)
        expect(frames).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        expect(frames).toEqual([[line("one"), line("two"), line("three")]])
        expect(scheduler.getDiagnostics()).toMatchObject({ activeFlushes: 0, framesFlushed: 1, maxActiveFlushes: 1 })
        vi.useRealTimers()
    })

    it("flushes early when a frame reaches its line capacity", async () => {
        vi.useFakeTimers()
        const frames: TerminalOutputLine[][] = []
        const scheduler = new TerminalOutputFrameScheduler({
            maxFrameLines: 2,
            sink: async (frame) => {
                frames.push([...frame])
            },
        })

        scheduler.enqueue(line("one"))
        scheduler.enqueue(line("two"))
        await vi.advanceTimersByTimeAsync(0)

        expect(frames).toEqual([[line("one"), line("two")]])
        vi.useRealTimers()
    })

    it("keeps one active flush while new output accumulates in one pending buffer", async () => {
        vi.useFakeTimers()
        const firstFlush = deferred()
        const frames: TerminalOutputLine[][] = []
        let sinkCalls = 0
        const scheduler = new TerminalOutputFrameScheduler({
            maxFrameLines: 2,
            sink: async (frame) => {
                sinkCalls++
                frames.push([...frame])
                if (sinkCalls === 1) await firstFlush.promise
            },
        })

        scheduler.enqueue(line("one"))
        scheduler.enqueue(line("two"))
        await vi.advanceTimersByTimeAsync(0)
        expect(sinkCalls).toBe(1)

        for (let index = 0; index < 10_000; index++) scheduler.enqueue(line(`pending-${index}`))
        await vi.advanceTimersByTimeAsync(100)
        expect(sinkCalls).toBe(1)
        expect(scheduler.getDiagnostics().maxActiveFlushes).toBe(1)

        firstFlush.resolve()
        await scheduler.drain()
        expect(frames.flat()).toHaveLength(10_002)
        expect(scheduler.getDiagnostics()).toMatchObject({ activeFlushes: 0, pendingEntries: 0, maxActiveFlushes: 1 })
        vi.useRealTimers()
    })

    it("signals high and low water once while a slow sink is draining", async () => {
        vi.useFakeTimers()
        const firstFlush = deferred()
        const onHighWater = vi.fn()
        const onLowWater = vi.fn()
        let sinkCalls = 0
        const scheduler = new TerminalOutputFrameScheduler({
            maxFrameLines: 1,
            pendingHighWaterBytes: 10,
            pendingLowWaterBytes: 3,
            onHighWater,
            onLowWater,
            sink: async () => {
                sinkCalls++
                if (sinkCalls === 1) await firstFlush.promise
            },
        })

        scheduler.enqueue(line("start"))
        await vi.advanceTimersByTimeAsync(0)
        scheduler.enqueue(line("12345"))
        scheduler.enqueue(line("67890"))
        scheduler.enqueue(line("extra"))

        expect(onHighWater).toHaveBeenCalledTimes(1)
        firstFlush.resolve()
        await scheduler.drain()
        expect(onLowWater).toHaveBeenCalledTimes(1)
        vi.useRealTimers()
    })

    it("shares one in-flight drain promise and consumes the pending frame once", async () => {
        vi.useFakeTimers()
        const flush = deferred()
        const sink = vi.fn(async () => flush.promise)
        const scheduler = new TerminalOutputFrameScheduler({ sink })
        scheduler.enqueue(line("tail"))

        const firstDrain = scheduler.drain()
        const secondDrain = scheduler.drain()
        expect(secondDrain).toBe(firstDrain)
        expect(sink).toHaveBeenCalledTimes(1)

        flush.resolve()
        await Promise.all([firstDrain, secondDrain])
        expect(sink).toHaveBeenCalledTimes(1)
        expect(scheduler.getDiagnostics()).toMatchObject({ framesFlushed: 1, pendingEntries: 0 })
        vi.useRealTimers()
    })

    it("reports a sink failure once and rejects further output", async () => {
        vi.useFakeTimers()
        const failure = new Error("synthetic sink failure")
        const onError = vi.fn()
        const scheduler = new TerminalOutputFrameScheduler({
            maxFrameLines: 1,
            onError,
            sink: async () => {
                throw failure
            },
        })
        scheduler.enqueue(line("failing"))
        await expect(scheduler.drain()).rejects.toBe(failure)
        scheduler.enqueue(line("ignored"))

        expect(onError).toHaveBeenCalledTimes(1)
        expect(onError).toHaveBeenCalledWith(failure)
        expect(scheduler.getDiagnostics()).toMatchObject({ entriesReceived: 1, pendingEntries: 0 })
        vi.useRealTimers()
    })

    it("does not resume a high-water source while closing for lifecycle transfer", async () => {
        vi.useFakeTimers()
        const firstFlush = deferred()
        const onHighWater = vi.fn()
        const onLowWater = vi.fn()
        let sinkCalls = 0
        const scheduler = new TerminalOutputFrameScheduler({
            maxFrameLines: 1,
            pendingHighWaterBytes: 4,
            pendingLowWaterBytes: 0,
            onHighWater,
            onLowWater,
            sink: async () => {
                sinkCalls++
                if (sinkCalls === 1) await firstFlush.promise
            },
        })
        scheduler.enqueue(line("start"))
        await vi.advanceTimersByTimeAsync(0)
        scheduler.enqueue(line("pending"))
        expect(onHighWater).toHaveBeenCalledTimes(1)

        const closing = scheduler.close()
        firstFlush.resolve()
        await closing
        expect(onLowWater).not.toHaveBeenCalled()
        vi.useRealTimers()
    })

    it("stops accepting entries after close without scheduling more work", async () => {
        vi.useFakeTimers()
        const frames: TerminalOutputLine[][] = []
        const scheduler = new TerminalOutputFrameScheduler({
            sink: async (frame) => {
                frames.push([...frame])
            },
        })
        scheduler.enqueue(line("admitted"))
        const closed = scheduler.close()
        scheduler.enqueue(line("ignored"))
        await closed

        expect(frames).toEqual([[line("admitted")]])
        expect(scheduler.getDiagnostics()).toMatchObject({ entriesReceived: 1, framesFlushed: 1, pendingEntries: 0 })
        expect(vi.getTimerCount()).toBe(0)
        vi.useRealTimers()
    })

    it("drains a pending tail immediately without waiting for the visual timer", async () => {
        vi.useFakeTimers()
        const frames: TerminalOutputLine[][] = []
        const scheduler = new TerminalOutputFrameScheduler({
            sink: async (frame) => {
                frames.push([...frame])
            },
        })

        scheduler.enqueue(line("tail"))
        await scheduler.drain()

        expect(frames).toEqual([[line("tail")]])
        expect(vi.getTimerCount()).toBe(0)
        vi.useRealTimers()
    })
})
