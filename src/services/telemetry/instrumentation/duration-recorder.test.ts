import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRuntimeTelemetryBus, setRuntimeTelemetryBus } from "../runtime/index"
import { forwardRuntimeEvent } from "../runtime/provider-event-bridge"
import type { RuntimeEventBus } from "../runtime/runtime-event-bus"
import { installRuntimeSignalPipeline, resetRuntimeSignalPipeline } from "../runtime/signal-pipeline"
import { RuntimeEventPriority } from "../runtime/types"
import { installObservabilityPipeline } from "../service/pipeline-port"
import {
    configurePerfRecorder,
    isPerfRecordingEnabled,
    markPerfPhase,
    recordPerfPhase,
    resetPerfRecorder,
    startPerfPhase,
} from "./duration-recorder"
import { PerfDomain } from "./perf-domains"

describe("duration recorder", () => {
    let bus: RuntimeEventBus
    let previousBus: RuntimeEventBus | undefined

    beforeEach(() => {
        bus = createRuntimeTelemetryBus()
        previousBus = setRuntimeTelemetryBus(bus)
        // The recorder reaches the bus through the pipeline port, so a test
        // that only installs a bus would leave its signals in the bootstrap
        // buffer with nowhere to go.
        installRuntimeSignalPipeline(bus, () => true)
        resetPerfRecorder()
    })

    afterEach(() => {
        setRuntimeTelemetryBus(previousBus)
        resetRuntimeSignalPipeline()
        installObservabilityPipeline(undefined)
        resetPerfRecorder()
    })

    describe("when recording is enabled", () => {
        it("emits a performance event carrying the measured duration", () => {
            let currentMs = 1_000
            configurePerfRecorder({ enabled: () => true, now: () => currentMs })

            const handle = startPerfPhase(PerfDomain.Terminal, "execute_complete", { terminalId: 7 })
            currentMs = 1_250
            handle.stop({ outcome: "completed" })

            const events = bus.peek()
            expect(events).toHaveLength(1)
            expect(events[0].name).toBe("terminal.execute_complete")
            expect(events[0].priority).toBe(RuntimeEventPriority.Performance)
            expect(events[0].attributes).toMatchObject({
                terminalId: 7,
                outcome: "completed",
                durationMs: 250,
            })
        })

        it("keeps settings controller callback samples at INFO severity", () => {
            configurePerfRecorder({ enabled: () => true, now: () => 0 })
            recordPerfPhase(PerfDomain.Settings, "controller_callback", 12, {
                outcome: "state_publish",
            })

            const [event] = bus.peek()
            const captureRuntimeEvent = vi.fn()
            forwardRuntimeEvent(event, { captureRuntimeEvent })

            expect(event.priority).toBe(RuntimeEventPriority.Performance)
            expect(captureRuntimeEvent).toHaveBeenCalledTimes(1)
            expect(captureRuntimeEvent.mock.calls[0]?.[0]).toBe("settings.controller_callback")
            expect(captureRuntimeEvent.mock.calls[0]?.[2]).toBe("info")
        })

        it("also records a low-cardinality duration histogram", () => {
            const recordHistogram = vi.fn()
            installObservabilityPipeline({
                recordHistogram,
                recordGauge: vi.fn(),
                startSpan: () => ({
                    active: false,
                    setAttribute() {},
                    recordException() {},
                    end() {},
                }),
            })
            let currentMs = 100
            configurePerfRecorder({ enabled: () => true, now: () => currentMs })

            const handle = startPerfPhase(PerfDomain.Terminal, "execute_complete", { terminalId: 7 })
            currentMs = 350
            handle.stop({ outcome: "completed" })

            expect(recordHistogram).toHaveBeenCalledWith(
                "dline.runtime.operation.duration",
                250,
                { operation: "terminal.execute_complete", outcome: "completed" },
                "Runtime operation duration in milliseconds",
            )
        })

        it("lets stop-time dimensions override start-time dimensions", () => {
            configurePerfRecorder({ enabled: () => true, now: () => 0 })

            const handle = startPerfPhase(PerfDomain.Terminal, "execute_complete", { outcome: "pending" })
            handle.stop({ outcome: "failed_or_unverified" })

            expect(bus.peek()[0].attributes).toMatchObject({ outcome: "failed_or_unverified" })
        })

        it("ignores a second stop so a retry path cannot double count", () => {
            configurePerfRecorder({ enabled: () => true, now: () => 0 })

            const handle = startPerfPhase(PerfDomain.FileLock, "acquire")
            handle.stop()
            handle.stop()

            expect(bus.peek()).toHaveLength(1)
        })

        it("records a duration measured elsewhere", () => {
            configurePerfRecorder({ enabled: () => true })

            recordPerfPhase(PerfDomain.Checkpoint, "existing_shadow_baseline", 42.6, { staged: 3 })

            const event = bus.peek()[0]
            expect(event.name).toBe("checkpoint.existing_shadow_baseline")
            expect(event.attributes).toMatchObject({ staged: 3, durationMs: 43 })
        })

        it("records a marker without a duration at debug priority", () => {
            configurePerfRecorder({ enabled: () => true })

            markPerfPhase(PerfDomain.PromptInputWatcher, "start", { roots: 2 })

            const event = bus.peek()[0]
            expect(event.name).toBe("prompt_input_watcher.start")
            expect(event.priority).toBe(RuntimeEventPriority.Debug)
            expect(event.attributes).toMatchObject({ roots: 2 })
            expect(event.attributes).not.toHaveProperty("durationMs")
        })

        it("carries an explicit context onto the event", () => {
            configurePerfRecorder({ enabled: () => true, now: () => 0 })

            startPerfPhase(PerfDomain.TaskInit, "stage", undefined, { taskId: "task-9" }).stop()

            expect(bus.peek()[0].context.taskId).toBe("task-9")
        })
    })

    describe("when recording is disabled", () => {
        it("does not read the clock", () => {
            const now = vi.fn(() => 0)
            configurePerfRecorder({ enabled: () => false, now })

            const handle = startPerfPhase(PerfDomain.Settings, "sync_broadcast", { callbacks: 4 })
            handle.stop({ totalMs: 12 })

            expect(now).not.toHaveBeenCalled()
        })

        it("emits nothing through any entry point", () => {
            configurePerfRecorder({ enabled: () => false })

            startPerfPhase(PerfDomain.Settings, "sync_broadcast").stop()
            recordPerfPhase(PerfDomain.Settings, "state_flush", 10)
            markPerfPhase(PerfDomain.PromptInputWatcher, "start")

            expect(bus.peek()).toHaveLength(0)
        })

        it("reports an inactive handle so callers can skip their own preparation", () => {
            configurePerfRecorder({ enabled: () => false })

            expect(startPerfPhase(PerfDomain.Profile, "get_profiles").active).toBe(false)
            expect(isPerfRecordingEnabled()).toBe(false)
        })

        it("reuses one shared handle instead of allocating per call", () => {
            configurePerfRecorder({ enabled: () => false })

            const first = startPerfPhase(PerfDomain.Profile, "get_profiles")
            const second = startPerfPhase(PerfDomain.Capability, "skills_refresh")

            expect(first).toBe(second)
        })
    })

    it("re-reads the enabled predicate on every call so a setting change takes effect", () => {
        let enabled = false
        configurePerfRecorder({ enabled: () => enabled, now: () => 0 })

        startPerfPhase(PerfDomain.Settings, "state_flush").stop()
        expect(bus.peek()).toHaveLength(0)

        enabled = true
        startPerfPhase(PerfDomain.Settings, "state_flush").stop()
        expect(bus.peek()).toHaveLength(1)
    })
})
