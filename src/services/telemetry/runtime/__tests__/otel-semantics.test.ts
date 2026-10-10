import { SeverityNumber } from "@opentelemetry/api-logs"
import { describe, expect, it } from "vitest"
import { TELEMETRY_MASK_VALUE } from "../content-policy"
import {
    EXCEPTION_ATTRIBUTE_KEYS,
    fromSeverityNumber,
    RUNTIME_ATTRIBUTE_KEYS,
    toAnyValue,
    toLogAttributes,
    toOtlpLogRecord,
    toSeverityNumber,
    toUnixNano,
} from "../otel-semantics"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../types"

/**
 * These tests pin the properties that decide whether an unmodified collector
 * can read what Dline emits. The previous transport passed its own tests while
 * producing a payload no OTLP receiver understood, so the assertions here
 * describe the specification rather than the implementation.
 */

function event(overrides: Partial<RuntimeTelemetryEvent> = {}): RuntimeTelemetryEvent {
    return {
        eventId: "event-1",
        sequence: 42,
        timestamp: 1_700_000_000_000,
        monotonicMs: 1234.5,
        name: "terminal.execute",
        priority: RuntimeEventPriority.Info,
        context: { sessionId: "session-under-test" },
        attributes: { durationMs: 17, outcome: "success" },
        ...overrides,
    }
}

describe("severity mapping", () => {
    it("maps every priority onto the standard severity scale", () => {
        expect(toSeverityNumber(RuntimeEventPriority.Debug)).toBe(SeverityNumber.DEBUG)
        expect(toSeverityNumber(RuntimeEventPriority.Info)).toBe(SeverityNumber.INFO)
        expect(toSeverityNumber(RuntimeEventPriority.Performance)).toBe(SeverityNumber.INFO)
        expect(toSeverityNumber(RuntimeEventPriority.PerformanceAnomaly)).toBe(SeverityNumber.WARN)
        expect(toSeverityNumber(RuntimeEventPriority.Error)).toBe(SeverityNumber.ERROR)
        expect(toSeverityNumber(RuntimeEventPriority.Invariant)).toBe(SeverityNumber.FATAL)
    })

    it("round-trips priority so eviction can still rank translated records", () => {
        const priorities = [
            RuntimeEventPriority.Debug,
            RuntimeEventPriority.Info,
            RuntimeEventPriority.PerformanceAnomaly,
            RuntimeEventPriority.Error,
            RuntimeEventPriority.Invariant,
        ]
        for (const priority of priorities) {
            expect(fromSeverityNumber(toSeverityNumber(priority))).toBe(priority)
        }
    })

    it("maps ordinary performance samples to INFO while preserving WARN for anomalies", () => {
        expect(fromSeverityNumber(toSeverityNumber(RuntimeEventPriority.PerformanceSample))).toBe(RuntimeEventPriority.Info)
        expect(fromSeverityNumber(toSeverityNumber(RuntimeEventPriority.PerformanceAnomaly))).toBe(
            RuntimeEventPriority.PerformanceAnomaly,
        )
    })

    it("ranks severities that fall between the named levels", () => {
        // Collectors may forward INFO2/INFO3; they must not degrade to DEBUG.
        expect(fromSeverityNumber(SeverityNumber.INFO2)).toBe(RuntimeEventPriority.Info)
        expect(fromSeverityNumber(SeverityNumber.ERROR3)).toBe(RuntimeEventPriority.Error)
    })
})

describe("timestamp encoding", () => {
    it("converts milliseconds to nanoseconds", () => {
        expect(toUnixNano(1_700_000_000_000)).toBe(1_700_000_000_000_000_000n)
    })

    it("emits nanoseconds as a string because the value exceeds Number.MAX_SAFE_INTEGER", () => {
        const record = toOtlpLogRecord(event())

        expect(typeof record.timeUnixNano).toBe("string")
        expect(record.timeUnixNano).toBe("1700000000000000000")
        // Proof the guard is needed rather than defensive habit.
        expect(Number(record.timeUnixNano)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
    })
})

describe("attribute value boxing", () => {
    it("boxes each scalar into its OTLP union member", () => {
        expect(toAnyValue("text")).toEqual({ stringValue: "text" })
        expect(toAnyValue(true)).toEqual({ boolValue: true })
        expect(toAnyValue(17)).toEqual({ intValue: "17" })
        expect(toAnyValue(1.5)).toEqual({ doubleValue: 1.5 })
    })
})

describe("attribute mapping", () => {
    it("keeps producer attributes and adds ordering data under the dline prefix", () => {
        const attributes = toLogAttributes(event())

        expect(attributes.durationMs).toBe(17)
        expect(attributes.outcome).toBe("success")
        expect(attributes[RUNTIME_ATTRIBUTE_KEYS.sequence]).toBe(42)
        expect(attributes[RUNTIME_ATTRIBUTE_KEYS.eventId]).toBe("event-1")
    })

    it("omits the session id because it belongs to the resource", () => {
        const attributes = toLogAttributes(event())

        expect(Object.values(attributes)).not.toContain("session-under-test")
    })

    it("omits identity fields the event did not carry", () => {
        const attributes = toLogAttributes(event())

        expect(attributes).not.toHaveProperty(RUNTIME_ATTRIBUTE_KEYS.taskId)
        expect(attributes).not.toHaveProperty(RUNTIME_ATTRIBUTE_KEYS.workspaceId)
    })

    it("publishes masked identity fields when present", () => {
        const attributes = toLogAttributes(event({ context: { sessionId: "s", taskId: "task-7" } }))

        expect(attributes[RUNTIME_ATTRIBUTE_KEYS.taskId]).toBe(TELEMETRY_MASK_VALUE)
    })

    it("maps errors onto the exception semantic conventions", () => {
        const attributes = toLogAttributes(
            event({
                error: {
                    name: "AxiosError",
                    message: "timeout",
                    code: "ECONNABORTED",
                    status: 504,
                    sourceFrame: "src/api/provider.ts:42",
                    fingerprint: "abc123",
                },
            }),
        )

        expect(attributes[EXCEPTION_ATTRIBUTE_KEYS.type]).toBe("AxiosError")
        expect(attributes[EXCEPTION_ATTRIBUTE_KEYS.message]).toBe(TELEMETRY_MASK_VALUE)
        expect(attributes[EXCEPTION_ATTRIBUTE_KEYS.stacktrace]).toBe("src/api/provider.ts:42")
    })
})

describe("log record shape", () => {
    it("carries the event name in the body so collectors can group by it", () => {
        const record = toOtlpLogRecord(event())

        expect(record.body).toEqual({ stringValue: "terminal.execute" })
        expect(record.severityText).toBe("INFO")
        expect(record.severityNumber).toBe(SeverityNumber.INFO)
    })

    it("observes and records the same instant because the bus stamps on admission", () => {
        const record = toOtlpLogRecord(event())

        expect(record.observedTimeUnixNano).toBe(record.timeUnixNano)
    })

    it("emits attributes as key/value pairs rather than a plain object", () => {
        const record = toOtlpLogRecord(event())
        const sequence = record.attributes.find((entry) => entry.key === RUNTIME_ATTRIBUTE_KEYS.sequence)

        expect(sequence?.value).toEqual({ intValue: "42" })
    })
})
