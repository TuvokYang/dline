/**
 * Whether metric writes are currently keeping up.
 *
 * Degradation is a fact, not an error: a Task must keep working when metrics can no
 * longer be written, so a surface needs to say "these numbers may be incomplete"
 * instead of showing a confident chart built from dropped events.
 */

import type { MetricsDropReason, MetricsQueueStats } from "./EventQueue"

/** How healthy the write path is right now. */
export type MetricsHealthState = "ok" | "degraded" | "closed"

export interface MetricsHealthSnapshot {
    readonly state: MetricsHealthState
    /** Consecutive failed write attempts; 0 while healthy. */
    readonly consecutiveFailures: number
    /** Last failure message, already safe to display (no request bodies or secrets). */
    readonly lastFailure?: string
    /** Epoch milliseconds of the last successful write, if any. */
    readonly lastSuccessAtMs?: number
    /** True when at least one event has been permanently dropped. */
    readonly lostEvents: boolean
    readonly queue: MetricsQueueStats
}

export interface MetricsHealthOptions {
    /**
     * Consecutive failures before the write path is reported as degraded.
     *
     * One transient `SQLITE_BUSY` is normal; a run of them means the numbers a reader
     * sees are no longer a complete account of what happened.
     */
    readonly degradedAfterFailures?: number
}

const DEFAULT_DEGRADED_AFTER = 3

export class MetricsHealth {
    private readonly degradedAfterFailures: number
    private consecutiveFailures = 0
    private lastFailure: string | undefined
    private lastSuccessAtMs: number | undefined
    private closed = false

    constructor(options: MetricsHealthOptions = {}) {
        const threshold = options.degradedAfterFailures ?? DEFAULT_DEGRADED_AFTER
        this.degradedAfterFailures = Math.max(1, threshold)
    }

    recordSuccess(atMs: number): void {
        this.consecutiveFailures = 0
        this.lastFailure = undefined
        this.lastSuccessAtMs = atMs
    }

    /** Record a failed attempt. The message is kept verbatim but must already be sanitized. */
    recordFailure(message: string): void {
        this.consecutiveFailures += 1
        this.lastFailure = message
    }

    /** Mark the scope closed so readers report it instead of waiting for numbers. */
    markClosed(): void {
        this.closed = true
    }

    state(): MetricsHealthState {
        if (this.closed) return "closed"
        return this.consecutiveFailures >= this.degradedAfterFailures ? "degraded" : "ok"
    }

    snapshot(queue: MetricsQueueStats): MetricsHealthSnapshot {
        const dropped = queue.dropped
        const lostEvents = dropped.queue_full > 0 || dropped.scope_closed > 0 || dropped.receiver_failed > 0
        return {
            state: this.state(),
            consecutiveFailures: this.consecutiveFailures,
            ...(this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure }),
            ...(this.lastSuccessAtMs === undefined ? {} : { lastSuccessAtMs: this.lastSuccessAtMs }),
            lostEvents,
            queue,
        }
    }
}

/** Whether a drop reason means the stored numbers are already incomplete. */
export function marksLoss(reason: MetricsDropReason): boolean {
    return reason !== "scope_closed"
}
