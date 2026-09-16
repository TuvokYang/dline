import { SpanStatusCode } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RuntimeEventBus } from "../../../runtime/runtime-event-bus"
import { RuntimeEventPriority } from "../../../runtime/types"
import { runWithSignalSpan } from "../../../service/pipeline-port"
import { OpenTelemetryTraceProvider } from "../OpenTelemetryTraceProvider"

const providers: OpenTelemetryTraceProvider[] = []

afterEach(async () => {
	await Promise.all(providers.splice(0).map((provider) => provider.dispose()))
})

describe("OpenTelemetryTraceProvider", () => {
	it("creates real spans with attributes, status, and exceptions", async () => {
		const exporter = new InMemorySpanExporter()
		const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
			processor: new SimpleSpanProcessor(exporter),
		})
		providers.push(provider)

		const span = provider.startSpan({ name: "tool.execution", attributes: { tool: "read_file" } })
		span.recordException(new Error("failed"))
		span.end("failure")
		await provider.forceFlush()

		const [record] = exporter.getFinishedSpans()
		expect(record.name).toBe("tool.execution")
		expect(record.attributes).toMatchObject({ tool: "read_file", outcome: "failure" })
		expect(record.status.code).toBe(SpanStatusCode.ERROR)
		expect(record.events[0]?.name).toBe("exception")
	})

	it("marks cancelled operations without losing the span", async () => {
		const exporter = new InMemorySpanExporter()
		const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
			processor: new SimpleSpanProcessor(exporter),
		})
		providers.push(provider)

		provider.startSpan({ name: "tool.wait_for_approval" }).end("cancelled")
		await provider.forceFlush()

		const [record] = exporter.getFinishedSpans()
		expect(record.attributes.outcome).toBe("cancelled")
		expect(record.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "cancelled" })
	})

	it("preserves explicit parent-child relationships", async () => {
		const exporter = new InMemorySpanExporter()
		const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
			processor: new SimpleSpanProcessor(exporter),
		})
		providers.push(provider)

		const parent = provider.startSpan({ name: "task.execute" })
		const child = provider.startSpan({ name: "tool.execution", parent })
		child.end("success")
		parent.end("success")
		await provider.forceFlush()

		const records = exporter.getFinishedSpans()
		const parentRecord = records.find((record) => record.name === "task.execute")
		const childRecord = records.find((record) => record.name === "tool.execution")
		expect(childRecord?.parentSpanId).toBe(parentRecord?.spanContext().spanId)
	})

	it("keeps concurrent async task spans separate and captures log context before drain", async () => {
		const exporter = new InMemorySpanExporter()
		const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
			processor: new SimpleSpanProcessor(exporter),
		})
		providers.push(provider)
		const bus = new RuntimeEventBus()
		await Promise.all(
			["task-a", "task-b"].map(async (taskId) => {
				const parent = provider.startSpan({ name: taskId, attributes: { task_id: taskId } })
				await runWithSignalSpan(parent, async () => {
					await Promise.resolve()
					const child = provider.startSpan({ name: `${taskId}.child` })
					bus.record({ name: taskId, priority: RuntimeEventPriority.Info })
					child.end()
				})
				parent.end()
				expect(parent.active).toBe(false)
			}),
		)
		await provider.forceFlush()
		const records = exporter.getFinishedSpans()
		for (const event of bus.drain()) {
			const parent = records.find((record) => record.name === event.name)
			const child = records.find((record) => record.name === `${event.name}.child`)
			expect(parent).toBeDefined()
			expect(child).toBeDefined()
			if (!parent || !child) throw new Error(`missing spans for ${event.name}`)
			expect(event.traceContext).toMatchObject(parent.spanContext())
			expect(event.context.taskId).toBe(event.name)
			expect(child.parentSpanId).toBe(parent.spanContext().spanId)
		}
		bus.dispose()
	})

	it("masks trace attributes and exception prose, preserving only development task IDs", async () => {
		vi.stubEnv("IS_DEV", "true")
		try {
			const exporter = new InMemorySpanExporter()
			const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
				processor: new SimpleSpanProcessor(exporter),
			})
			providers.push(provider)
			const span = provider.startSpan({ name: "safe", attributes: { task_id: "task-a", prompt: "private prompt" } })
			span.setAttribute("authorization", "Bearer private-credential")
			span.recordException(new Error("private exception prose"))
			span.end("failure")
			span.end("success")
			await provider.forceFlush()
			const records = exporter.getFinishedSpans()
			expect(records).toHaveLength(1)
			expect(records[0].attributes).toMatchObject({
				task_id: "task-a",
				prompt: "*****",
				authorization: "*****",
				outcome: "failure",
			})
			expect(JSON.stringify(records[0].events)).not.toContain("private")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("ends unfinished spans as interrupted before exporter shutdown", async () => {
		const completed: string[] = []
		const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
			processor: {
				onStart() {},
				onEnd(span) {
					completed.push(String(span.attributes.outcome))
					expect(span.attributes.interrupted).toBe(true)
				},
				forceFlush: async () => {},
				shutdown: async () => {
					expect(completed).toEqual(["cancelled"])
				},
			},
		})
		const span = provider.startSpan({ name: "unfinished" })
		await provider.dispose()
		expect(span.active).toBe(false)
		span.end()
		expect(completed).toEqual(["cancelled"])
	})

	it.skipIf(process.env.DLINE_LIVE_OTEL_TEST !== "1")(
		"exports a live canary through the production OTLP trace provider",
		async () => {
			const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318")
			providers.push(provider)

			provider
				.startSpan({
					name: "ws065.live.trace.canary",
					attributes: { workstream: "WS-065", verification: "live-tempo" },
				})
				.end("success")
			await provider.forceFlush()
		},
	)
})
