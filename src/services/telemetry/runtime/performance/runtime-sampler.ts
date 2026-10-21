/**
 * Periodically measures how healthy the extension host is.
 *
 * The metrics answer one question the user actually asks: "why is this slow?"
 * Event-loop delay shows whether the host is blocked, CPU utilization shows
 * whether it is busy, and heap growth shows whether it is leaking. A stall and
 * a leak look identical in a log; they look different here.
 *
 * The sampler must never be the reason a process stays alive or a test hangs,
 * so its timer is unref'd and `dispose` is idempotent.
 */

import type { MetricSample, PolicyVerdict, ThresholdPolicy } from "./threshold-policy"

/** Metric names emitted by this sampler. Kept in one place so budgets can match. */
export const RUNTIME_METRICS = {
    eventLoopDelayMs: "runtime.event_loop_delay_ms",
    cpuUtilizationRatio: "runtime.cpu_utilization_ratio",
    heapGrowthBytes: "runtime.heap_growth_bytes",
    rssBytes: "runtime.rss_bytes",
} as const

const DEFAULT_SAMPLE_INTERVAL_MS = 5_000

/** Window over which heap growth is measured, per the WS-017 contract. */
const DEFAULT_HEAP_WINDOW_MS = 60_000

/** One reading of process health. */
export interface RuntimeSnapshot {
    readonly monotonicMs: number
    /** Milliseconds the loop was late relative to the scheduled interval. */
    readonly eventLoopDelayMs: number
    /** Process CPU time over the interval, as a fraction of one core. */
    readonly cpuUtilizationRatio: number
    readonly heapUsedBytes: number
    readonly rssBytes: number
    /** Heap growth over the trailing heap window; zero before the window fills. */
    readonly heapGrowthBytes: number
}

/**
 * Process facilities the sampler depends on.
 *
 * Injected rather than imported so tests can drive time and resource usage
 * deterministically instead of sleeping and hoping.
 */
export interface RuntimeSamplerClock {
    monotonicMs(): number
    cpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage
    memoryUsage(): { heapUsed: number; rss: number }
}

const defaultClock: RuntimeSamplerClock = {
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
    cpuUsage: (previous) => process.cpuUsage(previous),
    memoryUsage: () => {
        const usage = process.memoryUsage()
        return { heapUsed: usage.heapUsed, rss: usage.rss }
    },
}

/** Missed intervals after which a slot holder counts as gone. */
const SLOT_STALE_INTERVALS = 2

/**
 * Elects the one sampler that reports breaches for a process.
 *
 * Every sampler in a process measures the same process, so two running
 * samplers would report each breach twice. The first sampler to sample holds
 * the slot; the others keep sampling for their own snapshots and baselines but
 * publish no verdicts. A holder that has not sampled for two of its intervals,
 * because it stalled or was dropped without being disposed, loses the slot to
 * the next sampler that samples. Breaches from before a takeover are not
 * replayed. Holders must share one monotonic clock.
 */
export class SamplerSlot {
    private holder: object | undefined
    private heartbeatMs = 0
    private staleAfterMs = 0

    /** Claim or renew the slot at `nowMs`; true when `holder` holds it afterwards. */
    claim(holder: object, nowMs: number, intervalMs: number): boolean {
        const free = this.holder === undefined || nowMs - this.heartbeatMs > this.staleAfterMs
        if (this.holder !== holder && !free) return false
        this.holder = holder
        this.heartbeatMs = nowMs
        this.staleAfterMs = SLOT_STALE_INTERVALS * intervalMs
        return true
    }

    /** Give the slot up, so the next sampler to sample takes it at once. */
    release(holder: object): void {
        if (this.holder === holder) this.holder = undefined
    }
}

/** The slot shared by every sampler in this extension host process. */
export const PROCESS_SAMPLER_SLOT = new SamplerSlot()

export interface RuntimeSamplerOptions {
    readonly policy: ThresholdPolicy
    readonly intervalMs?: number
    readonly heapWindowMs?: number
    readonly clock?: RuntimeSamplerClock
    /** When set, verdicts are published only while this sampler holds the slot. */
    readonly slot?: SamplerSlot
    /** Receives every snapshot, whether healthy or not. */
    readonly onSnapshot?: (snapshot: RuntimeSnapshot) => void
    /** Receives only verdicts that opened, escalated, or closed an incident. */
    readonly onVerdict?: (verdict: PolicyVerdict, snapshot: RuntimeSnapshot) => void
}

interface HeapMark {
    readonly monotonicMs: number
    readonly heapUsedBytes: number
}

export class RuntimeSampler {
    private readonly policy: ThresholdPolicy
    private readonly intervalMs: number
    private readonly heapWindowMs: number
    private readonly clock: RuntimeSamplerClock
    private readonly slot?: SamplerSlot
    private readonly onSnapshot?: (snapshot: RuntimeSnapshot) => void
    private readonly onVerdict?: (verdict: PolicyVerdict, snapshot: RuntimeSnapshot) => void

    private timer?: ReturnType<typeof setInterval>
    private lastCpuUsage?: NodeJS.CpuUsage
    private lastSampleAtMs?: number
    private readonly heapMarks: HeapMark[] = []

    constructor(options: RuntimeSamplerOptions) {
        this.policy = options.policy
        this.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
        this.heapWindowMs = options.heapWindowMs ?? DEFAULT_HEAP_WINDOW_MS
        this.clock = options.clock ?? defaultClock
        this.slot = options.slot
        this.onSnapshot = options.onSnapshot
        this.onVerdict = options.onVerdict
    }

    get isRunning(): boolean {
        return this.timer !== undefined
    }

    start(): void {
        if (this.timer) {
            return
        }
        const startedAtMs = this.clock.monotonicMs()
        this.lastCpuUsage = this.clock.cpuUsage()
        this.lastSampleAtMs = startedAtMs
        // Anchor the heap window at start. Without this mark the first interval's
        // allocations fall outside the window and a leak is under-reported by one
        // sample until the window fills.
        this.heapMarks.push({ monotonicMs: startedAtMs, heapUsedBytes: this.clock.memoryUsage().heapUsed })

        const timer = setInterval(() => this.sample(), this.intervalMs)
        // Without unref a running sampler would keep the host process alive.
        timer.unref?.()
        this.timer = timer
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = undefined
        }
        this.lastCpuUsage = undefined
        this.lastSampleAtMs = undefined
        this.heapMarks.length = 0
        this.slot?.release(this)
    }

    /**
     * Takes one reading and feeds it to the policy.
     *
     * Public so a caller can sample on demand — for example right after a slow
     * operation — without waiting for the next tick.
     */
    sample(): RuntimeSnapshot {
        const monotonicMs = this.clock.monotonicMs()
        const elapsedMs = this.lastSampleAtMs === undefined ? this.intervalMs : monotonicMs - this.lastSampleAtMs

        // A timer that fires late is the clearest signal the loop was blocked:
        // the excess beyond the requested interval is time we could not run.
        const eventLoopDelayMs = Math.max(0, elapsedMs - this.intervalMs)

        // `cpuUsage(previous)` returns the delta since `previous`, so the absolute
        // reading must be captured separately to anchor the next interval.
        const cpuDelta = this.clock.cpuUsage(this.lastCpuUsage)
        const cpuMicros = cpuDelta.user + cpuDelta.system
        const cpuUtilizationRatio = elapsedMs > 0 ? cpuMicros / 1_000 / elapsedMs : 0

        const memory = this.clock.memoryUsage()
        const heapGrowthBytes = this.trackHeap(monotonicMs, memory.heapUsed)

        this.lastCpuUsage = this.clock.cpuUsage()
        this.lastSampleAtMs = monotonicMs

        const snapshot: RuntimeSnapshot = {
            monotonicMs,
            eventLoopDelayMs,
            cpuUtilizationRatio,
            heapUsedBytes: memory.heapUsed,
            rssBytes: memory.rss,
            heapGrowthBytes,
        }

        this.onSnapshot?.(snapshot)
        const reportsVerdicts = this.slot?.claim(this, monotonicMs, this.intervalMs) ?? true
        this.publish(snapshot, reportsVerdicts)
        return snapshot
    }

    private publish(snapshot: RuntimeSnapshot, reportsVerdicts: boolean): void {
        if (!this.onVerdict || !reportsVerdicts) {
            // Still feed the policy so baselines stay warm for later consumers.
            for (const sample of this.toSamples(snapshot)) {
                this.policy.observe(sample)
            }
            return
        }
        for (const sample of this.toSamples(snapshot)) {
            const verdict = this.policy.observe(sample)
            if (verdict.anomaly || verdict.recovery) {
                this.onVerdict(verdict, snapshot)
            }
        }
    }

    private toSamples(snapshot: RuntimeSnapshot): MetricSample[] {
        return [
            {
                metric: RUNTIME_METRICS.eventLoopDelayMs,
                value: snapshot.eventLoopDelayMs,
                monotonicMs: snapshot.monotonicMs,
            },
            {
                metric: RUNTIME_METRICS.cpuUtilizationRatio,
                value: snapshot.cpuUtilizationRatio,
                monotonicMs: snapshot.monotonicMs,
            },
            {
                metric: RUNTIME_METRICS.heapGrowthBytes,
                value: snapshot.heapGrowthBytes,
                monotonicMs: snapshot.monotonicMs,
            },
        ]
    }

    /**
     * Returns heap growth across the trailing window.
     *
     * Growth is measured against the oldest mark still inside the window rather
     * than against the previous sample, because a leak is a slow trend that any
     * single interval would round away.
     */
    private trackHeap(monotonicMs: number, heapUsedBytes: number): number {
        this.heapMarks.push({ monotonicMs, heapUsedBytes })
        const cutoff = monotonicMs - this.heapWindowMs
        while (this.heapMarks.length > 1 && (this.heapMarks[0] as HeapMark).monotonicMs < cutoff) {
            this.heapMarks.shift()
        }
        const oldest = this.heapMarks[0] as HeapMark
        return Math.max(0, heapUsedBytes - oldest.heapUsedBytes)
    }
}
