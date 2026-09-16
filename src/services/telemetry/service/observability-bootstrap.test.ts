import { afterEach, describe, expect, it, vi } from "vitest"
import {
	configureSignalRecording,
	discardBootstrapSignals,
	installObservabilityPipeline,
	observabilityBootstrapCount,
	recordDurationHistogram,
	recordRuntimeGauge,
	resetSignalRecording,
	startSignalSpan,
} from "./pipeline-port"

function target() {
	return {
		recordHistogram: vi.fn(),
		recordGauge: vi.fn(),
		startSpan: vi.fn(() => ({ active: true, setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() })),
	}
}

afterEach(() => {
	installObservabilityPipeline(undefined)
	discardBootstrapSignals()
	resetSignalRecording()
})

describe("observability bootstrap", () => {
	it("replays completed startup metrics and spans after consent", () => {
		configureSignalRecording({ enabled: () => true })
		recordDurationHistogram(12, { operation: "activation" })
		recordRuntimeGauge("runtime_cpu_utilization_ratio", 0.5, "CPU")
		const startedAt = Date.now()
		const span = startSignalSpan({ name: "activation.stage", startTime: startedAt })
		span.setAttribute("stage", "storage")
		span.end("success")
		expect(observabilityBootstrapCount()).toBe(3)
		const pipeline = target()

		installObservabilityPipeline(pipeline)

		expect(pipeline.recordHistogram).toHaveBeenCalledOnce()
		expect(pipeline.recordGauge).toHaveBeenCalledOnce()
		expect(pipeline.startSpan).toHaveBeenCalledWith({
			name: "activation.stage",
			attributes: { stage: "storage" },
			startTime: startedAt,
			parent: undefined,
		})
		expect(pipeline.startSpan.mock.results[0].value.end).toHaveBeenCalledWith("success", expect.any(Number))
		expect(observabilityBootstrapCount()).toBe(0)
	})

	it("attaches a span still running when the destination becomes available", () => {
		const span = startSignalSpan({ name: "open" })
		const pipeline = target()
		installObservabilityPipeline(pipeline)
		span.end("cancelled", 1_789_000_000_123)
		expect(pipeline.startSpan.mock.results[0].value.end).toHaveBeenCalledWith("cancelled", 1_789_000_000_123)
		expect(span.active).toBe(false)
	})

	it("destroys startup measurements when consent is disabled", () => {
		recordDurationHistogram(12, { operation: "activation" })
		startSignalSpan({ name: "activation.stage" }).end("failure")
		configureSignalRecording({ enabled: () => false })
		const pipeline = target()

		installObservabilityPipeline(pipeline)

		expect(pipeline.recordHistogram).not.toHaveBeenCalled()
		expect(pipeline.startSpan).not.toHaveBeenCalled()
		expect(observabilityBootstrapCount()).toBe(0)
	})
})
