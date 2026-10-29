import { afterEach, describe, expect, it, vi } from "vitest"
import { RuntimeEventBus } from "../runtime/runtime-event-bus"
import { drainBootstrapSignalsInto, RuntimeSignalPipeline, signalLevelToPriority } from "../runtime/signal-pipeline"
import { RuntimeEventPriority } from "../runtime/types"
import {
    BOOTSTRAP_CAPACITY,
    bootstrapSignalCount,
    configureSignalRecording,
    discardBootstrapSignals,
    drainBootstrapSignals,
    emitSignal,
    installSignalPipeline,
    isSignalRecordingEnabled,
    resetSignalRecording,
    type SignalPipeline,
    type TelemetrySignal,
} from "../service/pipeline-port"

/**
 * The port is the contract three module groups share, so its behaviour under
 * the awkward cases — no pipeline yet, a pipeline that throws, a pipeline
 * replaced mid-session — is what the rest of the package relies on.
 */

function collectingPipeline(): { pipeline: SignalPipeline; received: TelemetrySignal[] } {
    const received: TelemetrySignal[] = []
    return {
        pipeline: {
            accept(signal) {
                received.push(signal)
            },
        },
        received,
    }
}

describe("telemetry pipeline port", () => {
    afterEach(() => {
        installSignalPipeline(undefined)
        discardBootstrapSignals()
        resetSignalRecording()
    })

    it("delivers to the installed pipeline", () => {
        const { pipeline, received } = collectingPipeline()
        installSignalPipeline(pipeline)

        emitSignal({ name: "task.init", level: "info" })

        expect(received.map((signal) => signal.name)).toEqual(["task.init"])
    })

    it("buffers signals recorded before a pipeline exists", () => {
        emitSignal({ name: "startup.phase", level: "performance" })

        expect(bootstrapSignalCount()).toBe(1)
        const drained = drainBootstrapSignals()
        expect(drained.signals.map((signal) => signal.name)).toEqual(["startup.phase"])
        expect(drained.dropped).toBe(0)
    })

    it("bounds the bootstrap buffer, keeping the most recent signals", () => {
        const emitted = BOOTSTRAP_CAPACITY + 44
        for (let index = 0; index < emitted; index++) {
            emitSignal({ name: `startup.${index}`, level: "debug" })
        }

        const drained = drainBootstrapSignals()
        expect(drained.signals).toHaveLength(BOOTSTRAP_CAPACITY)
        expect(drained.dropped).toBe(emitted - BOOTSTRAP_CAPACITY)

        // Overflow means startup is stuck; the recent signals say where, while
        // the earliest only say that it began.
        expect(drained.signals[0].name).toBe(`startup.${emitted - BOOTSTRAP_CAPACITY}`)
        expect(drained.signals.at(-1)?.name).toBe(`startup.${emitted - 1}`)
    })

    it("does not auto-flush buffered signals when a pipeline is installed", () => {
        emitSignal({ name: "startup.phase", level: "info" })
        const { pipeline, received } = collectingPipeline()

        installSignalPipeline(pipeline)

        // Whether early facts may enter a session is a consent decision owned
        // by the lifecycle, not by the act of installing a destination.
        expect(received).toEqual([])
        expect(bootstrapSignalCount()).toBe(1)
    })

    it("keeps buffered signals when the pipeline is uninstalled", () => {
        emitSignal({ name: "startup.phase", level: "info" })

        installSignalPipeline(undefined)

        // Installing only swaps the destination. A first activation uninstalls
        // on its way in — there is no predecessor to shut down — so discarding
        // here would throw away the startup window it is about to drain.
        expect(bootstrapSignalCount()).toBe(1)
    })

    it("drops buffered signals only when discarded explicitly", () => {
        emitSignal({ name: "startup.phase", level: "info" })

        discardBootstrapSignals()

        expect(bootstrapSignalCount()).toBe(0)
    })

    it("re-reads the enabled predicate so a consent change takes effect", () => {
        let enabled = false
        configureSignalRecording({ enabled: () => enabled })

        expect(isSignalRecordingEnabled()).toBe(false)
        enabled = true
        expect(isSignalRecordingEnabled()).toBe(true)
    })
})

describe("runtime signal pipeline", () => {
    it("maps every signal level onto a queue priority", () => {
        expect(signalLevelToPriority("debug")).toBe(RuntimeEventPriority.Debug)
        expect(signalLevelToPriority("info")).toBe(RuntimeEventPriority.Info)
        expect(signalLevelToPriority("performance")).toBe(RuntimeEventPriority.Performance)
        expect(signalLevelToPriority("error")).toBe(RuntimeEventPriority.Error)
        expect(signalLevelToPriority("invariant")).toBe(RuntimeEventPriority.Invariant)
    })

    it("records signals onto the bus with their attributes and context", () => {
        const bus = new RuntimeEventBus({ sessionId: "session-1" })
        const pipeline = new RuntimeSignalPipeline(bus)

        pipeline.accept({
            name: "terminal.execute",
            level: "performance",
            attributes: { durationMs: 12 },
            context: { taskId: "task-1" },
        })

        const [event] = bus.peek()
        expect(event.name).toBe("terminal.execute")
        expect(event.priority).toBe(RuntimeEventPriority.Performance)
        expect(event.attributes).toMatchObject({ durationMs: 12 })
        expect(event.context.taskId).toBe("task-1")
    })

    it("never lets a bus failure reach the producer", () => {
        const bus = new RuntimeEventBus()
        vi.spyOn(bus, "record").mockImplementation(() => {
            throw new Error("bus exploded")
        })
        const pipeline = new RuntimeSignalPipeline(bus)

        // A producer reporting a failure must not fail because of the report.
        expect(() => pipeline.accept({ name: "task.failed", level: "error" })).not.toThrow()
    })
})

describe("bootstrap drain under consent", () => {
    afterEach(() => {
        installSignalPipeline(undefined)
        discardBootstrapSignals()
        resetSignalRecording()
    })

    it("admits buffered startup signals in order once consent allows", () => {
        emitSignal({ name: "activation.start", level: "info" })
        emitSignal({ name: "activation.storage_ready", level: "performance", attributes: { durationMs: 5 } })
        const bus = new RuntimeEventBus({ sessionId: "session-1" })

        drainBootstrapSignalsInto(bus, true)

        expect(bus.peek().map((event) => event.name)).toEqual(["activation.start", "activation.storage_ready"])
        expect(bootstrapSignalCount()).toBe(0)
    })

    it("discards buffered startup signals when consent is withheld", () => {
        emitSignal({ name: "activation.start", level: "info" })
        const bus = new RuntimeEventBus({ sessionId: "session-1" })

        drainBootstrapSignalsInto(bus, false)

        // The user did not agree to the session these were recorded in, so they
        // are dropped rather than held for a later opt-in.
        expect(bus.peek()).toEqual([])
        expect(bootstrapSignalCount()).toBe(0)
    })
})
