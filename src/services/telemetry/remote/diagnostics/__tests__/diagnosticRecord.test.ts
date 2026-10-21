import { describe, expect, it } from "vitest"
import type { JournalTelemetrySignal } from "../../../providers/capabilities"
import { hostEditorOf, releaseChannelOf } from "../../clientIdentity"
import {
    aggregateDiagnostics,
    DIAGNOSTIC_ATTRIBUTE_KEYS,
    type DiagnosticRecord,
    encodeDiagnosticLogs,
    toDiagnosticRecord,
} from "../diagnosticRecord"

const NOW = 1_800_000_000_123
const FINGERPRINT = "0123456789abcdef"

type EventSignal = Extract<JournalTelemetrySignal, { kind: "event" }>

function event(overrides: Partial<EventSignal> = {}): JournalTelemetrySignal {
    return {
        kind: "event",
        channel: "error",
        severity: "error",
        name: "api.request.failed",
        properties: {},
        required: false,
        ...overrides,
    }
}

function record(properties: NonNullable<EventSignal["properties"]>, at = NOW): DiagnosticRecord {
    const result = toDiagnosticRecord(event({ properties }), at)
    if (!result) throw new Error("expected a record")
    return result
}

interface EncodedAttribute {
    key: string
    value: { stringValue?: string; intValue?: string; boolValue?: boolean }
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
                    body: { stringValue: string }
                    attributes: EncodedAttribute[]
                }[]
            }[]
        }[]
    }
    const [resourceLogs] = request.resourceLogs
    return { resource: resourceLogs.resource.attributes, scope: resourceLogs.scopeLogs[0] }
}

describe("toDiagnosticRecord (contract v2.1 §3.1-§3.2)", () => {
    it("sends only error and runtime events at warn or above with a name the service accepts", () => {
        expect(toDiagnosticRecord(event(), NOW)?.name).toBe("api.request.failed")
        expect(toDiagnosticRecord(event({ channel: "runtime", severity: "warn" }), NOW)?.channel).toBe("runtime")
        expect(toDiagnosticRecord(event({ channel: "usage" }), NOW)).toBeUndefined()
        expect(toDiagnosticRecord(event({ severity: "info" }), NOW)).toBeUndefined()
        expect(toDiagnosticRecord(event({ name: "task failed at C:\\work" }), NOW)).toBeUndefined()
    })

    it("sends only events the route table declares remote, so a projection of a failure stays local (WS-109 SC-1)", () => {
        const remote = (name: string, channel: "error" | "runtime" = "runtime", severity: "warn" | "error" = "error") =>
            toDiagnosticRecord(event({ name, channel, severity }), NOW)?.name

        expect(remote("api.request.failed", "error")).toBe("api.request.failed")
        expect(remote("tool.execution.failed", "error")).toBe("tool.execution.failed")
        expect(remote("task.terminal_hang", "error", "warn")).toBe("task.terminal_hang")
        expect(remote("runtime.event_loop_delay_ms.breach", "runtime", "warn")).toBe("runtime.event_loop_delay_ms.breach")
        expect(remote("task.error")).toBeUndefined()
        expect(remote("extension.message")).toBeUndefined()
        expect(remote("tool.execution.cancelled", "runtime", "warn")).toBeUndefined()
        expect(remote("state.build_duration_ms.breach", "runtime", "warn")).toBeUndefined()
        expect(remote("feature.never_listed", "error")).toBeUndefined()
    })

    it("reads a catalog failure's reason, type and model under the contract keys", () => {
        const hang = toDiagnosticRecord(
            event({
                name: "task.terminal_hang",
                severity: "warn",
                properties: { stage: "waiting_for_completion", terminalType: "vscode" },
            }),
            NOW,
        )
        const diff = toDiagnosticRecord(
            event({
                name: "task.diff_edit_failed",
                severity: "warn",
                properties: { errorType: "search_not_found", modelId: "anthropic/claude-sonnet-4.5", provider: "OpenRouter" },
            }),
            NOW,
        )
        const mention = toDiagnosticRecord(
            event({
                name: "task.mention_failed",
                severity: "warn",
                properties: { mentionType: "folder", errorType: "not_found" },
            }),
            NOW,
        )

        expect(hang?.attributes).toEqual({ "error.code": "waiting_for_completion" })
        expect(diff?.attributes).toEqual({
            "error.type": "search_not_found",
            provider: "openrouter",
            model: "anthropic_claude-sonnet-4.5",
            "model.custom": false,
        })
        expect(mention?.attributes).toEqual({ "error.code": "folder", "error.type": "not_found" })
    })

    it("keeps only catalog keys, reading the old aliases into them and never sending an alias itself", () => {
        const { attributes } = record({
            runtime_event_id: "evt-1",
            runtime_sequence: 7,
            telemetry_timestamp_ms: NOW,
            error_fingerprint: FINGERPRINT,
            "dline.exception.fingerprint": FINGERPRINT,
            "dline.exception.code": "ECONNRESET",
            error_type: "TypeError",
            "http.response.status_code": 502,
            error_status: 502,
            api_format: "anthropic",
            extension_version: "0.11.1",
            os_type: "win32",
            error_message: "connect failed for alice@example.com",
            sessionId: "s-1",
            "error.class": "network",
            phase: "connect",
            "retry.attempt": 2,
            retryable: true,
            duration_ms: 1534.6,
        })

        expect(attributes).toEqual({
            "error.class": "network",
            "error.code": "ECONNRESET",
            "error.type": "TypeError",
            "error.fingerprint": FINGERPRINT,
            "http.status": 502,
            "api.format": "anthropic",
            phase: "connect",
            "retry.attempt": 2,
            retryable: true,
            duration_ms: 1535,
        })
    })

    it("leaves out a value the catalog does not allow instead of sending it", () => {
        const { attributes } = record({
            "error.class": "rate_limit",
            phase: "handshake",
            "error.fingerprint": "not-a-fingerprint",
            "error.code": "has spaces in it",
            "http.status": "502",
            retryable: "yes",
            "retry.attempt": 0,
            api_format: "unknown",
        })

        expect(attributes).toEqual({})
    })

    it("names the API format in the contract's vocabulary instead of the enum name", () => {
        expect(record({ api_format: "ANTHROPIC_CHAT" }).attributes).toEqual({ "api.format": "anthropic" })
        expect(record({ api_format: "OPENAI_RESPONSES" }).attributes).toEqual({ "api.format": "openai-responses" })
        expect(record({ api_format: "OPENAI_CHAT" }).attributes).toEqual({ "api.format": "openai-chat" })
    })

    it("names a model the way usage does, and marks it custom only when the event says so", () => {
        const catalog = record({ provider: "OpenRouter", model: "anthropic/claude-sonnet-4.5", "model.custom": false })
        const custom = record({ provider: "openai", model: "Acme/Private-Finetune", "model.custom": true })
        const unmarked = record({ provider: "ollama", model: "qwen3:8b" })

        expect(catalog.attributes).toMatchObject({
            provider: "openrouter",
            model: "anthropic_claude-sonnet-4.5",
            "model.custom": false,
        })
        expect(custom.attributes).toMatchObject({ provider: "openai", model: "acme_private-finetune", "model.custom": true })
        expect(unmarked.attributes).toMatchObject({ provider: "ollama", model: "qwen3_8b", "model.custom": false })
    })
})

describe("v2.1 §3.5 diagnostic extension", () => {
    it("sends each §3.5 key only with a value its rule accepts", () => {
        const valid = record({
            "error.site": "ripgrep.search",
            "dline.exception.fingerprint_version": 3,
            tool_name: "read_file",
            failure_stage: "execution",
        }).attributes
        const invalid = record({
            "error.site": "Ripgrep/Search",
            "dline.exception.fingerprint_version": 4,
            tool_name: "my_mcp_server_tool",
            failure_stage: "unknown",
        }).attributes

        expect(valid).toEqual({
            "error.site": "ripgrep.search",
            "error.fingerprint_version": 3,
            "tool.name": "read_file",
            "failure.stage": "execution",
        })
        expect(invalid).toEqual({})
    })

    it("reports a breach under perf.* with ratios per mille, and nothing for other metrics", () => {
        const breach = (properties: NonNullable<EventSignal["properties"]>) =>
            toDiagnosticRecord(
                event({ name: "runtime.cpu_utilization_ratio.breach", channel: "runtime", severity: "warn", properties }),
                NOW,
            )?.attributes

        expect(breach({ metric: "runtime.cpu_utilization_ratio", kind: "fixed_budget", value: 0.9234, limit: 0.85 })).toEqual({
            "perf.metric": "runtime.cpu_utilization_ratio",
            "perf.kind": "fixed_budget",
            "perf.value": 923,
            "perf.limit": 850,
        })
        expect(breach({ metric: "state.build_duration_ms", kind: "fixed_budget", value: 120 })).toEqual({})
    })

    it("keeps records of different fingerprint versions or tools apart", () => {
        const base = { "error.fingerprint": FINGERPRINT }
        const records = aggregateDiagnostics(
            [],
            [
                record({ ...base, "dline.exception.fingerprint_version": 2 }),
                record({ ...base, "dline.exception.fingerprint_version": 3 }),
                record({ ...base, "dline.exception.fingerprint_version": 3, tool_name: "read_file" }),
                record({ ...base, "dline.exception.fingerprint_version": 3, tool_name: "read_file" }),
            ],
        ).records

        expect(records.map((entry) => entry.occurrences)).toEqual([1, 1, 2])
    })

    it("marks a development build in the resource only when it is one", () => {
        const keys = (isDev?: boolean) =>
            decode(encodeDiagnosticLogs([], { clientVersion: "0.11.1", platform: "linux", isDev }, 0)).resource.map(
                (attribute) => [attribute.key, attribute.value.boolValue],
            )

        expect(keys(true)).toContainEqual(["dline.is_dev", true])
        expect(keys(false).map(([key]) => key)).not.toContain("dline.is_dev")
    })
})

describe("aggregateDiagnostics (contract v2.1 §3.3)", () => {
    it("merges events with the same name, severity, fingerprint, class, provider and model", () => {
        const first = record(
            { "error.fingerprint": FINGERPRINT, "error.class": "timeout", provider: "p", "retry.attempt": 1 },
            NOW,
        )
        const later = record(
            { "error.fingerprint": FINGERPRINT, "error.class": "timeout", provider: "p", "retry.attempt": 3 },
            NOW + 5_000,
        )
        const other = record({ "error.fingerprint": "fedcba9876543210", "error.class": "timeout", provider: "p" }, NOW + 1_000)

        const { records } = aggregateDiagnostics([], [first, later, other, later])

        expect(records).toHaveLength(2)
        expect(records[0]).toMatchObject({
            firstSeenMs: NOW,
            lastSeenMs: NOW + 5_000,
            occurrences: 3,
            attributes: { "retry.attempt": 1 },
        })
        expect(records[1].occurrences).toBe(1)
    })

    it("refuses a new key the caller does not admit, but still merges repeats of an admitted one", () => {
        const known = record({ "error.fingerprint": FINGERPRINT })
        const unknown = record({ "error.fingerprint": "fedcba9876543210" })

        const result = aggregateDiagnostics([known], [known, unknown, unknown], () => false)

        expect(result.records).toEqual([{ ...known, occurrences: 2 }])
        expect(result.refused).toBe(2)
    })
})

describe("encodeDiagnosticLogs", () => {
    it("encodes one OTLP logs request with the first time, the count and only catalog attributes", () => {
        const merged = aggregateDiagnostics(
            [],
            [
                record({ "error.fingerprint": FINGERPRINT, "http.status": 429 }, NOW),
                record({ "error.fingerprint": FINGERPRINT }, NOW + 9_000),
            ],
        ).records
        const resource = { clientVersion: "0.11.1", platform: "win32", releaseChannel: "insiders", hostEditor: "cursor" } as const

        const { resource: attributes, scope } = decode(encodeDiagnosticLogs(merged, resource, 7))
        const [logRecord] = scope.logRecords

        expect(attributes).toEqual([
            { key: "service.name", value: { stringValue: "dline" } },
            { key: "service.version", value: { stringValue: "0.11.1" } },
            { key: "os.type", value: { stringValue: "win32" } },
            { key: "dline.release_channel", value: { stringValue: "insiders" } },
            { key: "dline.host_editor", value: { stringValue: "cursor" } },
            { key: "dline.dropped_records", value: { intValue: "7" } },
        ])
        expect(scope.scope.name).toBe("dline.diagnostics")
        expect(logRecord).toMatchObject({
            timeUnixNano: `${NOW}000000`,
            severityNumber: 17,
            body: { stringValue: "api.request.failed" },
        })
        expect(logRecord.attributes.every((attribute) => DIAGNOSTIC_ATTRIBUTE_KEYS.includes(attribute.key))).toBe(true)
        expect(Object.fromEntries(logRecord.attributes.map(({ key, value }) => [key, value]))).toEqual({
            "dline.channel": { stringValue: "error" },
            "dline.occurrences": { intValue: "2" },
            "dline.last_seen_ms": { intValue: String(NOW + 9_000) },
            "error.fingerprint": { stringValue: FINGERPRINT },
            "http.status": { intValue: "429" },
        })
    })
})

describe("client identity", () => {
    it("reads the release channel from the extension name", () => {
        expect(releaseChannelOf("dline")).toBe("stable")
        expect(releaseChannelOf("dline-insiders")).toBe("insiders")
    })

    it("maps the host application name onto the service vocabulary", () => {
        expect(hostEditorOf("Visual Studio Code")).toBe("vscode")
        expect(hostEditorOf("Visual Studio Code - Insiders")).toBe("vscode")
        expect(hostEditorOf("Cursor")).toBe("cursor")
        expect(hostEditorOf("VSCodium")).toBe("vscodium")
        expect(hostEditorOf("Windsurf")).toBe("windsurf")
        expect(hostEditorOf("Zed")).toBe("other")
        expect(hostEditorOf(undefined)).toBe("other")
    })
})
