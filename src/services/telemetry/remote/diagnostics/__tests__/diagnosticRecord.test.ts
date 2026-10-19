import { describe, expect, it } from "vitest"
import type { JournalTelemetrySignal } from "../../../providers/capabilities"
import { type DiagnosticRecord, encodeDiagnosticLogs, toDiagnosticRecord } from "../diagnosticRecord"

const NOW = 1_800_000_000_123

function event(overrides: Partial<Extract<JournalTelemetrySignal, { kind: "event" }>> = {}): JournalTelemetrySignal {
    return {
        kind: "event",
        channel: "error",
        severity: "error",
        name: "task.provider_api_error",
        properties: {},
        required: false,
        ...overrides,
    }
}

interface EncodedAttribute {
    key: string
    value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean }
}

function decode(body: string) {
    const request = JSON.parse(body) as {
        resourceLogs: {
            resource: { attributes: EncodedAttribute[] }
            scopeLogs: {
                scope: { name: string }
                logRecords: {
                    timeUnixNano: string
                    severityNumber: number
                    severityText: string
                    attributes: EncodedAttribute[]
                }[]
            }[]
        }[]
    }
    const [resourceLogs] = request.resourceLogs
    return { resource: resourceLogs.resource.attributes, scope: resourceLogs.scopeLogs[0] }
}

describe("toDiagnosticRecord", () => {
    it("sends only error and runtime events at warn or above with a name the service accepts", () => {
        expect(toDiagnosticRecord(event(), NOW)?.name).toBe("task.provider_api_error")
        expect(toDiagnosticRecord(event({ channel: "runtime", severity: "warn" }), NOW)?.channel).toBe("runtime")
        expect(toDiagnosticRecord(event({ channel: "usage" }), NOW)).toBeUndefined()
        expect(toDiagnosticRecord(event({ channel: "account" }), NOW)).toBeUndefined()
        expect(toDiagnosticRecord(event({ severity: "info" }), NOW)).toBeUndefined()
        expect(toDiagnosticRecord(event({ severity: "debug" }), NOW)).toBeUndefined()
        expect(toDiagnosticRecord(event({ name: "task failed at C:\\work" }), NOW)).toBeUndefined()
        const metric: JournalTelemetrySignal = {
            kind: "metric",
            channel: "error",
            severity: "error",
            instrument: "counter",
            name: "dline.errors",
            value: 1,
        } as JournalTelemetrySignal
        expect(toDiagnosticRecord(metric, NOW)).toBeUndefined()
    })

    it("keeps short tokens, numbers and booleans and drops free text, locations and identity", () => {
        const record = toDiagnosticRecord(
            event({
                properties: {
                    provider: "anthropic",
                    model: "claude-sonnet-4.5",
                    status: 429,
                    retryable: true,
                    latencyMs: 12.5,
                    errorCode: "rate_limited",
                    errorMessage: "quota",
                    reason: "The request failed because the key expired",
                    taskId: "01JABCDEF",
                    workspaceRoot: "repo",
                    filePath: "src",
                    apiKey: "sk-123",
                    endpoint: "https://api.example.com/v1",
                    contact: "someone@example.com",
                    nested: { provider: "x" },
                    infinite: Number.POSITIVE_INFINITY,
                },
            }),
            NOW,
        )
        expect(record?.attributes).toEqual({
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            status: 429,
            retryable: true,
            latencyMs: 12.5,
            errorCode: "rate_limited",
        })
    })

    it("stops at 32 attributes", () => {
        const properties = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`count${index}`, index]))
        expect(Object.keys(toDiagnosticRecord(event({ properties }), NOW)?.attributes ?? {})).toHaveLength(32)
    })
})

describe("encodeDiagnosticLogs", () => {
    it("encodes an OTLP logs request whose resource names the client but not the device", () => {
        const records: DiagnosticRecord[] = [
            {
                timeUnixMs: NOW,
                name: "task.terminal_hang",
                channel: "error",
                severity: "warn",
                attributes: { count: 2, ratio: 0.5, retryable: false, shell: "pwsh" },
            },
            { timeUnixMs: NOW + 1, name: "runtime.crash", channel: "runtime", severity: "fatal", attributes: {} },
        ]
        const { resource, scope } = decode(encodeDiagnosticLogs(records, { clientVersion: "0.11.0", platform: "win32" }))

        expect(resource).toEqual([
            { key: "service.name", value: { stringValue: "dline" } },
            { key: "service.version", value: { stringValue: "0.11.0" } },
            { key: "os.type", value: { stringValue: "win32" } },
        ])
        expect(scope.scope.name).toBe("dline.diagnostics")
        const [first, second] = scope.logRecords
        expect(first.timeUnixNano).toBe(`${NOW}000000`)
        expect([first.severityNumber, second.severityNumber]).toEqual([13, 21])
        expect(first.attributes).toEqual([
            { key: "event.name", value: { stringValue: "task.terminal_hang" } },
            { key: "dline.channel", value: { stringValue: "error" } },
            { key: "count", value: { intValue: "2" } },
            { key: "ratio", value: { doubleValue: 0.5 } },
            { key: "retryable", value: { boolValue: false } },
            { key: "shell", value: { stringValue: "pwsh" } },
        ])
        expect(second.attributes.find((attribute) => attribute.key === "dline.channel")?.value.stringValue).toBe("runtime")
    })
})
