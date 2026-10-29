import { describe, expect, it } from "vitest"
import { AnomalySeverity, BreachKind, DEFAULT_METRIC_BUDGETS, type MetricSample, ThresholdPolicy } from "../threshold-policy"

function sample(overrides: Partial<MetricSample> & Pick<MetricSample, "value" | "monotonicMs">): MetricSample {
    return { metric: "runtime.event_loop_delay_ms", ...overrides }
}

/** Feeds `count` identical healthy samples, returning the next monotonic time. */
function warmUp(policy: ThresholdPolicy, metric: string, value: number, count: number, startMs = 0): number {
    let monotonicMs = startMs
    for (let i = 0; i < count; i++) {
        policy.observe({ metric, value, monotonicMs })
        monotonicMs += 1_000
    }
    return monotonicMs
}

describe("ThresholdPolicy", () => {
    it("requires consecutive warning breaches before reporting", () => {
        const policy = new ThresholdPolicy({ budgets: { "test.metric": { warning: 100 } } })

        const first = policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 0 }))
        const second = policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 1_000 }))
        const third = policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 2_000 }))

        expect(first.anomaly).toBeUndefined()
        expect(second.anomaly).toBeUndefined()
        expect(third.anomaly?.severity).toBe(AnomalySeverity.Warning)
        expect(third.anomaly?.kind).toBe(BreachKind.FixedBudget)
        expect(third.anomaly?.limit).toBe(100)
        expect(third.anomaly?.consecutiveBreaches).toBe(3)
    })

    it("reports a critical breach on the first sample", () => {
        const policy = new ThresholdPolicy({ budgets: { "test.metric": { warning: 100, critical: 1_000 } } })

        const verdict = policy.observe(sample({ metric: "test.metric", value: 2_000, monotonicMs: 0 }))

        expect(verdict.anomaly?.severity).toBe(AnomalySeverity.Critical)
        expect(verdict.anomaly?.consecutiveBreaches).toBe(1)
    })

    it("resets the consecutive counter when a healthy sample arrives", () => {
        const policy = new ThresholdPolicy({ budgets: { "test.metric": { warning: 100 } } })

        policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 0 }))
        policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 1_000 }))
        policy.observe(sample({ metric: "test.metric", value: 10, monotonicMs: 2_000 }))
        const afterReset = policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 3_000 }))

        expect(afterReset.anomaly).toBeUndefined()
    })

    it("folds repeated breaches into one incident inside the dedup window", () => {
        const policy = new ThresholdPolicy({
            budgets: { "test.metric": { warning: 100, critical: 1_000 } },
            incidentWindowMs: 30_000,
        })

        const opened = policy.observe(sample({ metric: "test.metric", value: 5_000, monotonicMs: 0 }))
        const repeated = policy.observe(sample({ metric: "test.metric", value: 5_000, monotonicMs: 10_000 }))

        expect(opened.anomaly).toBeDefined()
        expect(repeated.anomaly).toBeUndefined()
        expect(repeated.suppressed).toBe(true)
    })

    it("escalates an open warning incident when severity reaches critical", () => {
        const policy = new ThresholdPolicy({ budgets: { "test.metric": { warning: 100, critical: 1_000 } } })

        policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 0 }))
        policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 1_000 }))
        const warning = policy.observe(sample({ metric: "test.metric", value: 150, monotonicMs: 2_000 }))
        const escalation = policy.observe(sample({ metric: "test.metric", value: 5_000, monotonicMs: 3_000 }))

        expect(warning.anomaly?.severity).toBe(AnomalySeverity.Warning)
        expect(escalation.anomaly?.severity).toBe(AnomalySeverity.Critical)
        expect(escalation.anomaly?.incidentId).toBe(warning.anomaly?.incidentId)
    })

    it("closes an incident only after sustained healthy samples", () => {
        const policy = new ThresholdPolicy({
            budgets: { "test.metric": { warning: 100, critical: 1_000 } },
            recoverySamples: 3,
        })

        const opened = policy.observe(sample({ metric: "test.metric", value: 5_000, monotonicMs: 0 }))
        expect(policy.observe(sample({ metric: "test.metric", value: 10, monotonicMs: 1_000 })).recovery).toBeUndefined()
        expect(policy.observe(sample({ metric: "test.metric", value: 10, monotonicMs: 2_000 })).recovery).toBeUndefined()
        const recovered = policy.observe(sample({ metric: "test.metric", value: 10, monotonicMs: 3_000 }))

        expect(recovered.recovery?.incidentId).toBe(opened.anomaly?.incidentId)
        expect(recovered.recovery?.durationMs).toBe(3_000)
    })

    it("keeps incidents separate per scope so one task does not mask another", () => {
        const policy = new ThresholdPolicy({ budgets: { "test.metric": { warning: 100, critical: 1_000 } } })

        const taskA = policy.observe({ metric: "test.metric", value: 5_000, monotonicMs: 0, scopeKey: "task-a" })
        const taskB = policy.observe({ metric: "test.metric", value: 5_000, monotonicMs: 100, scopeKey: "task-b" })

        expect(taskA.anomaly).toBeDefined()
        expect(taskB.anomaly).toBeDefined()
        expect(taskA.anomaly?.incidentId).not.toBe(taskB.anomaly?.incidentId)
    })

    it("names incidents by lifecycle so counters from different sessions cannot collide", () => {
        const first = new ThresholdPolicy({
            budgets: { "test.metric": { warning: 100, critical: 1_000 } },
            incidentNamespace: "session-a",
        })
        const second = new ThresholdPolicy({
            budgets: { "test.metric": { warning: 100, critical: 1_000 } },
            incidentNamespace: "session-b",
        })

        const firstIncident = first.observe(sample({ metric: "test.metric", value: 5_000, monotonicMs: 0 })).anomaly
        const secondIncident = second.observe(sample({ metric: "test.metric", value: 5_000, monotonicMs: 0 })).anomaly

        expect(firstIncident?.incidentId).toBe("session-a:incident-1")
        expect(secondIncident?.incidentId).toBe("session-b:incident-1")
    })

    it("flags a regression against the dynamic baseline when no fixed budget applies", () => {
        const policy = new ThresholdPolicy({ budgets: {}, baselineSigma: 3 })

        let monotonicMs = 0
        for (let i = 0; i < 30; i++) {
            // Varying values keep MAD above zero so a baseline can form.
            policy.observe({ metric: "unbudgeted.metric", value: 10 + (i % 5), monotonicMs })
            monotonicMs += 1_000
        }

        let anomaly: ReturnType<ThresholdPolicy["observe"]>["anomaly"]
        for (let i = 0; i < 3; i++) {
            anomaly = policy.observe({ metric: "unbudgeted.metric", value: 500, monotonicMs }).anomaly ?? anomaly
            monotonicMs += 1_000
        }

        expect(anomaly?.kind).toBe(BreachKind.DynamicBaseline)
        expect(anomaly?.baseline).toBeGreaterThan(0)
    })

    it("does not use a baseline before enough samples exist", () => {
        const policy = new ThresholdPolicy({ budgets: {}, baselineSigma: 1 })

        let anomaly: ReturnType<ThresholdPolicy["observe"]>["anomaly"]
        let monotonicMs = 0
        for (let i = 0; i < 6; i++) {
            policy.observe({ metric: "unbudgeted.metric", value: 10 + i, monotonicMs })
            monotonicMs += 1_000
        }
        for (let i = 0; i < 3; i++) {
            anomaly = policy.observe({ metric: "unbudgeted.metric", value: 900, monotonicMs }).anomaly ?? anomaly
            monotonicMs += 1_000
        }

        expect(anomaly).toBeUndefined()
    })

    it("falls back to the fixed budget when the window has zero spread", () => {
        const policy = new ThresholdPolicy({ budgets: {}, baselineSigma: 1 })

        const monotonicMs = warmUp(policy, "flat.metric", 10, 30)

        // Every sample is identical, so MAD is zero. Without the guard this would
        // treat any value above 10 as infinitely deviant.
        const verdict = policy.observe({ metric: "flat.metric", value: 11, monotonicMs })

        expect(verdict.anomaly).toBeUndefined()
    })

    it("stops reporting after the baseline absorbs a stable slowdown", () => {
        const policy = new ThresholdPolicy({ budgets: {}, baselineSigma: 3, windowSize: 20 })

        let monotonicMs = warmUp(policy, "shifting.metric", 10, 20)
        for (let i = 0; i < 40; i++) {
            policy.observe({ metric: "shifting.metric", value: 500 + (i % 4), monotonicMs })
            monotonicMs += 1_000
        }

        const settled = policy.observe({ metric: "shifting.metric", value: 501, monotonicMs })

        expect(settled.anomaly).toBeUndefined()
    })

    it("publishes the documented WS-017 budgets", () => {
        expect(DEFAULT_METRIC_BUDGETS["runtime.event_loop_delay_ms"]).toEqual({ warning: 200, critical: 1000 })
        expect(DEFAULT_METRIC_BUDGETS["state.build_duration_ms"]?.warning).toBe(100)
        expect(DEFAULT_METRIC_BUDGETS["persistence.journal_append_ms"]?.warning).toBe(25)
        expect(DEFAULT_METRIC_BUDGETS["telemetry.queue_occupancy_ratio"]?.warning).toBe(0.75)
    })
})
