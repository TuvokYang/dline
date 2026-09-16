import fs from "node:fs/promises"
import path from "node:path"
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLocalJournalRegistration, LocalJournalProvider } from "../journal/LocalJournalProvider"
import type { TelemetryProviderRegistration } from "../providers/capabilities"
import { OpenTelemetryTelemetryProvider } from "../providers/opentelemetry/OpenTelemetryTelemetryProvider"
import { OpenTelemetryTraceProvider } from "../providers/opentelemetry/OpenTelemetryTraceProvider"
import { forwardRuntimeEvent } from "../runtime/provider-event-bridge"
import { RuntimeEventBus } from "../runtime/runtime-event-bus"
import { RuntimeEventPriority } from "../runtime/types"
import { TelemetryChannelPolicy } from "./channel-policy"
import { runWithSignalSpan } from "./pipeline-port"
import { TelemetryProviderRegistry } from "./provider-registry"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
	vi.unstubAllEnvs()
})

function setup(ready = true, allowed = true) {
	const logs = new InMemoryLogRecordExporter()
	const logger = new LoggerProvider()
	logger.addLogRecordProcessor(new SimpleLogRecordProcessor(logs))
	const spans = new InMemorySpanExporter()
	const tracer = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", { processor: new SimpleSpanProcessor(spans) })
	const provider = new OpenTelemetryTelemetryProvider(null, logger)
	const registration: TelemetryProviderRegistration = {
		kind: "registration",
		base: {
			name: "test-otel",
			isEnabled: () => true,
			getSettings: () => ({ hostEnabled: true, level: "all" }),
			forceFlush: async () => {
				await logger.forceFlush()
				await tracer.forceFlush()
			},
			dispose: async () => {
				await tracer.dispose()
				await logger.shutdown()
			},
		},
		sink: { kind: "loopback", origin: "default", channels: ["runtime"] },
		capabilities: [
			tracer,
			{
				kind: "event",
				log: provider.log.bind(provider),
				logRequired: provider.logRequired.bind(provider),
				identifyUser: () => {},
			},
		],
	}
	const registry = new TelemetryProviderRegistry(ready ? [registration] : [], {
		ready,
		policy: new TelemetryChannelPolicy({
			readConsents: () => ({ usage: "disabled", error: allowed ? "enabled" : "disabled" }),
		}),
	})
	cleanup.push(() => registry.dispose())
	return { registry, logs, spans, registration }
}

describe("trace delivery through the production registry", () => {
	it("keeps journal, exported spans and delayed runtime logs on the same identity", async () => {
		vi.stubEnv("IS_DEV", "true")
		const { registry, logs, spans, registration } = setup()
		const base = path.join(process.cwd(), "tmp")
		await fs.mkdir(base, { recursive: true })
		const directory = await fs.mkdtemp(path.join(base, "otel-correlation-"))
		const journal = await LocalJournalProvider.create({ directory, sessionId: "test-session" })
		cleanup.unshift(() => fs.rm(directory, { recursive: true, force: true }))
		registry.add(createLocalJournalRegistration(journal))
		const bus = new RuntimeEventBus({ sessionId: "test-session" })
		const parent = registry.startSpan({ name: "parent", attributes: { task_id: "task-a" } })
		await runWithSignalSpan(parent, async () => {
			await Promise.resolve()
			const child = registry.startSpan({ name: "child" })
			runWithSignalSpan(child, () => bus.record({ name: "inside-child", priority: RuntimeEventPriority.Error }))
			child.end("failure")
		})
		parent.end()
		for (const event of bus.drain())
			forwardRuntimeEvent(event, {
				captureRuntimeEvent: (name, properties, severity) =>
					registry.logEvent(name, () => properties, false, "runtime", severity),
			})
		await registration.base.forceFlush()
		await journal.forceFlush()
		const parentRecord = spans.getFinishedSpans().find((span) => span.name === "parent")
		const childRecord = spans.getFinishedSpans().find((span) => span.name === "child")
		expect(parentRecord).toBeDefined()
		expect(childRecord).toBeDefined()
		if (!parentRecord || !childRecord) throw new Error("missing exported parent/child span")
		expect(childRecord.parentSpanId).toBe(parentRecord.spanContext().spanId)
		expect(logs.getFinishedLogRecords()[0].spanContext).toEqual({
			traceId: childRecord.spanContext().traceId,
			spanId: childRecord.spanContext().spanId,
			traceFlags: childRecord.spanContext().traceFlags,
		})
		expect(logs.getFinishedLogRecords()[0].attributes.taskId).toBe("task-a")
		const traceLines = (await fs.readFile(journal.paths.traces, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		const mirror = traceLines
			.flatMap((line) => line.resourceSpans[0].scopeSpans[0].spans)
			.find((span) => span.name === "child")
		expect(mirror.traceId).toBe(childRecord.spanContext().traceId)
		expect(mirror.spanId).toBe(childRecord.spanContext().spanId)
		expect(mirror.parentSpanId).toBe(parentRecord.spanContext().spanId)
		bus.dispose()
	})

	it("replays deferred parent/child spans with their original start and end times", async () => {
		const { registry, spans, registration } = setup(false)
		const parent = registry.startSpan({ name: "parent", startTime: 1_789_000_000_000 })
		const child = registry.startSpan({ name: "child", parent, startTime: 1_789_000_000_010 })
		child.end("failure", 1_789_000_000_020)
		registry.add(registration)
		registry.markReady()
		parent.end("success", 1_789_000_000_030)
		await registration.base.forceFlush()
		const [childRecord, parentRecord] = spans.getFinishedSpans()
		expect(childRecord.parentSpanId).toBe(parentRecord.spanContext().spanId)
		expect(childRecord.duration).toEqual([0, 10_000_000])
		expect(parentRecord.duration).toEqual([0, 30_000_000])
	})

	it("does not export spans or logs when error consent is disabled, even in development", async () => {
		vi.stubEnv("IS_DEV", "true")
		const { registry, spans, logs, registration } = setup(false, false)
		registry.startSpan({ name: "denied", attributes: { task_id: "task-a" } }).end()
		registry.logEvent("denied", () => ({ taskId: "task-a" }), true, "runtime", "error")
		registry.add(registration)
		registry.markReady()
		await registration.base.forceFlush()
		expect(spans.getFinishedSpans()).toHaveLength(0)
		expect(logs.getFinishedLogRecords()).toHaveLength(0)
	})
})
