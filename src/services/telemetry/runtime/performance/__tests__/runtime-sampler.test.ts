import { afterEach, describe, expect, it, vi } from "vitest"
import {
    RUNTIME_METRICS,
    RuntimeSampler,
    type RuntimeSamplerClock,
    type RuntimeSnapshot,
    resolveProcessSamplerSlot,
    SamplerSlot,
} from "../runtime-sampler"
import { AnomalySeverity, ThresholdPolicy } from "../threshold-policy"

/**
 * Drivable stand-in for process timing and resource usage.
 *
 * The sampler's whole job is turning elapsed time into verdicts, so the tests
 * advance time explicitly instead of sleeping.
 */
class FakeClock implements RuntimeSamplerClock {
    private nowMs = 0
    private cpuMicros = 0
    private heapUsed = 10_000_000
    private rss = 50_000_000

    advance(ms: number, options: { cpuMicros?: number; heapDelta?: number } = {}): void {
        this.nowMs += ms
        this.cpuMicros += options.cpuMicros ?? 0
        this.heapUsed += options.heapDelta ?? 0
    }

    monotonicMs(): number {
        return this.nowMs
    }

    cpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage {
        const absolute: NodeJS.CpuUsage = { user: this.cpuMicros, system: 0 }
        if (!previous) {
            return absolute
        }
        return { user: absolute.user - previous.user, system: absolute.system - previous.system }
    }

    memoryUsage(): { heapUsed: number; rss: number } {
        return { heapUsed: this.heapUsed, rss: this.rss }
    }
}

function makeSampler(
    clock: FakeClock,
    overrides: Partial<ConstructorParameters<typeof RuntimeSampler>[0]> = {},
): { sampler: RuntimeSampler; snapshots: RuntimeSnapshot[] } {
    const snapshots: RuntimeSnapshot[] = []
    const sampler = new RuntimeSampler({
        policy: new ThresholdPolicy({ budgets: {} }),
        intervalMs: 1_000,
        clock,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        ...overrides,
    })
    return { sampler, snapshots }
}

afterEach(() => {
    vi.useRealTimers()
})

describe("RuntimeSampler", () => {
    it("reports zero event-loop delay when the interval is honoured", () => {
        const clock = new FakeClock()
        const { sampler } = makeSampler(clock)
        sampler.start()

        clock.advance(1_000)
        const snapshot = sampler.sample()

        expect(snapshot.eventLoopDelayMs).toBe(0)
    })

    it("attributes the overshoot beyond the interval to event-loop delay", () => {
        const clock = new FakeClock()
        const { sampler } = makeSampler(clock)
        sampler.start()

        clock.advance(3_200)
        const snapshot = sampler.sample()

        expect(snapshot.eventLoopDelayMs).toBe(2_200)
    })

    it("expresses CPU usage as a fraction of one core", () => {
        const clock = new FakeClock()
        const { sampler } = makeSampler(clock)
        sampler.start()

        // 800 ms of CPU time across a 1000 ms interval.
        clock.advance(1_000, { cpuMicros: 800_000 })
        const snapshot = sampler.sample()

        expect(snapshot.cpuUtilizationRatio).toBeCloseTo(0.8, 5)
    })

    it("measures heap growth against the oldest mark inside the window", () => {
        const clock = new FakeClock()
        const { sampler } = makeSampler(clock, { heapWindowMs: 10_000 })
        sampler.start()

        clock.advance(1_000, { heapDelta: 5_000_000 })
        sampler.sample()
        clock.advance(1_000, { heapDelta: 5_000_000 })
        const snapshot = sampler.sample()

        expect(snapshot.heapGrowthBytes).toBe(10_000_000)
    })

    it("drops heap marks older than the window so a settled heap reports no growth", () => {
        const clock = new FakeClock()
        const { sampler } = makeSampler(clock, { heapWindowMs: 3_000 })
        sampler.start()

        clock.advance(1_000, { heapDelta: 20_000_000 })
        sampler.sample()
        for (let i = 0; i < 6; i++) {
            clock.advance(1_000)
            sampler.sample()
        }
        const settled = sampler.sample()

        expect(settled.heapGrowthBytes).toBe(0)
    })

    it("raises a critical anomaly when the loop stalls past the budget", () => {
        const clock = new FakeClock()
        const verdicts: Array<{ metric?: string; severity?: AnomalySeverity }> = []
        const { sampler } = makeSampler(clock, {
            policy: new ThresholdPolicy({
                budgets: { [RUNTIME_METRICS.eventLoopDelayMs]: { warning: 200, critical: 1_000 } },
            }),
            onVerdict: (verdict) => verdicts.push({ metric: verdict.anomaly?.metric, severity: verdict.anomaly?.severity }),
        })
        sampler.start()

        clock.advance(4_000)
        sampler.sample()

        expect(verdicts).toContainEqual({
            metric: RUNTIME_METRICS.eventLoopDelayMs,
            severity: AnomalySeverity.Critical,
        })
    })

    it("stays silent while the host is healthy", () => {
        const clock = new FakeClock()
        const verdicts: unknown[] = []
        const { sampler } = makeSampler(clock, {
            policy: new ThresholdPolicy({
                budgets: { [RUNTIME_METRICS.eventLoopDelayMs]: { warning: 200, critical: 1_000 } },
            }),
            onVerdict: (verdict) => verdicts.push(verdict),
        })
        sampler.start()

        for (let i = 0; i < 5; i++) {
            clock.advance(1_010)
            sampler.sample()
        }

        expect(verdicts).toHaveLength(0)
    })

    it("uses an unref'd timer so it cannot keep the host alive", () => {
        vi.useFakeTimers()
        const unref = vi.fn()
        const setIntervalSpy = vi
            .spyOn(globalThis, "setInterval")
            .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)

        const { sampler } = makeSampler(new FakeClock())
        sampler.start()

        expect(setIntervalSpy).toHaveBeenCalledOnce()
        expect(unref).toHaveBeenCalledOnce()
        setIntervalSpy.mockRestore()
    })

    it("ignores a second start and tolerates repeated dispose", () => {
        vi.useFakeTimers()
        const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
        const { sampler } = makeSampler(new FakeClock())

        sampler.start()
        sampler.start()
        expect(setIntervalSpy).toHaveBeenCalledOnce()
        expect(sampler.isRunning).toBe(true)

        sampler.dispose()
        sampler.dispose()
        expect(sampler.isRunning).toBe(false)
        setIntervalSpy.mockRestore()
    })

    it("keeps baselines warm even without a verdict listener", () => {
        const clock = new FakeClock()
        const policy = new ThresholdPolicy({ budgets: {} })
        const observe = vi.spyOn(policy, "observe")
        const { sampler } = makeSampler(clock, { policy, onVerdict: undefined })
        sampler.start()

        clock.advance(1_000)
        sampler.sample()

        expect(observe).toHaveBeenCalledTimes(3)
    })
})

describe("SamplerSlot", () => {
    const INTERVAL_MS = 1_000

    /** A sampler on a shared slot and clock that records the metrics it reports as breached. */
    function slotSampler(
        clock: FakeClock,
        slot: SamplerSlot,
    ): { sampler: RuntimeSampler; reported: string[]; publishedSnapshots: RuntimeSnapshot[] } {
        const reported: string[] = []
        const publishedSnapshots: RuntimeSnapshot[] = []
        const { sampler } = makeSampler(clock, {
            slot,
            onPublishedSnapshot: (snapshot) => publishedSnapshots.push(snapshot),
            policy: new ThresholdPolicy({
                budgets: { [RUNTIME_METRICS.eventLoopDelayMs]: { warning: 200, critical: 1_000 } },
            }),
            onVerdict: (verdict) => {
                if (verdict.anomaly) reported.push(verdict.anomaly.metric)
            },
        })
        sampler.start()
        return { sampler, reported, publishedSnapshots }
    }

    it("reuses a structurally compatible slot from a process-global registry", () => {
        const registry = {}
        const first = resolveProcessSamplerSlot(registry)
        const second = resolveProcessSamplerSlot(registry)

        expect(second).toBe(first)
    })

    it("lets only the first sampler to sample report a breach both samplers see", () => {
        const clock = new FakeClock()
        const slot = new SamplerSlot()
        const first = slotSampler(clock, slot)
        const second = slotSampler(clock, slot)

        clock.advance(4_000)
        first.sampler.sample()
        second.sampler.sample()

        expect(first.reported).toEqual([RUNTIME_METRICS.eventLoopDelayMs])
        expect(first.publishedSnapshots).toHaveLength(1)
        expect(second.reported).toEqual([])
        expect(second.publishedSnapshots).toHaveLength(0)
    })

    it("hands the slot over at once when the holder is disposed", () => {
        const clock = new FakeClock()
        const slot = new SamplerSlot()
        const holder = slotSampler(clock, slot)
        const waiting = slotSampler(clock, slot)
        clock.advance(INTERVAL_MS)
        holder.sampler.sample()
        waiting.sampler.sample()

        holder.sampler.dispose()
        clock.advance(4_000)
        waiting.sampler.sample()

        expect(waiting.reported).toEqual([RUNTIME_METRICS.eventLoopDelayMs])
    })

    it("lets another sampler take over once the holder misses two intervals", () => {
        const clock = new FakeClock()
        const slot = new SamplerSlot()
        const holder = slotSampler(clock, slot)
        const waiting = slotSampler(clock, slot)
        clock.advance(INTERVAL_MS)
        holder.sampler.sample()
        waiting.sampler.sample()

        // The holder stops sampling without being disposed.
        clock.advance(3_000)
        waiting.sampler.sample()

        expect(waiting.reported).toEqual([RUNTIME_METRICS.eventLoopDelayMs])
        expect(holder.reported).toEqual([])
    })

    it("keeps the slot with a holder that samples within two intervals", () => {
        const slot = new SamplerSlot()
        const holder = {}
        const other = {}

        expect(slot.claim(holder, 0, INTERVAL_MS)).toBe(true)
        expect(slot.claim(other, 2 * INTERVAL_MS, INTERVAL_MS)).toBe(false)
        expect(slot.claim(holder, 2 * INTERVAL_MS, INTERVAL_MS)).toBe(true)
        expect(slot.claim(other, 4 * INTERVAL_MS, INTERVAL_MS)).toBe(false)
        expect(slot.claim(other, 4 * INTERVAL_MS + 1, INTERVAL_MS)).toBe(true)
        expect(slot.claim(holder, 4 * INTERVAL_MS + 2, INTERVAL_MS)).toBe(false)
    })

    it("ignores a release by a sampler that does not hold the slot", () => {
        const slot = new SamplerSlot()
        const holder = {}
        const other = {}
        slot.claim(holder, 0, INTERVAL_MS)

        slot.release(other)
        expect(slot.claim(other, 1, INTERVAL_MS)).toBe(false)

        slot.release(holder)
        expect(slot.claim(other, 2, INTERVAL_MS)).toBe(true)
    })
})
