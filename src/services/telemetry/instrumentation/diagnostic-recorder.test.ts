import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRuntimeTelemetryBus, setRuntimeTelemetryBus } from "../runtime/index"
import type { RuntimeEventBus } from "../runtime/runtime-event-bus"
import { installRuntimeSignalPipeline, resetRuntimeSignalPipeline } from "../runtime/signal-pipeline"
import { RuntimeEventPriority } from "../runtime/types"
import {
    DIAGNOSTIC_KINDS,
    DiagnosticDomain,
    DiagnosticOutcome,
    diagnosticDomains,
    diagnosticEventName,
    isKnownDiagnosticKind,
} from "./diagnostic-events"
import { isDiagnosticRecordingEnabled, recordDiagnostic } from "./diagnostic-recorder"
import { configurePerfRecorder, resetPerfRecorder } from "./duration-recorder"

describe("diagnostic events catalogue", () => {
    it("declares at least one kind for every domain", () => {
        for (const domain of diagnosticDomains()) {
            expect(DIAGNOSTIC_KINDS[domain].length).toBeGreaterThan(0)
        }
    })

    it("keeps kind names unique within a domain", () => {
        for (const domain of diagnosticDomains()) {
            const kinds = DIAGNOSTIC_KINDS[domain] as readonly string[]
            expect(new Set(kinds).size).toBe(kinds.length)
        }
    })

    it("prefixes event names so diagnostics never collide with performance phases", () => {
        expect(diagnosticEventName(DiagnosticDomain.Terminal, "warm_pool_miss")).toBe("diagnostic.terminal.warm_pool_miss")
    })

    it("rejects a kind that belongs to a different domain", () => {
        expect(isKnownDiagnosticKind(DiagnosticDomain.Terminal, "warm_pool_miss")).toBe(true)
        expect(isKnownDiagnosticKind(DiagnosticDomain.Storage, "warm_pool_miss")).toBe(false)
    })
})

describe("diagnostic recorder", () => {
    let bus: RuntimeEventBus
    let previousBus: RuntimeEventBus | undefined

    beforeEach(() => {
        bus = createRuntimeTelemetryBus()
        previousBus = setRuntimeTelemetryBus(bus)
        // Diagnostics travel the same port as performance phases, so the test
        // needs a pipeline installed over its bus for anything to arrive.
        installRuntimeSignalPipeline(bus, () => true)
        resetPerfRecorder()
    })

    afterEach(() => {
        setRuntimeTelemetryBus(previousBus)
        resetRuntimeSignalPipeline()
        resetPerfRecorder()
    })

    describe("when recording is enabled", () => {
        it("emits the diagnostic at debug priority with its outcome", () => {
            configurePerfRecorder({ enabled: () => true })

            recordDiagnostic(DiagnosticDomain.Terminal, "warm_pool_miss", DiagnosticOutcome.Degraded, { poolSize: 0 })

            const events = bus.peek()
            expect(events).toHaveLength(1)
            expect(events[0].name).toBe("diagnostic.terminal.warm_pool_miss")
            expect(events[0].priority).toBe(RuntimeEventPriority.Debug)
            expect(events[0].attributes).toMatchObject({ poolSize: 0, outcome: "degraded" })
        })

        it("never lets a caller dimension shadow the outcome", () => {
            configurePerfRecorder({ enabled: () => true })

            recordDiagnostic(DiagnosticDomain.Storage, "lock_contended", DiagnosticOutcome.Recovered, {
                outcome: "failed",
            })

            expect(bus.peek()[0].attributes).toMatchObject({ outcome: "recovered" })
        })

        it("carries an explicit context onto the event", () => {
            configurePerfRecorder({ enabled: () => true })

            recordDiagnostic(
                DiagnosticDomain.Task,
                "stream_retry",
                DiagnosticOutcome.Recovered,
                { attempt: 2 },
                {
                    taskId: "task-4",
                },
            )

            expect(bus.peek()[0].context.taskId).toBe("task-4")
        })

        it("emits without dimensions when the fact needs none", () => {
            configurePerfRecorder({ enabled: () => true })

            recordDiagnostic(DiagnosticDomain.Workspace, "watcher_restarted", DiagnosticOutcome.Observed)

            expect(bus.peek()[0].attributes).toMatchObject({ outcome: "observed" })
        })
    })

    describe("when recording is disabled", () => {
        it("emits nothing", () => {
            configurePerfRecorder({ enabled: () => false })

            recordDiagnostic(DiagnosticDomain.Hook, "discovery_cache_miss", DiagnosticOutcome.Observed, { dirs: 3 })

            expect(bus.peek()).toHaveLength(0)
        })

        it("reports the disabled state so callers can skip building dimensions", () => {
            configurePerfRecorder({ enabled: () => false })

            expect(isDiagnosticRecordingEnabled()).toBe(false)
        })
    })

    it("follows the same switch as performance recording", () => {
        let enabled = false
        configurePerfRecorder({ enabled: () => enabled })

        recordDiagnostic(DiagnosticDomain.Profile, "resolution_fallback", DiagnosticOutcome.Degraded)
        expect(bus.peek()).toHaveLength(0)

        enabled = true
        recordDiagnostic(DiagnosticDomain.Profile, "resolution_fallback", DiagnosticOutcome.Degraded)
        expect(bus.peek()).toHaveLength(1)
        expect(isDiagnosticRecordingEnabled()).toBe(true)
    })
})
