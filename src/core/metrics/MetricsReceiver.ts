/**
 * The receiver: where buffered events become stored rows.
 *
 * It owns batching, retry and degradation, and nothing else. It never decides what an
 * event means and never reads a Profile — identity was frozen where the fact happened.
 * A failed batch is retried a bounded number of times with backoff; after that the
 * events are counted as lost and the write path reports itself as degraded, because
 * retrying forever would silently convert a broken disk into an unbounded queue.
 */

import type { MetricsEvent } from "@shared/metrics/events"
import type { MetricsEventQueue, MetricsQueueStats } from "./EventQueue"
import type { MetricsHealth, MetricsHealthSnapshot } from "./MetricsHealth"
import type { MetricsBatchOutcome } from "./MetricsLedger"

/** The one ledger operation the receiver needs. */
export interface MetricsBatchSink {
    commitBatch(events: readonly MetricsEvent[]): Promise<MetricsBatchOutcome>
}

export interface MetricsReceiverOptions {
    readonly queue: MetricsEventQueue
    readonly health: MetricsHealth
    readonly sink: MetricsBatchSink
    /** Maximum events handed to one transaction. */
    readonly batchSize?: number
    /** Failed attempts before a batch is abandoned. */
    readonly maxAttempts?: number
    /** Base delay for the exponential backoff, in milliseconds. */
    readonly retryBaseDelayMs?: number
    /** Injected so tests do not wait on real timers. */
    readonly sleep?: (ms: number) => Promise<void>
    readonly now?: () => number
}

const DEFAULT_BATCH_SIZE = 256
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 50

/** What one flush did, so the host can decide whether to schedule another pass. */
export interface MetricsFlushResult {
    /** Batches that committed. */
    readonly committedBatches: number
    /** Events that became stored rows. */
    readonly storedEvents: number
    /** Events permanently dropped in this pass. */
    readonly lostEvents: number
    /** True when work remains buffered. */
    readonly drained: boolean
}

export class MetricsReceiver {
    private readonly queue: MetricsEventQueue
    private readonly health: MetricsHealth
    private readonly sink: MetricsBatchSink
    private readonly batchSize: number
    private readonly maxAttempts: number
    private readonly retryBaseDelayMs: number
    private readonly sleep: (ms: number) => Promise<void>
    private readonly now: () => number
    private flushing: Promise<MetricsFlushResult> | undefined

    constructor(options: MetricsReceiverOptions) {
        this.queue = options.queue
        this.health = options.health
        this.sink = options.sink
        this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
        this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
        this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS)
        this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
        this.now = options.now ?? Date.now
    }

    /** Accept one event without waiting for storage. */
    offer(event: MetricsEvent): boolean {
        return this.queue.offer(event)
    }

    /**
     * Drain and write once.
     *
     * Concurrent callers share one pass: two overlapping flushes would contend for the
     * same write transaction and only multiply the retries of a busy database.
     */
    async flush(): Promise<MetricsFlushResult> {
        this.flushing ??= this.runFlush().finally(() => {
            this.flushing = undefined
        })
        return await this.flushing
    }

    healthSnapshot(): MetricsHealthSnapshot {
        return this.health.snapshot(this.queue.stats())
    }

    queueStats(): MetricsQueueStats {
        return this.queue.stats()
    }

    /** Refuse new events; buffered ones remain flushable until the host closes the sink. */
    closeIntake(): void {
        this.queue.close()
        this.health.markClosed()
    }

    private async runFlush(): Promise<MetricsFlushResult> {
        let committedBatches = 0
        let storedEvents = 0
        let lostEvents = 0

        while (true) {
            const batch = this.takeBatch()
            if (batch.length === 0) break
            const outcome = await this.commitWithRetry(batch)
            if (outcome === undefined) {
                lostEvents += batch.length
                break
            }
            committedBatches += 1
            storedEvents += outcome.accepted
            if (this.queue.pending === 0) break
        }

        return {
            committedBatches,
            storedEvents,
            lostEvents,
            drained: this.queue.pending === 0,
        }
    }

    /** Take at most one batch, keeping arrival order. */
    private takeBatch(): MetricsEvent[] {
        const drained = this.queue.drain()
        if (drained.length <= this.batchSize) return drained
        const batch = drained.slice(0, this.batchSize)
        this.queue.requeue(drained.slice(this.batchSize))
        return batch
    }

    /**
     * Write one batch, retrying a bounded number of times.
     *
     * Returns `undefined` when every attempt failed; the caller counts the loss
     * instead of putting the batch back forever.
     */
    private async commitWithRetry(batch: readonly MetricsEvent[]): Promise<MetricsBatchOutcome | undefined> {
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            try {
                const outcome = await this.sink.commitBatch(batch)
                this.health.recordSuccess(this.now())
                return outcome
            } catch (error) {
                const message = error instanceof Error ? error.message : "metrics write failed"
                this.health.recordFailure(message)
                if (attempt === this.maxAttempts) break
                await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1))
            }
        }
        this.queue.countReceiverFailure(batch.length)
        return undefined
    }
}
