/**
 * A bounded, synchronous hand-off between Task code and the background writer.
 *
 * `offer` is the only call the hot path makes, and it must never block: no IO, no
 * promise, no database handle, no lock. When the buffer is full the event is dropped
 * and counted, because a Task finishing correctly matters more than a metrics row —
 * and a silently unbounded queue would turn a slow disk into a memory leak.
 */

import type { MetricsEvent } from "@shared/metrics/events"

/** Why an event did not become a stored fact. */
export type MetricsDropReason = "queue_full" | "scope_closed" | "receiver_failed"

export interface MetricsQueueStats {
    /** Events waiting to be written. */
    readonly pending: number
    /** Events accepted since the queue was created. */
    readonly accepted: number
    /** Events dropped per reason since the queue was created. */
    readonly dropped: Readonly<Record<MetricsDropReason, number>>
}

export interface MetricsEventQueueOptions {
    /** Maximum number of buffered events. Must be positive. */
    readonly capacity?: number
}

const DEFAULT_CAPACITY = 4_096

export class MetricsEventQueue {
    private readonly capacity: number
    private readonly buffered: MetricsEvent[] = []
    private readonly droppedCounts: Record<MetricsDropReason, number> = {
        queue_full: 0,
        scope_closed: 0,
        receiver_failed: 0,
    }
    private acceptedCount = 0
    private closed = false

    constructor(options: MetricsEventQueueOptions = {}) {
        const capacity = options.capacity ?? DEFAULT_CAPACITY
        if (!Number.isSafeInteger(capacity) || capacity < 1) {
            throw new Error("A metrics queue capacity must be a positive integer")
        }
        this.capacity = capacity
    }

    /**
     * Buffer one event.
     *
     * Returns `true` when it was accepted. A full or closed queue returns `false` and
     * records why, so a caller can report a real loss instead of pretending success.
     */
    offer(event: MetricsEvent): boolean {
        if (this.closed) {
            this.droppedCounts.scope_closed += 1
            return false
        }
        if (this.buffered.length >= this.capacity) {
            this.droppedCounts.queue_full += 1
            return false
        }
        this.buffered.push(event)
        this.acceptedCount += 1
        return true
    }

    /** Take everything buffered, in arrival order. */
    drain(): MetricsEvent[] {
        if (this.buffered.length === 0) return []
        return this.buffered.splice(0, this.buffered.length)
    }

    /**
     * Put events back after a failed write, oldest first, without exceeding capacity.
     *
     * The failed batch is older than everything still buffered, so it goes back at the
     * front. When only part of it fits, the *earliest* events are kept and the rest are
     * counted as lost: preferring the newest would reorder the ledger's inputs.
     */
    requeue(events: readonly MetricsEvent[]): void {
        if (this.closed) {
            this.droppedCounts.scope_closed += events.length
            return
        }
        const room = Math.max(0, this.capacity - this.buffered.length)
        const retained = events.slice(0, room)
        const overflow = events.length - retained.length
        if (overflow > 0) this.droppedCounts.receiver_failed += overflow
        if (retained.length > 0) this.buffered.unshift(...retained)
    }

    /** Record events the receiver could not apply at all. */
    countReceiverFailure(count: number): void {
        if (count > 0) this.droppedCounts.receiver_failed += count
    }

    /** Refuse every later event; already buffered events stay drainable. */
    close(): void {
        this.closed = true
    }

    get isClosed(): boolean {
        return this.closed
    }

    get pending(): number {
        return this.buffered.length
    }

    stats(): MetricsQueueStats {
        return {
            pending: this.buffered.length,
            accepted: this.acceptedCount,
            dropped: { ...this.droppedCounts },
        }
    }
}

/** An emitter target that only accepts offered events; used by the Task-side adapter. */
export interface MetricsQueueSink {
    offer(event: MetricsEvent): boolean
}
