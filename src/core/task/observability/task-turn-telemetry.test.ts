import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it } from "vitest"
import { OpenTelemetryTraceProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTraceProvider"
import {
	configureSignalRecording,
	installObservabilityPipeline,
	resetSignalRecording,
} from "@/services/telemetry/service/pipeline-port"
import { createTaskRuntimeState, type TaskRuntimeState } from "../runtime/TaskRuntimeState"
import { TaskPhase } from "../TaskPhase"
import { TaskTurnTelemetry } from "./task-turn-telemetry"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action()
	installObservabilityPipeline(undefined)
	resetSignalRecording()
})

function setupTraceExporter(): {
	readonly exporter: InMemorySpanExporter
	readonly provider: OpenTelemetryTraceProvider
} {
	const exporter = new InMemorySpanExporter()
	const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
		processor: new SimpleSpanProcessor(exporter),
	})
	configureSignalRecording({ enabled: () => true })
	installObservabilityPipeline({
		startSpan: (options) => provider.startSpan(options),
		recordGauge: () => {},
		recordHistogram: () => {},
	})
	cleanup.push(() => provider.dispose())
	return { exporter, provider }
}

function streamingState(turnId: string, revision: number): TaskRuntimeState {
	return {
		...createTaskRuntimeState({
			taskId: "task-1",
			phase: TaskPhase.STREAMING,
			revision,
			anchor: { apiIndex: revision, turnId },
		}),
		turn: {
			turnId,
			assistantApiIndex: revision,
			mode: "serial",
			blocks: [],
		},
	}
}

describe("TaskTurnTelemetry", () => {
	it("accepts a delayed failure from an older segment of the same real turn", async () => {
		const { exporter, provider } = setupTraceExporter()
		const state = streamingState("turn-a", 1)
		const timeline = new TaskTurnTelemetry(
			"task-1",
			() => state,
			() => ({ cacheUsageAvailable: false }),
		)
		cleanup.push(() => timeline.dispose())

		timeline.committed("TURN_CREATED", state)
		const requestParent = timeline.currentSpan()!
		for (let index = 0; index < 96; index += 1) timeline.event("task.test.event", { index })
		const segmentAfterLimit = timeline.currentSpan()!

		expect(segmentAfterLimit.spanContext?.traceId).toBe(requestParent.spanContext?.traceId)
		expect(segmentAfterLimit.spanContext?.spanId).not.toBe(requestParent.spanContext?.spanId)

		timeline.failure(Object.assign(new Error("private"), { status: 503 }), { api_request_phase: "streaming" }, requestParent)
		const continuation = timeline.currentSpan()!

		expect(segmentAfterLimit.active).toBe(false)
		expect(continuation.active).toBe(true)
		expect(continuation.spanContext?.traceId).toBe(requestParent.spanContext?.traceId)
		expect(continuation.spanContext?.spanId).not.toBe(segmentAfterLimit.spanContext?.spanId)

		timeline.dispose()
		await provider.forceFlush()
		const failed = exporter
			.getFinishedSpans()
			.find((span) => span.spanContext().spanId === segmentAfterLimit.spanContext?.spanId)
		expect(failed?.attributes).toMatchObject({ outcome: "failure", task_segment_end_reason: "error" })
		expect(failed?.events.map((event) => event.name)).toContain("task.error")
	})

	it("ignores a delayed failure captured by a previous real turn", async () => {
		const { exporter, provider } = setupTraceExporter()
		let state = streamingState("turn-a", 1)
		const timeline = new TaskTurnTelemetry(
			"task-1",
			() => state,
			() => ({ cacheUsageAvailable: false }),
		)
		cleanup.push(() => timeline.dispose())

		timeline.committed("TURN_CREATED", state)
		const previousTurn = timeline.currentSpan()!
		state = streamingState("turn-b", 2)
		timeline.committed("TURN_CREATED", state)
		const currentTurn = timeline.currentSpan()!

		expect(currentTurn.spanContext?.traceId).not.toBe(previousTurn.spanContext?.traceId)
		timeline.failure(new Error("late private failure"), {}, previousTurn)
		expect(timeline.currentSpan()).toBe(currentTurn)
		expect(currentTurn.active).toBe(true)

		timeline.dispose()
		await provider.forceFlush()
		const exportedCurrentTurn = exporter
			.getFinishedSpans()
			.find((span) => span.spanContext().spanId === currentTurn.spanContext?.spanId)
		expect(exportedCurrentTurn?.events.map((event) => event.name)).not.toContain("task.error")
	})
})
