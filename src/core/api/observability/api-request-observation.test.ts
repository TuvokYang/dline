import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaskTurnTelemetry } from "@/core/task/observability/task-turn-telemetry"
import { createTaskRuntimeState } from "@/core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@/core/task/TaskPhase"
import { OpenTelemetryTelemetryProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTelemetryProvider"
import { OpenTelemetryTraceProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTraceProvider"
import { forwardRuntimeEvent } from "@/services/telemetry/runtime/provider-event-bridge"
import { RuntimeEventBus } from "@/services/telemetry/runtime/runtime-event-bus"
import { RuntimeSignalPipeline } from "@/services/telemetry/runtime/signal-pipeline"
import { TelemetryChannelPolicy } from "@/services/telemetry/service/channel-policy"
import {
	configureSignalRecording,
	emitSignal,
	installObservabilityPipeline,
	installSignalPipeline,
	resetSignalRecording,
} from "@/services/telemetry/service/pipeline-port"
import { TelemetryProviderRegistry } from "@/services/telemetry/service/provider-registry"
import { ModelInfo } from "@/shared/proto/dline/models"
import { ApiProfile } from "@/shared/proto/dline/profile"
import type { ApiHandler } from "../index"
import type { ApiStream } from "../transform/stream"
import { instrumentApiHandler } from "./instrument-api-handler"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action()
	installObservabilityPipeline(undefined)
	installSignalPipeline(undefined)
	resetSignalRecording()
	vi.restoreAllMocks()
})

function setup() {
	const logs = new InMemoryLogRecordExporter()
	const logger = new LoggerProvider()
	logger.addLogRecordProcessor(new SimpleLogRecordProcessor(logs))
	const spans = new InMemorySpanExporter()
	const tracer = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", { processor: new SimpleSpanProcessor(spans) })
	const provider = new OpenTelemetryTelemetryProvider(null, logger)
	const histograms: { name: string; value: number; attributes: unknown }[] = []
	const registry = new TelemetryProviderRegistry(
		[
			{
				kind: "registration",
				base: {
					name: "test",
					isEnabled: () => true,
					getSettings: () => ({ hostEnabled: true, level: "all" }),
					forceFlush: async () => {},
					dispose: async () => {
						await tracer.dispose()
						await logger.shutdown()
					},
				},
				sink: { kind: "test", origin: "test", channels: ["runtime"] },
				capabilities: [
					tracer,
					{
						kind: "event",
						log: provider.log.bind(provider),
						logRequired: provider.logRequired.bind(provider),
						identifyUser: () => {},
					},
				],
			},
		],
		{ ready: true, policy: new TelemetryChannelPolicy({ readConsents: () => ({ usage: "disabled", error: "enabled" }) }) },
	)
	const bus = new RuntimeEventBus({ sessionId: "test-session" })
	installSignalPipeline(new RuntimeSignalPipeline(bus))
	installObservabilityPipeline({
		startSpan: (options) => registry.startSpan(options),
		recordHistogram: (name, value, attributes) => histograms.push({ name, value, attributes }),
		recordGauge: () => {},
	})
	cleanup.push(
		() => registry.dispose(),
		() => bus.dispose(),
	)
	return {
		spans,
		logs,
		histograms,
		flush: async () => {
			for (const event of bus.drain())
				forwardRuntimeEvent(event, {
					captureRuntimeEvent: (name, props, severity) =>
						registry.logEvent(name, () => props, false, "runtime", severity),
				})
			await logger.forceFlush()
			await tracer.forceFlush()
		},
	}
}

function handler(send: () => ApiStream, taskId: string, abort?: () => void): ApiHandler {
	return instrumentApiHandler(
		{
			createMessage: send,
			getModel: () => ({ id: "test-model", info: ModelInfo.create({ id: "test-model" }) }),
			...(abort ? { abort } : {}),
		},
		{ profile: ApiProfile.create({ provider: "openai" }), mode: "act", ulid: taskId, requestTimeoutMs: 5000 },
	)
}

function task(taskId: string) {
	const state = createTaskRuntimeState({
		taskId,
		phase: TaskPhase.STREAMING,
		revision: 42,
		anchor: { apiIndex: 3, turnId: "turn-a" },
	})
	const timeline = new TaskTurnTelemetry(
		taskId,
		() => state,
		() => ({ totalTokensIn: 1000, totalTokensOut: 200, cacheUsageAvailable: true }),
	)
	cleanup.push(() => timeline.dispose())
	timeline.committed("API_STARTED", state)
	timeline.snapshot("persisted", { taskId, phase: state.phase, apiIndex: 3, revision: 41, timestamp: Date.now() })
	return { state, timeline }
}

describe("API and Task turn trace correlation", () => {
	it("records task state and usage on error, closes the turn segment and starts a correlated continuation", async () => {
		const env = setup()
		const { timeline } = task("task-a")
		const previous = timeline.currentSpan()!
		const error = Object.assign(new Error("DO_NOT_EXPORT_PROMPT"), { status: 503, code: "unavailable" })
		const api = handler(async function* () {
			emitSignal({ name: "provider.internal", level: "info" })
			yield { type: "usage", inputTokens: 12, outputTokens: 3 }
			await Promise.resolve()
			throw error
		}, "task-a")
		const stream = api.createMessage("SECRET_SYSTEM", [])
		expect((await stream.next()).value).toMatchObject({ type: "usage" })
		await expect(stream.next()).rejects.toBe(error)
		const next = timeline.currentSpan()!
		expect(previous.active).toBe(false)
		expect(next.active).toBe(true)
		expect(next.spanContext?.traceId).toBe(previous.spanContext?.traceId)
		expect(next.spanContext?.spanId).not.toBe(previous.spanContext?.spanId)
		await env.flush()
		const apiSpan = env.spans.getFinishedSpans().find((span) => span.name === "api.request")!
		expect(apiSpan.parentSpanId).toBe(previous.spanContext?.spanId)
		const failure = env.logs.getFinishedLogRecords().find((log) => log.body === "api.request.failed")!
		expect(failure.spanContext?.spanId).toBe(apiSpan.spanContext().spanId)
		expect(failure.attributes).toMatchObject({
			task_revision: 42,
			task_snapshot_durable_revision: 41,
			task_usage_totalTokensIn: 1000,
			api_input_tokens: 12,
			error_status: 503,
			api_request_phase: "streaming",
		})
		expect(apiSpan.events.map((event) => event.name)).toEqual([
			"api.request.started",
			"api.first_chunk",
			"api.usage.received",
			"exception",
			"api.request.failed",
		])
		const turn = env.spans.getFinishedSpans().find((span) => span.name === "task.turn")!
		expect(turn.events.map((event) => event.name)).toContain("task.state.committed")
		expect(turn.events.map((event) => event.name)).toContain("task.snapshot.persisted")
		expect(turn.events.map((event) => event.name)).toContain("task.error")
		const exported = JSON.stringify(env.logs.getFinishedLogRecords().map((log) => log.attributes))
		expect(exported).not.toMatch(/DO_NOT_EXPORT_PROMPT|SECRET_SYSTEM/)
	})

	it("isolates interleaved lazy streams and preserves correlation after delayed drain", async () => {
		const env = setup()
		task("task-a")
		task("task-b")
		const send = async function* (): ApiStream {
			await Promise.resolve()
			emitSignal({ name: "inside", level: "info" })
			yield { type: "text", text: "private" }
		}
		const streams = [handler(send, "task-a").createMessage("", []), handler(send, "task-b").createMessage("", [])]
		await Promise.all(streams.map((stream) => stream.next()))
		await Promise.all(streams.map((stream) => stream.next()))
		await env.flush()
		const ids = env.spans
			.getFinishedSpans()
			.filter((span) => span.name === "api.request")
			.map((span) => span.spanContext().traceId)
		expect(new Set(ids).size).toBe(2)
		expect(
			env.logs
				.getFinishedLogRecords()
				.filter((log) => log.body === "inside")
				.map((log) => log.spanContext?.traceId)
				.sort(),
		).toEqual(ids.sort())
	})

	it("records pre-first-chunk errors and marks unavailable usage rather than zero", async () => {
		const env = setup()
		const error = Object.assign(new Error("private"), { status: 401 })
		const api = handler(async function* () {
			throw error
		}, "no-task")
		await expect(api.createMessage("", []).next()).rejects.toBe(error)
		await env.flush()
		const log = env.logs.getFinishedLogRecords().find((entry) => entry.body === "api.request.failed")!
		expect(log.attributes).toMatchObject({
			api_request_phase: "awaiting_first_chunk",
			api_usage_seen: false,
			task_state_available: false,
			task_usage_available: false,
			error_status: 401,
		})
		expect(log.attributes.api_input_tokens).toBeUndefined()
	})

	it("closes on consumer return without recording failure and does not start unconsumed streams", async () => {
		const env = setup()
		let closed = false
		const api = handler(async function* () {
			try {
				yield { type: "text", text: "private" }
			} finally {
				closed = true
			}
		}, "no-task")
		await api.createMessage("", []).return(undefined)
		expect(env.spans.getFinishedSpans()).toHaveLength(0)
		const stream = api.createMessage("", [])
		await stream.next()
		await stream.return(undefined)
		await stream.return(undefined)
		await env.flush()
		expect(closed).toBe(true)
		expect(env.logs.getFinishedLogRecords().filter((log) => log.body === "api.request.cancelled")).toHaveLength(1)
		expect(env.logs.getFinishedLogRecords().filter((log) => log.body === "api.request.failed")).toHaveLength(0)
		expect(env.histograms).toHaveLength(1)
	})

	it("does not record when diagnostics consent is disabled", async () => {
		const env = setup()
		configureSignalRecording({ enabled: () => false })
		const api = handler(async function* () {
			yield { type: "text", text: "ok" }
		}, "task-a")
		for await (const _chunk of api.createMessage("", [])) {
			/* drain */
		}
		await env.flush()
		expect(env.spans.getFinishedSpans()).toHaveLength(0)
		expect(env.logs.getFinishedLogRecords()).toHaveLength(0)
	})
})
