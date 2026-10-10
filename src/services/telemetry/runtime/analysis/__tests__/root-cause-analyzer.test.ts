import { describe, expect, it } from "vitest"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../../types"
import { IncidentCorrelator } from "../incident-correlator"
import { ANALYSIS_ATTRIBUTES, OUTCOME, RootCauseAnalyzer } from "../root-cause-analyzer"
import { DiagnosisConfidence, type Incident, MissingEvidence, RootCauseCategory } from "../root-cause-types"

let nextSequence = 0

function event(
    name: string,
    attributes: Record<string, string | number | boolean>,
    overrides: Partial<RuntimeTelemetryEvent> = {},
): RuntimeTelemetryEvent {
    nextSequence += 1
    return {
        eventId: `evt-${nextSequence}`,
        sequence: nextSequence,
        timestamp: 1_700_000_000_000 + nextSequence,
        monotonicMs: nextSequence * 100,
        name,
        priority: RuntimeEventPriority.Info,
        context: { sessionId: "session-1", taskId: "task-1" },
        attributes,
        ...overrides,
    }
}

function incident(failingEvent: RuntimeTelemetryEvent, preceding: RuntimeTelemetryEvent[] = []): Incident {
    return { incidentId: "rc-test", failingEvent, precedingEvents: preceding }
}

const analyzer = new RootCauseAnalyzer()

/** Health snapshot that proves our own loop was responsive. */
function healthyRuntime(): RuntimeTelemetryEvent {
    return event("runtime.sample", { [ANALYSIS_ATTRIBUTES.component]: "runtime", [ANALYSIS_ATTRIBUTES.eventLoopDelayMs]: 5 })
}

/** Health snapshot that proves our own loop was blocked. */
function blockedRuntime(): RuntimeTelemetryEvent {
    return event("runtime.sample", {
        [ANALYSIS_ATTRIBUTES.component]: "runtime",
        [ANALYSIS_ATTRIBUTES.eventLoopDelayMs]: 1_800,
    })
}

describe("RootCauseAnalyzer scenario matrix", () => {
    it("blames the upstream provider when our loop was idle", () => {
        const snapshot = healthyRuntime()
        const failing = event("provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "request",
            [ANALYSIS_ATTRIBUTES.durationMs]: 9_000,
            [ANALYSIS_ATTRIBUTES.upstreamTtfbMs]: 8_700,
            [ANALYSIS_ATTRIBUTES.localPrepareMs]: 12,
        })

        const diagnosis = analyzer.analyze(incident(failing, [snapshot]))

        expect(diagnosis.category).toBe(RootCauseCategory.ProviderUpstreamLatency)
        expect(diagnosis.confidence).toBe(DiagnosisConfidence.High)
        expect(diagnosis.evidenceEventIds).toEqual([failing.eventId, snapshot.eventId])
        expect(diagnosis.reproductionSteps.length).toBeGreaterThan(0)
    })

    it("blames our own event loop when local preparation was also slow", () => {
        const snapshot = blockedRuntime()
        const failing = event("provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "request",
            [ANALYSIS_ATTRIBUTES.localPrepareMs]: 1_400,
            [ANALYSIS_ATTRIBUTES.upstreamTtfbMs]: 200,
        })

        const diagnosis = analyzer.analyze(incident(failing, [snapshot]))

        expect(diagnosis.category).toBe(RootCauseCategory.RuntimeEventLoopBlocked)
        expect(diagnosis.evidenceEventIds).toContain(snapshot.eventId)
    })

    it("blames state serialization when build time scales with projection size", () => {
        const earlier = event("state.build", { [ANALYSIS_ATTRIBUTES.component]: "state", [ANALYSIS_ATTRIBUTES.buildMs]: 20 })
        const failing = event("state.build", {
            [ANALYSIS_ATTRIBUTES.component]: "state",
            [ANALYSIS_ATTRIBUTES.operation]: "build",
            [ANALYSIS_ATTRIBUTES.buildMs]: 480,
            [ANALYSIS_ATTRIBUTES.stateBytes]: 6_500_000,
        })

        const diagnosis = analyzer.analyze(incident(failing, [earlier]))

        expect(diagnosis.category).toBe(RootCauseCategory.StateProjectionSerialization)
        expect(diagnosis.evidenceEventIds).toHaveLength(2)
    })

    it("blames the webview when delivery was fast but rendering was not", () => {
        const delivery = event("state.deliver", {
            [ANALYSIS_ATTRIBUTES.component]: "grpc",
            [ANALYSIS_ATTRIBUTES.transportMs]: 8,
        })
        const failing = event("webview.apply", {
            [ANALYSIS_ATTRIBUTES.component]: "webview",
            [ANALYSIS_ATTRIBUTES.operation]: "apply",
            [ANALYSIS_ATTRIBUTES.transportMs]: 8,
            [ANALYSIS_ATTRIBUTES.renderMs]: 900,
        })

        const diagnosis = analyzer.analyze(incident(failing, [delivery]))

        expect(diagnosis.category).toBe(RootCauseCategory.WebviewRenderLatency)
    })

    it("blames disk backpressure when queue wait and append are both over budget", () => {
        const earlier = event("journal.append", {
            [ANALYSIS_ATTRIBUTES.component]: "persistence",
            [ANALYSIS_ATTRIBUTES.appendMs]: 3,
        })
        const failing = event("journal.append", {
            [ANALYSIS_ATTRIBUTES.component]: "persistence",
            [ANALYSIS_ATTRIBUTES.operation]: "append",
            [ANALYSIS_ATTRIBUTES.queueWaitMs]: 640,
            [ANALYSIS_ATTRIBUTES.appendMs]: 90,
        })

        const diagnosis = analyzer.analyze(incident(failing, [earlier]))

        expect(diagnosis.category).toBe(RootCauseCategory.PersistenceDiskBackpressure)
    })

    it("blames the MCP transport when a failed connect preceded the call", () => {
        const connect = event("mcp.connect", {
            [ANALYSIS_ATTRIBUTES.component]: "mcp",
            [ANALYSIS_ATTRIBUTES.operation]: "connect",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
        })
        const failing = event("mcp.call_tool", {
            [ANALYSIS_ATTRIBUTES.component]: "mcp",
            [ANALYSIS_ATTRIBUTES.operation]: "call_tool",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
            [ANALYSIS_ATTRIBUTES.durationMs]: 30,
        })

        const diagnosis = analyzer.analyze(incident(failing, [connect]))

        expect(diagnosis.category).toBe(RootCauseCategory.McpTransportLifecycle)
        expect(diagnosis.evidenceEventIds).toEqual([failing.eventId, connect.eventId])
    })

    it("blames the MCP tool when the connection was healthy", () => {
        const connect = event("mcp.connect", {
            [ANALYSIS_ATTRIBUTES.component]: "mcp",
            [ANALYSIS_ATTRIBUTES.operation]: "connect",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.success,
            [ANALYSIS_ATTRIBUTES.connectMs]: 40,
        })
        const failing = event("mcp.call_tool", {
            [ANALYSIS_ATTRIBUTES.component]: "mcp",
            [ANALYSIS_ATTRIBUTES.operation]: "call_tool",
            [ANALYSIS_ATTRIBUTES.durationMs]: 24_000,
        })

        const diagnosis = analyzer.analyze(incident(failing, [connect]))

        expect(diagnosis.category).toBe(RootCauseCategory.McpToolLatency)
    })

    it("blames output finalization when capture outlasts the command itself", () => {
        const earlier = event("terminal.execute", {
            [ANALYSIS_ATTRIBUTES.component]: "terminal",
            [ANALYSIS_ATTRIBUTES.captureMs]: 10,
        })
        const failing = event("terminal.execute", {
            [ANALYSIS_ATTRIBUTES.component]: "terminal",
            [ANALYSIS_ATTRIBUTES.operation]: "execute",
            [ANALYSIS_ATTRIBUTES.commandRuntimeMs]: 120,
            [ANALYSIS_ATTRIBUTES.captureMs]: 4_400,
        })

        const diagnosis = analyzer.analyze(incident(failing, [earlier]))

        expect(diagnosis.category).toBe(RootCauseCategory.TerminalOutputFinalization)
    })

    it("classifies rejected credentials as authentication", () => {
        const failing = event("provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "request",
            [ANALYSIS_ATTRIBUTES.statusCode]: 401,
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
        })

        const diagnosis = analyzer.analyze(incident(failing))

        expect(diagnosis.category).toBe(RootCauseCategory.ProviderAuthentication)
    })

    it("classifies throttling as rate limiting", () => {
        const failing = event("provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "request",
            [ANALYSIS_ATTRIBUTES.statusCode]: 429,
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
        })

        const diagnosis = analyzer.analyze(incident(failing))

        expect(diagnosis.category).toBe(RootCauseCategory.ProviderRateLimit)
    })

    it("classifies a failure after the stream started as a protocol problem", () => {
        const started = event("provider.stream", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.streamStarted]: true,
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.success,
        })
        const failing = event("provider.stream", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "stream",
            [ANALYSIS_ATTRIBUTES.streamStarted]: true,
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
        })

        const diagnosis = analyzer.analyze(incident(failing, [started]))

        expect(diagnosis.category).toBe(RootCauseCategory.ProviderStreamProtocol)
    })

    it("blames the task runtime when a rejected transition preceded the failure", () => {
        const rejected = event("task.transition", {
            [ANALYSIS_ATTRIBUTES.component]: "task",
            [ANALYSIS_ATTRIBUTES.operation]: "transition",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
        })
        const failing = event("task.effect", {
            [ANALYSIS_ATTRIBUTES.component]: "task",
            [ANALYSIS_ATTRIBUTES.operation]: "effect",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
            [ANALYSIS_ATTRIBUTES.durationMs]: 5,
        })

        const diagnosis = analyzer.analyze(incident(failing, [rejected]))

        expect(diagnosis.category).toBe(RootCauseCategory.TaskRuntimeInvariant)
    })

    it("keeps telemetry's own failures out of the product's diagnosis", () => {
        const earlier = event("telemetry.export", {
            [ANALYSIS_ATTRIBUTES.component]: "telemetry",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
        })
        const failing = event("telemetry.export", {
            [ANALYSIS_ATTRIBUTES.component]: "telemetry",
            [ANALYSIS_ATTRIBUTES.operation]: "export",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
            [ANALYSIS_ATTRIBUTES.durationMs]: 3_000,
        })

        const diagnosis = analyzer.analyze(incident(failing, [earlier]))

        expect(diagnosis.category).toBe(RootCauseCategory.TelemetryTransportUnhealthy)
    })

    it("reports unknown with the specific gaps rather than guessing", () => {
        const failing = event("mystery.failure", { [ANALYSIS_ATTRIBUTES.component]: "mystery" })

        const diagnosis = analyzer.analyze(incident(failing))

        expect(diagnosis.category).toBe(RootCauseCategory.Unknown)
        expect(diagnosis.confidence).toBe(DiagnosisConfidence.Low)
        expect(diagnosis.missingEvidence).toContain(MissingEvidence.RuntimeSnapshot)
        expect(diagnosis.missingEvidence).toContain(MissingEvidence.PhaseTimings)
        expect(diagnosis.missingEvidence).toContain(MissingEvidence.PriorSuccess)
    })

    it("lowers confidence when the competing explanation was not excluded", () => {
        const failing = event("provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "request",
            [ANALYSIS_ATTRIBUTES.upstreamTtfbMs]: 7_000,
            [ANALYSIS_ATTRIBUTES.localPrepareMs]: 10,
        })

        // No runtime snapshot, so a blocked loop cannot be ruled out.
        const diagnosis = analyzer.analyze(incident(failing))

        expect(diagnosis.category).toBe(RootCauseCategory.ProviderUpstreamLatency)
        expect(diagnosis.confidence).toBe(DiagnosisConfidence.Medium)
    })

    it("cites at least two events whenever a rule fires", () => {
        const snapshot = healthyRuntime()
        const failing = event("provider.request", {
            [ANALYSIS_ATTRIBUTES.component]: "provider",
            [ANALYSIS_ATTRIBUTES.operation]: "request",
            [ANALYSIS_ATTRIBUTES.upstreamTtfbMs]: 8_000,
            [ANALYSIS_ATTRIBUTES.localPrepareMs]: 5,
        })

        const diagnosis = analyzer.analyze(incident(failing, [snapshot]))

        expect(diagnosis.evidenceEventIds.length).toBeGreaterThanOrEqual(2)
    })
})

describe("IncidentCorrelator", () => {
    it("supplies the last success of the same operation as contrast", () => {
        const correlator = new IncidentCorrelator()
        const success = event("mcp.call_tool", {
            [ANALYSIS_ATTRIBUTES.component]: "mcp",
            [ANALYSIS_ATTRIBUTES.operation]: "call_tool",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.success,
        })
        correlator.observe(success)

        const failing = event("mcp.call_tool", {
            [ANALYSIS_ATTRIBUTES.component]: "mcp",
            [ANALYSIS_ATTRIBUTES.operation]: "call_tool",
            [ANALYSIS_ATTRIBUTES.outcome]: OUTCOME.failure,
        })
        const built = correlator.correlate(failing)

        expect(built.lastSuccess?.eventId).toBe(success.eventId)
    })

    it("does not mix events from a different task", () => {
        const correlator = new IncidentCorrelator()
        const otherTask = event(
            "provider.request",
            { [ANALYSIS_ATTRIBUTES.component]: "provider" },
            { context: { sessionId: "session-1", taskId: "task-2" } },
        )
        correlator.observe(otherTask)

        const failing = event("provider.request", { [ANALYSIS_ATTRIBUTES.component]: "provider" })
        const built = correlator.correlate(failing)

        expect(built.precedingEvents).toHaveLength(0)
    })

    it("orders preceding events by sequence, not arrival", () => {
        const correlator = new IncidentCorrelator()
        const first = event("a", { [ANALYSIS_ATTRIBUTES.component]: "provider" })
        const second = event("b", { [ANALYSIS_ATTRIBUTES.component]: "provider" })
        correlator.observe(second)
        correlator.observe(first)

        const failing = event("c", { [ANALYSIS_ATTRIBUTES.component]: "provider" })
        const built = correlator.correlate(failing)

        expect(built.precedingEvents.map((e) => e.eventId)).toEqual([first.eventId, second.eventId])
    })

    it("excludes events older than the correlation window", () => {
        const correlator = new IncidentCorrelator({ correlationWindowMs: 500 })
        const stale = event("stale", { [ANALYSIS_ATTRIBUTES.component]: "provider" }, { monotonicMs: 0 })
        correlator.observe(stale)

        const failing = event("failing", { [ANALYSIS_ATTRIBUTES.component]: "provider" }, { monotonicMs: 10_000 })
        const built = correlator.correlate(failing)

        expect(built.precedingEvents).toHaveLength(0)
    })

    it("bounds retained history per scope", () => {
        const correlator = new IncidentCorrelator({ historySize: 3, correlationWindowMs: 10_000_000 })
        for (let i = 0; i < 10; i++) {
            correlator.observe(event(`e-${i}`, { [ANALYSIS_ATTRIBUTES.component]: "provider" }))
        }

        const failing = event("failing", { [ANALYSIS_ATTRIBUTES.component]: "provider" })
        const built = correlator.correlate(failing)

        expect(built.precedingEvents).toHaveLength(3)
    })
})
