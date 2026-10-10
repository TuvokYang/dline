import { SeverityNumber } from "@opentelemetry/api-logs"
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions/incubating"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetSharedLoggerProviderForTesting } from "@/services/telemetry/otel/shared-logger-provider"
import { TELEMETRY_MASK_VALUE } from "../../content-policy"
import { EXCEPTION_ATTRIBUTE_KEYS, RUNTIME_ATTRIBUTE_KEYS, RUNTIME_SCOPE_NAME } from "../../otel-semantics"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../../types"
import { OtelLogTransport } from "../otel-log-transport"

/**
 * The transport's job is to hand events to the OpenTelemetry SDK in the shape
 * the specification defines. Its predecessor posted a private JSON body to a
 * standard-looking path, which passed its own tests while being unreadable to
 * every collector, so these assertions inspect the emitted log records rather
 * than the bytes on the wire.
 */

const SESSION_ID = "session-under-test"

function event(overrides: Partial<RuntimeTelemetryEvent> = {}): RuntimeTelemetryEvent {
    return {
        eventId: "event-1",
        sequence: 1,
        timestamp: 1_700_000_000_000,
        monotonicMs: 12,
        name: "task.phase",
        priority: RuntimeEventPriority.Info,
        context: { sessionId: SESSION_ID },
        attributes: { durationMs: 5 },
        ...overrides,
    }
}

describe("OtelLogTransport", () => {
    let exporter: InMemoryLogRecordExporter
    let transport: OtelLogTransport

    beforeEach(() => {
        // The provider is process-wide, so a provider left behind by an
        // earlier test would keep this one's records flowing to a stale
        // exporter and make the assertions describe the wrong run.
        resetSharedLoggerProviderForTesting()
        exporter = new InMemoryLogRecordExporter()
        transport = new OtelLogTransport({
            sessionId: SESSION_ID,
            processorFactory: () => new SimpleLogRecordProcessor(exporter),
        })
    })

    afterEach(() => {
        resetSharedLoggerProviderForTesting()
    })

    it("emits one log record per event", () => {
        transport.enqueue(event())
        transport.enqueue(event({ sequence: 2, eventId: "event-2" }))

        expect(exporter.getFinishedLogRecords()).toHaveLength(2)
        expect(transport.stats.sentEvents).toBe(2)
    })

    it("puts the event name in the body so collectors can group by it", () => {
        transport.enqueue(event({ name: "terminal.execute" }))

        expect(exporter.getFinishedLogRecords()[0].body).toBe("terminal.execute")
    })

    it("translates priority into the standard severity scale", () => {
        transport.enqueue(event({ priority: RuntimeEventPriority.Invariant }))

        const [record] = exporter.getFinishedLogRecords()
        expect(record.severityNumber).toBe(SeverityNumber.FATAL)
        expect(record.severityText).toBe("FATAL")
    })

    it("identifies the host run on the resource rather than on every record", () => {
        transport.enqueue(event())

        const [record] = exporter.getFinishedLogRecords()
        expect(record.resource.attributes[ATTR_SERVICE_INSTANCE_ID]).toBe(SESSION_ID)
        // service.name is required by OTLP; a backend cannot attribute records
        // without it, so an empty value is as broken as a missing one.
        expect(record.resource.attributes[ATTR_SERVICE_NAME]).toBe("dline")
        expect(record.attributes).not.toHaveProperty("sessionId")
    })

    it("uses a scope that separates runtime diagnostics from product analytics", () => {
        transport.enqueue(event())

        expect(exporter.getFinishedLogRecords()[0].instrumentationScope.name).toBe(RUNTIME_SCOPE_NAME)
    })

    it("keeps producer attributes and publishes ordering data under the dline prefix", () => {
        transport.enqueue(event({ attributes: { durationMs: 42, outcome: "success" }, sequence: 7 }))

        const { attributes } = exporter.getFinishedLogRecords()[0]
        expect(attributes.durationMs).toBe(42)
        expect(attributes.outcome).toBe("success")
        expect(attributes[RUNTIME_ATTRIBUTE_KEYS.sequence]).toBe(7)
    })

    it("keeps exception type and fingerprint while masking message content", () => {
        transport.enqueue(
            event({
                error: { name: "AxiosError", message: "timeout", fingerprint: "abc123" },
            }),
        )

        const { attributes } = exporter.getFinishedLogRecords()[0]
        expect(attributes[EXCEPTION_ATTRIBUTE_KEYS.type]).toBe("AxiosError")
        expect(attributes[EXCEPTION_ATTRIBUTE_KEYS.message]).toBe(TELEMETRY_MASK_VALUE)
        expect(attributes[EXCEPTION_ATTRIBUTE_KEYS.fingerprint]).toBe("abc123")
    })

    it("stops emitting after disposal", async () => {
        await transport.dispose()
        transport.enqueue(event())

        expect(exporter.getFinishedLogRecords()).toHaveLength(0)
        expect(transport.stats.droppedEvents).toBe(1)
    })

    it("does not reject when flushing without a collector", async () => {
        transport.enqueue(event())

        await expect(transport.flush()).resolves.toBeUndefined()
    })
})

describe("OtelLogTransport without a usable exporter", () => {
    /**
     * A collector endpoint can be missing or malformed. Telemetry then degrades
     * to the journal alone; it must not throw during activation or make a
     * producer fail.
     */
    it("counts events as dropped instead of throwing", async () => {
        resetSharedLoggerProviderForTesting()
        const transport = new OtelLogTransport({
            sessionId: SESSION_ID,
            processorFactory: () => undefined,
        })

        expect(() => transport.enqueue(event())).not.toThrow()
        expect(transport.stats.droppedEvents).toBe(1)
        await expect(transport.flush()).resolves.toBeUndefined()
        await expect(transport.dispose()).resolves.toBeUndefined()
    })
})
