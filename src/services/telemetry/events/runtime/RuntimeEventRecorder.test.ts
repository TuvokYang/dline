import { afterEach, describe, expect, it } from "vitest"
import {
	configureSignalRecording,
	discardBootstrapSignals,
	installSignalPipeline,
	resetSignalRecording,
	type TelemetrySignal,
} from "../../service/pipeline-port"
import { RuntimeEventRecorder } from "./RuntimeEventRecorder"

const received: TelemetrySignal[] = []

afterEach(() => {
	received.length = 0
	installSignalPipeline(undefined)
	discardBootstrapSignals()
	resetSignalRecording()
})

describe("RuntimeEventRecorder", () => {
	it("records runtime facts through the pipeline port", () => {
		configureSignalRecording({ enabled: () => true })
		installSignalPipeline({ accept: (signal) => received.push(signal) })
		const recorder = new RuntimeEventRecorder()
		const error = new Error("runtime failed")

		recorder.info("runtime.ready", { phase: "ready" })
		recorder.failure("runtime.failed", error)

		expect(received).toEqual([
			{
				name: "runtime.ready",
				level: "info",
				timestamp: expect.any(Number),
				monotonicMs: expect.any(Number),
				attributes: { phase: "ready" },
				context: undefined,
			},
			{
				name: "runtime.failed",
				level: "error",
				timestamp: expect.any(Number),
				monotonicMs: expect.any(Number),
				attributes: undefined,
				error,
				context: undefined,
			},
		])
		expect(received[1].timestamp).toBeGreaterThanOrEqual(received[0].timestamp ?? 0)
		expect(received[1].monotonicMs).toBeGreaterThanOrEqual(received[0].monotonicMs ?? 0)
	})

	it("does not let invariant events bypass disabled error consent", () => {
		configureSignalRecording({ enabled: () => false })
		installSignalPipeline({ accept: (signal) => received.push(signal) })

		new RuntimeEventRecorder().invariant("runtime.invariant")

		expect(received).toEqual([])
	})
})
