import { describe, expect, it } from "vitest"
import { RuntimeEventBus } from "../../runtime-event-bus"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../../types"
import { DiagnosisPipeline } from "../diagnosis-pipeline"
import { ANALYSIS_ATTRIBUTES, OUTCOME } from "../root-cause-analyzer"
import { RootCauseCategory } from "../root-cause-types"

/**
 * The pipeline is the seam that makes the analyzer reachable at runtime. What
 * matters here is not the classification itself — the analyzer has its own
 * scenario matrix — but *when* classification runs, since running it on every
 * event would put rule evaluation on the hot path this subsystem exists to
 * keep clear.
 */

/** Records through a real bus so events carry real sequence numbers. */
function record(
    bus: RuntimeEventBus,
    name: string,
    attributes: Record<string, unknown>,
    priority = RuntimeEventPriority.Performance,
): RuntimeTelemetryEvent {
    const event = bus.record({ name, priority, attributes })
    if (!event) throw new Error(`bus refused to record ${name}`)
    return event
}

describe("DiagnosisPipeline", () => {
    it("stays silent for healthy events", () => {
        const bus = new RuntimeEventBus()
        const seen: string[] = []
        const pipeline = new DiagnosisPipeline({ onDiagnosis: (d) => seen.push(d.incidentId) })

        for (let i = 0; i < 20; i++) {
            pipeline.observe(
                record(bus, "provider.request", {
                    [ANALYSIS_ATTRIBUTES.component]: "provider",
                    [ANALYSIS_ATTRIBUTES.operation]: "chat",
                    [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.success,
                    [ANALYSIS_ATTRIBUTES.durationMs]: 120,
                }),
            )
        }

        expect(seen).toHaveLength(0)
    })

    it("classifies a reported failure using the events that preceded it", () => {
        const bus = new RuntimeEventBus()
        const seen: Array<{ category: RootCauseCategory; evidence: readonly string[] }> = []
        const pipeline = new DiagnosisPipeline({
            onDiagnosis: (d) => seen.push({ category: d.category, evidence: d.evidenceEventIds }),
        })

        const success = record(bus, "provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "chat",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.success,
        })
        pipeline.observe(success)

        const failure = record(bus, "provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "chat",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
            [ANALYSIS_ATTRIBUTES.statusCode]: 429,
        })
        const diagnosis = pipeline.observe(failure)

        expect(seen).toHaveLength(1)
        expect(diagnosis?.category).toBe(RootCauseCategory.ProviderRateLimit)
        // The prior success is what separates "this dependency broke" from
        // "this dependency never worked", so it must be cited.
        expect(diagnosis?.evidenceEventIds).toContain(success.eventId)
    })

    it("treats a sampler budget breach as a failure signal", () => {
        const bus = new RuntimeEventBus()
        const seen: RootCauseCategory[] = []
        const pipeline = new DiagnosisPipeline({ onDiagnosis: (d) => seen.push(d.category) })

        // A saturated event loop produces no failed operation — only degraded
        // timings — so the breach event is the only entry point to analysis.
        pipeline.observe(
            record(bus, "eventLoopDelay.breach", {
                [ANALYSIS_ATTRIBUTES.component]: "runtime",
                [ANALYSIS_ATTRIBUTES.operation]: "sample",
                [ANALYSIS_ATTRIBUTES.eventLoopDelayMs]: 450,
            }),
        )

        expect(seen).toHaveLength(1)
    })

    it("does not re-analyze the event a diagnosis itself produces", () => {
        const bus = new RuntimeEventBus()
        let count = 0
        const pipeline = new DiagnosisPipeline({ onDiagnosis: () => count++ })

        pipeline.observe(
            record(bus, "provider.request", {
                [ANALYSIS_ATTRIBUTES.component]: "provider",
                [ANALYSIS_ATTRIBUTES.operation]: "chat",
                [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
            }),
        )
        expect(count).toBe(1)

        // Activation records this event after each diagnosis. It must not look
        // like a failure, or the pipeline would feed itself.
        pipeline.observe(
            record(
                bus,
                "runtime.diagnosis",
                {
                    [ANALYSIS_ATTRIBUTES.component]: "runtime",
                    [ANALYSIS_ATTRIBUTES.operation]: "diagnose",
                    category: RootCauseCategory.Unknown,
                },
                RuntimeEventPriority.Info,
            ),
        )
        expect(count).toBe(1)
    })

    it("separates concurrent tasks so one panel's failure is not explained by another's events", () => {
        const bus = new RuntimeEventBus()
        const seen: Array<readonly string[]> = []
        const pipeline = new DiagnosisPipeline({ onDiagnosis: (d) => seen.push(d.evidenceEventIds) })

        const otherTask = bus.record({
            name: "provider.request",
            priority: RuntimeEventPriority.Performance,
            attributes: {
                [ANALYSIS_ATTRIBUTES.component]: "provider",
                [ANALYSIS_ATTRIBUTES.operation]: "chat",
                [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.success,
            },
            context: { taskId: "task-b" },
        })
        if (!otherTask) throw new Error("bus refused the other task's event")
        pipeline.observe(otherTask)

        const failure = bus.record({
            name: "provider.request",
            priority: RuntimeEventPriority.Performance,
            attributes: {
                [ANALYSIS_ATTRIBUTES.component]: "provider",
                [ANALYSIS_ATTRIBUTES.operation]: "chat",
                [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
                [ANALYSIS_ATTRIBUTES.statusCode]: 401,
            },
            context: { taskId: "task-a" },
        })
        if (!failure) throw new Error("bus refused the failing event")
        pipeline.observe(failure)

        expect(seen).toHaveLength(1)
        expect(seen[0]).not.toContain(otherTask.eventId)
    })

    it("forgets history on reset", () => {
        const bus = new RuntimeEventBus()
        const seen: Array<readonly string[]> = []
        const pipeline = new DiagnosisPipeline({ onDiagnosis: (d) => seen.push(d.evidenceEventIds) })

        const success = record(bus, "provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "chat",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.success,
        })
        pipeline.observe(success)
        pipeline.reset()

        pipeline.observe(
            record(bus, "provider.request", {
                [ANALYSIS_ATTRIBUTES.component]: "provider",
                [ANALYSIS_ATTRIBUTES.operation]: "chat",
                [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
                [ANALYSIS_ATTRIBUTES.statusCode]: 401,
            }),
        )

        expect(seen).toHaveLength(1)
        expect(seen[0]).not.toContain(success.eventId)
    })
})
