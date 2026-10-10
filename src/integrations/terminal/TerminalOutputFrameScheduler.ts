import {
    TERMINAL_OUTPUT_FRAME_INTERVAL_MS,
    TERMINAL_OUTPUT_FRAME_MAX_BYTES,
    TERMINAL_OUTPUT_FRAME_MAX_LINES,
    TERMINAL_OUTPUT_PENDING_HIGH_WATER_BYTES,
    TERMINAL_OUTPUT_PENDING_LOW_WATER_BYTES,
} from "./constants"
import type { TerminalOutputLine } from "./types"

export interface TerminalOutputFrameSchedulerOptions {
    readonly sink: (frame: readonly TerminalOutputLine[]) => void | Promise<void>
    readonly intervalMs?: number
    readonly maxFrameLines?: number
    readonly maxFrameBytes?: number
    readonly pendingHighWaterBytes?: number
    readonly pendingLowWaterBytes?: number
    readonly onHighWater?: () => void
    readonly onLowWater?: () => void
    readonly onError?: (error: unknown) => void
}

export interface TerminalOutputFrameSchedulerDiagnostics {
    readonly entriesReceived: number
    readonly bytesReceived: number
    readonly framesFlushed: number
    readonly activeFlushes: number
    readonly maxActiveFlushes: number
    readonly pendingEntries: number
    readonly pendingBytes: number
    readonly maxPendingBytes: number
}

/**
 * Coalesces terminal output into time-based frames with one active asynchronous consumer.
 * New output remains in one mutable pending buffer while the current frame is processed.
 */
export class TerminalOutputFrameScheduler {
    private readonly sink: (frame: readonly TerminalOutputLine[]) => void | Promise<void>
    private readonly intervalMs: number
    private readonly maxFrameLines: number
    private readonly maxFrameBytes: number
    private readonly pendingHighWaterBytes: number
    private readonly pendingLowWaterBytes: number
    private readonly onHighWater?: () => void
    private readonly onLowWater?: () => void
    private readonly onError?: (error: unknown) => void
    private pending: TerminalOutputLine[] = []
    private pendingBytes = 0
    private timer: NodeJS.Timeout | undefined
    private activeFlush: Promise<void> | undefined
    private drainPromise: Promise<void> | undefined
    private closePromise: Promise<void> | undefined
    private failure: unknown
    private closed = false
    private highWaterSignalled = false
    private entriesReceived = 0
    private bytesReceived = 0
    private framesFlushed = 0
    private activeFlushes = 0
    private maxActiveFlushes = 0
    private maxPendingBytes = 0

    constructor(options: TerminalOutputFrameSchedulerOptions) {
        this.sink = options.sink
        this.intervalMs = options.intervalMs ?? TERMINAL_OUTPUT_FRAME_INTERVAL_MS
        this.maxFrameLines = Math.max(1, options.maxFrameLines ?? TERMINAL_OUTPUT_FRAME_MAX_LINES)
        this.maxFrameBytes = Math.max(1, options.maxFrameBytes ?? TERMINAL_OUTPUT_FRAME_MAX_BYTES)
        this.pendingHighWaterBytes = Math.max(1, options.pendingHighWaterBytes ?? TERMINAL_OUTPUT_PENDING_HIGH_WATER_BYTES)
        this.pendingLowWaterBytes = Math.max(
            0,
            Math.min(options.pendingLowWaterBytes ?? TERMINAL_OUTPUT_PENDING_LOW_WATER_BYTES, this.pendingHighWaterBytes),
        )
        this.onHighWater = options.onHighWater
        this.onLowWater = options.onLowWater
        this.onError = options.onError
    }

    enqueue(entry: TerminalOutputLine): void {
        if (this.closed) return
        const bytes = Buffer.byteLength(entry.line, "utf8")
        this.pending.push(entry)
        this.pendingBytes += bytes
        this.entriesReceived += 1
        this.bytesReceived += bytes
        this.maxPendingBytes = Math.max(this.maxPendingBytes, this.pendingBytes)
        this.updateWatermark()

        if (this.activeFlush) return
        if (this.shouldFlushImmediately()) {
            this.startFlush()
            return
        }
        this.scheduleFlush()
    }

    drain(): Promise<void> {
        if (this.drainPromise) return this.drainPromise
        const operation = this.performDrain()
        this.drainPromise = operation
        operation.then(
            () => {
                if (this.drainPromise === operation) this.drainPromise = undefined
            },
            () => {
                if (this.drainPromise === operation) this.drainPromise = undefined
            },
        )
        return operation
    }

    /** Stop accepting output and drain all admitted entries exactly once. */
    close(): Promise<void> {
        if (this.closePromise) return this.closePromise
        this.closed = true
        this.closePromise = this.drain()
        return this.closePromise
    }

    getDiagnostics(): TerminalOutputFrameSchedulerDiagnostics {
        return {
            entriesReceived: this.entriesReceived,
            bytesReceived: this.bytesReceived,
            framesFlushed: this.framesFlushed,
            activeFlushes: this.activeFlushes,
            maxActiveFlushes: this.maxActiveFlushes,
            pendingEntries: this.pending.length,
            pendingBytes: this.pendingBytes,
            maxPendingBytes: this.maxPendingBytes,
        }
    }

    private async performDrain(): Promise<void> {
        this.clearTimer()
        while (this.pending.length > 0 || this.activeFlush) {
            if (!this.activeFlush && this.pending.length > 0) this.startFlush()
            await this.activeFlush
        }
        this.updateWatermark()
        if (this.failure !== undefined) throw this.failure
    }

    private scheduleFlush(): void {
        if (this.timer || this.activeFlush || this.pending.length === 0) return
        this.timer = setTimeout(() => {
            this.timer = undefined
            this.startFlush()
        }, this.intervalMs)
        this.timer.unref?.()
    }

    private startFlush(): void {
        if (this.activeFlush || this.pending.length === 0) return
        this.clearTimer()
        this.activeFlushes += 1
        this.maxActiveFlushes = Math.max(this.maxActiveFlushes, this.activeFlushes)
        const operation = this.flushAvailable().catch((error) => {
            if (this.failure === undefined) {
                this.failure = error
                this.onError?.(error)
            }
            this.closed = true
            this.pending = []
            this.pendingBytes = 0
        })
        this.activeFlush = operation.finally(() => {
            this.activeFlushes -= 1
            this.activeFlush = undefined
            this.updateWatermark()
            if (this.pending.length > 0) this.scheduleFlush()
        })
    }

    private async flushAvailable(): Promise<void> {
        while (this.pending.length > 0) {
            const frame = this.takeFrame()
            this.updateWatermark()
            await this.sink(frame)
            this.framesFlushed += 1
        }
    }

    private takeFrame(): TerminalOutputLine[] {
        let count = 0
        let bytes = 0
        while (count < this.pending.length && count < this.maxFrameLines) {
            const entryBytes = Buffer.byteLength(this.pending[count].line, "utf8")
            if (count > 0 && bytes + entryBytes > this.maxFrameBytes) break
            bytes += entryBytes
            count += 1
            if (bytes >= this.maxFrameBytes) break
        }
        const frame = this.pending.splice(0, Math.max(1, count))
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes)
        return frame
    }

    private shouldFlushImmediately(): boolean {
        return this.pending.length >= this.maxFrameLines || this.pendingBytes >= this.maxFrameBytes
    }

    private updateWatermark(): void {
        if (!this.highWaterSignalled && this.activeFlush && this.pendingBytes >= this.pendingHighWaterBytes) {
            this.highWaterSignalled = true
            this.onHighWater?.()
            return
        }
        if (this.highWaterSignalled && this.pendingBytes <= this.pendingLowWaterBytes) {
            this.highWaterSignalled = false
            if (!this.closed) this.onLowWater?.()
        }
    }

    private clearTimer(): void {
        if (!this.timer) return
        clearTimeout(this.timer)
        this.timer = undefined
    }
}
