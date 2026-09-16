import { SeverityNumber } from "@opentelemetry/api-logs"
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getProcessTelemetrySessionId } from "../../../journal/session-identity"
import { createTelemetryResource } from "../../../otel/telemetry-resource"
import { RuntimeEventBus } from "../../../runtime/runtime-event-bus"
import { drainBootstrapSignalsInto } from "../../../runtime/signal-pipeline"
import { discardBootstrapSignals, emitSignal, installSignalPipeline } from "../../../service/pipeline-port"
import { OpenTelemetryTelemetryProvider } from "../OpenTelemetryTelemetryProvider"

const owners: LoggerProvider[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.shutdown()))
	discardBootstrapSignals()
	installSignalPipeline(undefined)
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

function setup() {
	const exporter = new InMemoryLogRecordExporter()
	const owner = new LoggerProvider({ resource: createTelemetryResource() })
	owner.addLogRecordProcessor(new SimpleLogRecordProcessor(exporter))
	owners.push(owner)
	return { exporter, owner, provider: new OpenTelemetryTelemetryProvider(null, owner) }
}

describe("OTel recording semantics", () => {
	it.each([
		["debug", SeverityNumber.DEBUG],
		["info", SeverityNumber.INFO],
		["warn", SeverityNumber.WARN],
		["error", SeverityNumber.ERROR],
		["fatal", SeverityNumber.FATAL],
	] as const)("exports %s with occurrence time rather than drain time", async (severity, number) => {
		const { provider, owner, exporter } = setup()
		provider.log("runtime.sample", { telemetry_severity: severity, runtime_timestamp_ms: 1_789_000_000_123 })
		await owner.forceFlush()
		const [record] = exporter.getFinishedLogRecords()
		expect(record.severityNumber).toBe(number)
		expect(record.severityText).toBe(severity.toUpperCase())
		expect(record.hrTime).toEqual([1_789_000_000, 123_000_000])
	})

	it("uses one session and process resource by default", () => {
		const first = createTelemetryResource().attributes
		const second = createTelemetryResource().attributes
		expect(first["service.instance.id"]).toBe(getProcessTelemetrySessionId())
		expect(first["process.pid"]).toBe(process.pid)
		expect(second).toEqual(first)
	})

	it("retains the producer timestamp through bootstrap replay", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_789_000_000_123)
		emitSignal({ name: "activation.start", level: "info" })
		vi.setSystemTime(1_789_000_010_123)
		const bus = new RuntimeEventBus({ sessionId: "test" })
		drainBootstrapSignalsInto(bus, true)
		expect(bus.peek()[0]?.timestamp).toBe(1_789_000_000_123)
		bus.dispose()
	})

	it.each(["true", "false"])("preserves only dev task identity (IS_DEV=%s)", async (isDev) => {
		vi.stubEnv("IS_DEV", isDev)
		const { provider, owner, exporter } = setup()
		provider.logRequired("runtime.task", {
			taskId: "1789103589532",
			controllerId: "private-controller",
			workspaceId: "private-workspace",
			prompt: "private prompt",
			apiKey: "private key",
			telemetry_severity: "error",
		})
		await owner.forceFlush()
		const [record] = exporter.getFinishedLogRecords()
		expect(record.attributes.taskId).toBe(isDev === "true" ? "1789103589532" : "*****")
		expect(record.attributes).toMatchObject({ controllerId: "*****", workspaceId: "*****", prompt: "*****", apiKey: "*****" })
		expect(record.severityNumber).toBe(SeverityNumber.ERROR)
	})
})
