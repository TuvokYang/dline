import { readFileSync } from "node:fs"
import path from "node:path"
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
const OTLP_FIXTURE = JSON.parse(
    readFileSync(
        path.join(__dirname, "..", "..", "contracts", "__tests__", "fixtures", "otlp-production-reference.json"),
        "utf8",
    ),
)
const LOGS_EXAMPLE = OTLP_FIXTURE.logs.example
const TRACE_ID = LOGS_EXAMPLE.input.trace_id as string
const SPAN_ID = LOGS_EXAMPLE.input.span_id as string

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

/** The fixture compares attribute lists as sets; every other array keeps its order. */
function sortAttributes(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortAttributes)
    if (typeof value !== "object" || value === null) return value
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            const sorted = sortAttributes(entry)
            return [
                key,
                key === "attributes" && Array.isArray(sorted)
                    ? [...sorted].sort((left, right) => String(left.key).localeCompare(String(right.key)))
                    : sorted,
            ]
        }),
    )
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

    it("keeps an MCP remote failure's inner event and suppresses its outer tool projection", () => {
        const properties = {
            tool_name: "use_mcp_tool",
            failure_stage: "remote",
            failure_code: "remote_tool_error",
        }

        expect(toDiagnosticRecord(event({ name: "mcp.tools.call.failed", properties }), NOW)?.name).toBe("mcp.tools.call.failed")
        expect(toDiagnosticRecord(event({ name: "tool.execution.failed", properties }), NOW)).toBeUndefined()
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
            model: "catalog:anthropic/claude-sonnet-4.5",
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

    it("names a model by the usage-contract §3.1 projection, in the custom namespace only when the event says so", () => {
        const catalog = record({ provider: "OpenRouter", model: "anthropic/claude-sonnet-4.5", "model.custom": false })
        const custom = record({ provider: "openai", model: "Acme/Private-Finetune", "model.custom": true })
        const unmarked = record({ provider: "ollama", model: "qwen3:8b" })

        expect(catalog.attributes).toEqual({
            provider: "openrouter",
            model: "catalog:anthropic/claude-sonnet-4.5",
            "model.custom": false,
        })
        expect(custom.attributes).toEqual({ provider: "openai", model: "custom:acme/private-finetune", "model.custom": true })
        expect(unmarked.attributes).toEqual({ provider: "ollama", model: "catalog:qwen3:8b" })
    })

    it("never discloses a path- or URL-shaped model, and keeps an existing projection as it is", () => {
        expect(record({ model: "C:\\models\\llama.gguf" }).attributes).toEqual({ model: "state:private" })
        expect(record({ model: "http://10.0.0.5:8080/v1/llama" }).attributes).toEqual({ model: "state:private" })
        expect(record({ model: "custom:acme/private" }).attributes).toEqual({ model: "custom:acme/private" })
    })

    it("keeps a plain-text warning's model identity only under the catalog keys", () => {
        const warning = (properties: NonNullable<EventSignal["properties"]>) =>
            toDiagnosticRecord(
                event({ name: "provider.plain_text_warning", channel: "runtime", severity: "warn", properties }),
                NOW,
            )?.attributes

        expect(warning({ provider: "anthropic", model: "claude-sonnet", "model.custom": true })).toMatchObject({
            provider: "anthropic",
            model: "custom:claude-sonnet",
            "model.custom": true,
        })
        // The spelling an earlier build sent: nothing in it identifies the model once filtered.
        const legacy = warning({ provider_id: "anthropic", model_id: "claude-sonnet", warning_kind: "text_only" })
        expect(legacy).toBeDefined()
        expect(legacy).not.toHaveProperty("provider")
        expect(legacy).not.toHaveProperty("model")
    })

    it("carries a provider failure onto the fixture's attributes and first-occurrence span (TADR §6.1, §6.3)", () => {
        const failure = record({
            provider: "Anthropic",
            model: "claude-sonnet-4-5",
            "error.type": "rate_limit",
            "http.status": 429,
            "retry.attempt": 1,
            "dline.role": "task",
            "dline.attempt_observation_id": LOGS_EXAMPLE.input.attributes["dline.attempt_observation_id"],
            "dline.logical_request_id": LOGS_EXAMPLE.input.attributes["dline.logical_request_id"],
            runtime_trace_id: TRACE_ID,
            runtime_span_id: SPAN_ID,
            runtime_trace_flags: 1,
        })

        expect(failure.attributes).toEqual(LOGS_EXAMPLE.input.attributes)
        expect(failure).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID })
    })

    it("keeps the first occurrence's span when later occurrences merge in", () => {
        const first = record({ "error.fingerprint": FINGERPRINT, runtime_trace_id: TRACE_ID, runtime_span_id: SPAN_ID })
        const later = record(
            { "error.fingerprint": FINGERPRINT, runtime_trace_id: "f".repeat(32), runtime_span_id: "e".repeat(16) },
            NOW + 1,
        )

        const [merged] = aggregateDiagnostics([], [first, later]).records

        expect(merged).toMatchObject({ occurrences: 2, traceId: TRACE_ID, spanId: SPAN_ID })
    })

    it("leaves out a span context that is missing, all zero or not lowercase hex", () => {
        const contextOf = (traceId: unknown, spanId: unknown) => {
            const { traceId: kept, spanId: keptSpan } = record({ runtime_trace_id: traceId, runtime_span_id: spanId } as never)
            return [kept, keptSpan]
        }

        expect(contextOf(undefined, undefined)).toEqual([undefined, undefined])
        expect(contextOf("0".repeat(32), SPAN_ID)).toEqual([undefined, undefined])
        expect(contextOf(TRACE_ID.toUpperCase(), SPAN_ID)).toEqual([undefined, undefined])
        expect(contextOf(TRACE_ID, "short")).toEqual([undefined, undefined])
    })

    it("sends a correlation key only with a registered role or a client-shaped id", () => {
        expect(
            record({
                "dline.role": "planner",
                "dline.attempt_observation_id": "has spaces",
                "dline.logical_request_id": "/home/alice/request",
            }).attributes,
        ).toEqual({})
        expect(record({ "dline.role": "subagent", "dline.logical_request_id": "task:01JC3Z8R4M" }).attributes).toEqual({
            "dline.role": "subagent",
            "dline.logical_request_id": "task:01JC3Z8R4M",
        })
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

    it("names a development build in the resource and its deployment environment", () => {
        const resourceOf = (isDev?: boolean) =>
            Object.fromEntries(
                decode(encodeDiagnosticLogs([], { clientVersion: "0.11.1", platform: "linux", isDev }, 0)).resource.map(
                    (attribute) => [attribute.key, attribute.value.boolValue ?? attribute.value.stringValue],
                ),
            )

        expect(resourceOf(true)).toMatchObject({ "dline.is_dev": true, "deployment.environment.name": "development" })
        expect(resourceOf(false)).toMatchObject({ "dline.is_dev": false, "deployment.environment.name": "production" })
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
    it("encodes the fixture's aggregated record as the production logs request (TADR §2.4, §6)", () => {
        const { input } = LOGS_EXAMPLE
        const resourceInput = OTLP_FIXTURE.resource.input
        const aggregated: DiagnosticRecord = {
            name: input.event_name,
            channel: input.channel,
            severity: input.severity,
            firstSeenMs: input.first_seen_ms,
            lastSeenMs: input.last_seen_ms,
            occurrences: input.occurrences,
            attributes: input.attributes,
            traceId: input.trace_id,
            spanId: input.span_id,
        }
        const resource = {
            clientVersion: resourceInput.client_version,
            platform: resourceInput.platform,
            arch: resourceInput.arch,
            releaseChannel: resourceInput.release_channel,
            hostEditor: resourceInput.host_editor,
            isDev: resourceInput.is_dev,
        }

        const body = JSON.parse(
            encodeDiagnosticLogs([aggregated], resource, resourceInput.dropped_records, LOGS_EXAMPLE.exported_at_ms),
        )

        expect(sortAttributes(body)).toEqual(sortAttributes(LOGS_EXAMPLE.expected_body))
    })

    it("sends only catalog keys and reports the local drops in the resource", () => {
        const merged = aggregateDiagnostics(
            [],
            [
                record({ "error.fingerprint": FINGERPRINT, "http.status": 429, error_message: "secret" }, NOW),
                record({ "error.fingerprint": FINGERPRINT }, NOW + 9_000),
            ],
        ).records

        const { resource, scope } = decode(encodeDiagnosticLogs(merged, { clientVersion: "0.11.1", platform: "win32" }, 7))
        const [logRecord] = scope.logRecords

        expect(resource).toContainEqual({ key: "dline.dropped_records", value: { intValue: "7" } })
        expect(logRecord.attributes.every((attribute) => DIAGNOSTIC_ATTRIBUTE_KEYS.includes(attribute.key))).toBe(true)
        expect(Object.fromEntries(logRecord.attributes.map(({ key, value }) => [key, value]))).toEqual({
            "dline.channel": { stringValue: "error" },
            "dline.occurrences": { intValue: "2" },
            "dline.first_seen_ms": { intValue: String(NOW) },
            "dline.last_seen_ms": { intValue: String(NOW + 9_000) },
            "error.fingerprint": { stringValue: FINGERPRINT },
            "http.status": { intValue: "429" },
        })
    })
})

describe("client identity", () => {
    it("reads the release channel from the extension name and the minor version parity", () => {
        expect(releaseChannelOf("dline", "0.12.0")).toBe("stable")
        // A pre-release ships under the production name; only its odd minor tells it apart.
        expect(releaseChannelOf("dline", "0.11.3")).toBe("pre-release")
        expect(releaseChannelOf("dline-insiders", "0.13.1792900510")).toBe("insiders")
        expect(releaseChannelOf("dline", "not-a-version")).toBe("stable")
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
