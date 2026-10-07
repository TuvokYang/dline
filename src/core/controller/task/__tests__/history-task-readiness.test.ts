import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenTelemetryTraceProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTraceProvider"
import {
	configureSignalRecording,
	installObservabilityPipeline,
	resetSignalRecording,
} from "@/services/telemetry/service/pipeline-port"
import { prepareHistoryTaskForDisplay, projectHistoryPreparingView } from "../history-task-readiness"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action()
	installObservabilityPipeline(undefined)
	resetSignalRecording()
})

function setupTraceExporter(): {
	readonly exporter: InMemorySpanExporter
	readonly provider: OpenTelemetryTraceProvider
	readonly recordHistogram: ReturnType<typeof vi.fn>
} {
	const exporter = new InMemorySpanExporter()
	const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
		processor: new SimpleSpanProcessor(exporter),
	})
	const recordHistogram = vi.fn()
	configureSignalRecording({ enabled: () => true })
	installObservabilityPipeline({
		startSpan: (options) => provider.startSpan(options),
		recordGauge: () => {},
		recordHistogram,
	})
	cleanup.push(() => provider.dispose())
	return { exporter, provider, recordHistogram }
}

describe("history task readiness", () => {
	it("projects a visible but non-dispatchable Resume action while preparing", () => {
		const view = projectHistoryPreparingView({ taskId: "task-1", phase: "initializing", revision: 3 })

		expect(view.activeInteraction).toBeUndefined()
		expect(view.input.enabled).toBe(false)
		expect(view.footer.actions).toEqual([
			expect.objectContaining({ type: "resume", label: "Resume", enabled: false, dispatchTarget: "interaction" }),
		])
	})

	it("records one bounded root span and low-cardinality stages across display and interactive preparation", async () => {
		const { exporter, provider, recordHistogram } = setupTraceExporter()

		await prepareHistoryTaskForDisplay({
			taskId: "task-1",
			displayHistory: async () => undefined,
			prepareFromHistory: async (options) => options.onReadyToDisplay?.(),
			hasTaskLock: true,
			isCurrent: () => true,
			onReadyToDisplay: async () => undefined,
		})
		await provider.forceFlush()

		const span = exporter.getFinishedSpans().find((candidate) => candidate.name === "task.history_prepare")
		expect(span?.attributes).toMatchObject({ has_task_lock: true, current: true, outcome: "success" })
		expect(span?.events.map((event) => event.name)).toEqual([
			"task.history_prepare.preparing",
			"task.history_prepare.displayed",
			"task.history_prepare.ready",
			"task.history_prepare.prepared",
		])
		const stageAttributes = recordHistogram.mock.calls
			.filter(([name]) => name === "dline.runtime.operation.duration")
			.map(([, , attributes]) => attributes)
		expect(stageAttributes).toEqual([
			{
				operation: "task_init.stage",
				stage: "history_surface_preparing",
				kind: "history",
				hasTaskLock: true,
				outcome: "success",
			},
			{
				operation: "task_init.stage",
				stage: "history_display",
				kind: "history",
				hasTaskLock: true,
				outcome: "success",
			},
			{
				operation: "task_init.stage",
				stage: "history_surface_ready",
				kind: "history",
				hasTaskLock: true,
				outcome: "success",
			},
			{
				operation: "task_init.stage",
				stage: "history_background_prepare",
				kind: "history",
				hasTaskLock: true,
				outcome: "success",
			},
		])
		for (const attributes of stageAttributes) {
			expect(attributes).not.toHaveProperty("taskId")
			expect(attributes).not.toHaveProperty("elapsedMs")
		}
	})

	it("publishes a preparing surface before full historical display is ready", async () => {
		const order: string[] = []
		let releaseDisplay!: () => void
		const displayBlocked = new Promise<void>((resolve) => {
			releaseDisplay = resolve
		})
		const onPreparingToDisplay = vi.fn(async () => {
			order.push("preparing")
		})
		const displayHistory = vi.fn(async () => {
			order.push("display")
			await displayBlocked
		})
		const prepareFromHistory = vi.fn(async () => undefined)

		const readiness = prepareHistoryTaskForDisplay({
			taskId: "task-1",
			displayHistory,
			prepareFromHistory,
			hasTaskLock: true,
			isCurrent: () => true,
			onPreparingToDisplay,
		} as Parameters<typeof prepareHistoryTaskForDisplay>[0] & {
			onPreparingToDisplay: () => Promise<void>
		})

		await vi.waitFor(() => expect(displayHistory).toHaveBeenCalledOnce())
		expect(order[0]).toBe("preparing")
		expect(onPreparingToDisplay).toHaveBeenCalledOnce()
		releaseDisplay()
		await readiness
	})

	it("publishes the displayed surface once and stops before background preparation when it replaces the current Task", async () => {
		let isCurrent = true
		const displayHistory = vi.fn(async () => undefined)
		const onReadyToDisplay = vi.fn(async () => {
			isCurrent = false
		})
		const prepareFromHistory = vi.fn(async () => undefined)

		await expect(
			prepareHistoryTaskForDisplay({
				taskId: "task-1",
				displayHistory,
				prepareFromHistory,
				hasTaskLock: true,
				isCurrent: () => isCurrent,
				onReadyToDisplay,
			}),
		).resolves.toBe(false)

		expect(displayHistory).toHaveBeenCalledOnce()
		expect(prepareFromHistory).not.toHaveBeenCalled()
		expect(onReadyToDisplay).toHaveBeenCalledOnce()
	})

	it("does not prepare or notify after displayHistory loses Task identity", async () => {
		let isCurrent = true
		const displayHistory = vi.fn(async () => {
			isCurrent = false
		})
		const prepareFromHistory = vi.fn(async () => undefined)
		const onReadyToDisplay = vi.fn(async () => undefined)

		await expect(
			prepareHistoryTaskForDisplay({
				taskId: "task-1",
				displayHistory,
				prepareFromHistory,
				hasTaskLock: true,
				isCurrent: () => isCurrent,
				onReadyToDisplay,
			}),
		).resolves.toBe(false)

		expect(prepareFromHistory).not.toHaveBeenCalled()
		expect(onReadyToDisplay).not.toHaveBeenCalled()
	})

	it("treats a preparation aborted by Task detachment as superseded instead of failing", async () => {
		let isCurrent = true
		const prepareFromHistory = vi.fn(async () => {
			isCurrent = false
			throw new Error("task_detached")
		})

		await expect(
			prepareHistoryTaskForDisplay({
				taskId: "task-1",
				displayHistory: async () => undefined,
				prepareFromHistory,
				hasTaskLock: true,
				isCurrent: () => isCurrent,
			}),
		).resolves.toBe(false)

		expect(prepareFromHistory).toHaveBeenCalledOnce()
	})

	it("still rejects when background preparation fails while the Task owns the surface", async () => {
		const failure = new Error("history unreadable")

		await expect(
			prepareHistoryTaskForDisplay({
				taskId: "task-1",
				displayHistory: async () => undefined,
				prepareFromHistory: async () => {
					throw failure
				},
				hasTaskLock: true,
				isCurrent: () => true,
			}),
		).rejects.toBe(failure)
	})

	it("reveals readonly history after display without running interactive preparation", async () => {
		const displayHistory = vi.fn(async () => undefined)
		const prepareFromHistory = vi.fn(async () => undefined)
		const onReadyToDisplay = vi.fn(async () => undefined)

		await expect(
			prepareHistoryTaskForDisplay({
				taskId: "task-1",
				displayHistory,
				prepareFromHistory,
				hasTaskLock: false,
				isCurrent: () => true,
				onReadyToDisplay,
			}),
		).resolves.toBe(true)

		expect(displayHistory).toHaveBeenCalledOnce()
		expect(prepareFromHistory).not.toHaveBeenCalled()
		expect(onReadyToDisplay).toHaveBeenCalledOnce()
	})
})
