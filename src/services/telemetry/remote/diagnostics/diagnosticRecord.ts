import { USAGE_ERROR_CLASSES } from "@/core/task/telemetry/UsageSettlement"
import type { JournalTelemetrySignal } from "../../providers/capabilities"
import type { UsageHostEditor, UsageReleaseChannel } from "../contracts/usageBody"
import { usageModelKey, usageProviderId } from "../usage/usageTally"

export type DiagnosticChannel = "error" | "runtime"
export type DiagnosticSeverity = "warn" | "error" | "fatal"
export type DiagnosticAttributeValue = string | number | boolean

/**
 * One aggregated error or runtime record (otel contract v2 §3.3): every event of
 * one interval with the same name, severity, fingerprint, class, provider and
 * model, counted once with its first and last time. The attributes are those of
 * the first occurrence and use only the catalog keys.
 */
export interface DiagnosticRecord {
    readonly name: string
    readonly channel: DiagnosticChannel
    readonly severity: DiagnosticSeverity
    /** First occurrence, epoch milliseconds; sent as `timeUnixNano`. */
    readonly firstSeenMs: number
    /** Last occurrence, epoch milliseconds; sent as `dline.last_seen_ms`. */
    readonly lastSeenMs: number
    readonly occurrences: number
    readonly attributes: Readonly<Record<string, DiagnosticAttributeValue>>
}

/** The service rejects an event name outside this shape. */
const EVENT_NAME = /^[A-Za-z0-9_.:/-]{1,160}$/
/**
 * A string value leaves only as a short token: an error code, a provider, a
 * model, a status. Whitespace, slashes, colons and `@` are excluded, so free
 * text, paths, URLs and e-mail addresses never qualify.
 */
const TOKEN_VALUE = /^[A-Za-z0-9_.+-]{1,64}$/
const FINGERPRINT = /^[0-9a-f]{16}$/
const PHASES = ["connect", "stream", "parse", "tool", "other"] as const

type AttributeKind = "token" | "int" | "attempt" | "bool" | "apiFormat" | readonly string[] | RegExp

/**
 * `ApiFormat` enum names, which the request observation carries, in the
 * vocabulary of §3.2 (`anthropic`, `openai-responses`). A value already in that
 * vocabulary passes through; `unknown` says nothing and is left out.
 */
const API_FORMATS: Readonly<Record<string, string>> = {
    ANTHROPIC_CHAT: "anthropic",
    GEMINI_CHAT: "gemini",
    OPENAI_CHAT: "openai-chat",
    R1_CHAT: "r1",
    OPENAI_RESPONSES: "openai-responses",
    OPENAI_RESPONSES_WEBSOCKET_MODE: "openai-responses-websocket",
}
const API_FORMAT_VALUE = /^[a-z0-9-]{1,64}$/

/**
 * The attribute catalog of §3.2, apart from the three keys the record itself
 * owns (`dline.channel`, `dline.occurrences`, `dline.last_seen_ms`). Each key
 * lists the property names it is read from, in order: the canonical pipeline
 * still carries older aliases such as `dline.exception.fingerprint`, which the
 * service no longer stores, so their values travel under the catalog key and
 * the alias itself never leaves.
 */
const CATALOG: readonly { readonly key: string; readonly kind: AttributeKind; readonly sources: readonly string[] }[] = [
    { key: "error.class", kind: USAGE_ERROR_CLASSES, sources: ["error.class"] },
    { key: "error.code", kind: "token", sources: ["error.code", "dline.exception.code", "error_code"] },
    { key: "error.type", kind: "token", sources: ["error.type", "exception.type", "error_type"] },
    {
        key: "error.fingerprint",
        kind: FINGERPRINT,
        sources: ["error.fingerprint", "dline.exception.fingerprint", "error_fingerprint"],
    },
    {
        key: "http.status",
        kind: "int",
        sources: ["http.status", "http.response.status_code", "dline.exception.status", "error_status"],
    },
    { key: "provider", kind: "token", sources: ["provider"] },
    { key: "model", kind: "token", sources: ["model"] },
    { key: "model.custom", kind: "bool", sources: ["model.custom"] },
    { key: "api.format", kind: "apiFormat", sources: ["api.format", "api_format"] },
    { key: "phase", kind: PHASES, sources: ["phase"] },
    { key: "retry.attempt", kind: "attempt", sources: ["retry.attempt"] },
    { key: "retryable", kind: "bool", sources: ["retryable"] },
    { key: "duration_ms", kind: "int", sources: ["duration_ms"] },
]

/** Every attribute key a record may carry on the wire. */
export const DIAGNOSTIC_ATTRIBUTE_KEYS: readonly string[] = [
    "dline.channel",
    "dline.occurrences",
    "dline.last_seen_ms",
    ...CATALOG.map((entry) => entry.key),
]

/**
 * Turn one canonical signal into a remote record, or undefined when it must not
 * leave: only error and runtime events at warn or above are sent.
 */
export function toDiagnosticRecord(signal: JournalTelemetrySignal, now: number): DiagnosticRecord | undefined {
    if (signal.kind !== "event") return undefined
    if (signal.channel !== "error" && signal.channel !== "runtime") return undefined
    if (signal.severity !== "warn" && signal.severity !== "error" && signal.severity !== "fatal") return undefined
    if (!EVENT_NAME.test(signal.name)) return undefined
    return {
        name: signal.name,
        channel: signal.channel,
        severity: signal.severity,
        firstSeenMs: now,
        lastSeenMs: now,
        occurrences: 1,
        attributes: catalogAttributes(withNormalizedModel(signal.properties)),
    }
}

/**
 * Report a provider event's provider and model the way usage does: the raw ID
 * may hold `/` or `:`, which the value filter would drop, and a custom model's
 * ID must not leave at all. A model not marked as catalog is custom.
 */
function withNormalizedModel(
    properties: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
    if (!properties) return properties
    const provider = typeof properties.provider === "string" && properties.provider.length > 0 ? properties.provider : undefined
    const model = typeof properties.model === "string" && properties.model.length > 0 ? properties.model : undefined
    if (model) {
        const custom = properties["model.custom"] !== false
        return { ...properties, ...usageModelKey({ provider: provider ?? "", model, custom }), "model.custom": custom }
    }
    return provider ? { ...properties, provider: usageProviderId(provider) } : properties
}

/** Keep only catalog keys, each read from its first source holding a value of the right kind. */
function catalogAttributes(properties: Readonly<Record<string, unknown>> | undefined): Record<string, DiagnosticAttributeValue> {
    const attributes: Record<string, DiagnosticAttributeValue> = {}
    if (!properties) return attributes
    for (const { key, kind, sources } of CATALOG) {
        for (const source of sources) {
            const value = acceptValue(kind, properties[source])
            if (value === undefined) continue
            attributes[key] = value
            break
        }
    }
    return attributes
}

function acceptValue(kind: AttributeKind, value: unknown): DiagnosticAttributeValue | undefined {
    if (kind === "bool") return typeof value === "boolean" ? value : undefined
    if (kind === "int" || kind === "attempt") {
        if (typeof value !== "number" || !Number.isFinite(value)) return undefined
        const rounded = Math.round(value)
        // Attempts count from 1 (§3.2).
        const minimum = kind === "attempt" ? 1 : 0
        return Number.isSafeInteger(rounded) && rounded >= minimum ? rounded : undefined
    }
    if (typeof value !== "string") return undefined
    if (kind === "token") return TOKEN_VALUE.test(value) ? value : undefined
    if (kind === "apiFormat")
        return API_FORMATS[value] ?? (API_FORMAT_VALUE.test(value) && value !== "unknown" ? value : undefined)
    if (kind instanceof RegExp) return kind.test(value) ? value : undefined
    return kind.includes(value) ? value : undefined
}

/** Records with the same key within one interval are merged into one. */
export function diagnosticKey(record: DiagnosticRecord): string {
    const { attributes } = record
    return JSON.stringify([
        record.name,
        record.severity,
        attributes["error.fingerprint"] ?? null,
        attributes["error.class"] ?? null,
        attributes.provider ?? null,
        attributes.model ?? null,
    ])
}

/** Fold a later occurrence into a record: counts add, the first time and attributes stay. */
export function mergeDiagnostic(first: DiagnosticRecord, later: DiagnosticRecord): DiagnosticRecord {
    return {
        ...first,
        firstSeenMs: Math.min(first.firstSeenMs, later.firstSeenMs),
        lastSeenMs: Math.max(first.lastSeenMs, later.lastSeenMs),
        occurrences: Math.min(Number.MAX_SAFE_INTEGER, first.occurrences + later.occurrences),
    }
}

/**
 * Merge incoming records into pending ones by key. `admit` decides whether a
 * record with a new key may join; a refused record is counted in `refused`.
 */
export function aggregateDiagnostics(
    pending: readonly DiagnosticRecord[],
    incoming: readonly DiagnosticRecord[],
    admit: (record: DiagnosticRecord) => boolean = () => true,
): { readonly records: DiagnosticRecord[]; readonly refused: number } {
    const byKey = new Map(pending.map((record) => [diagnosticKey(record), record]))
    let refused = 0
    for (const record of incoming) {
        const key = diagnosticKey(record)
        const existing = byKey.get(key)
        if (existing) byKey.set(key, mergeDiagnostic(existing, record))
        else if (admit(record)) byKey.set(key, record)
        else refused++
    }
    return { records: [...byKey.values()], refused }
}

/** What the resource of every request says about this client; nothing that identifies a device or a user. */
export interface DiagnosticResource {
    readonly clientVersion: string
    readonly platform: string
    /** Never under `dline.channel`, which separates error from runtime events. */
    readonly releaseChannel?: UsageReleaseChannel
    readonly hostEditor?: UsageHostEditor
}

const SEVERITY_NUMBER: Record<DiagnosticSeverity, number> = { warn: 13, error: 17, fatal: 21 }

/**
 * Encode records as one OTLP/HTTP JSON logs request. `droppedRecords` counts
 * records discarded locally since the previous request, by the device limits
 * or the backlog bound.
 */
export function encodeDiagnosticLogs(
    records: readonly DiagnosticRecord[],
    resource: DiagnosticResource,
    droppedRecords: number,
): string {
    return JSON.stringify({
        resourceLogs: [
            {
                resource: {
                    attributes: [
                        stringAttribute("service.name", "dline"),
                        stringAttribute("service.version", resource.clientVersion),
                        stringAttribute("os.type", resource.platform),
                        ...(resource.releaseChannel ? [stringAttribute("dline.release_channel", resource.releaseChannel)] : []),
                        ...(resource.hostEditor ? [stringAttribute("dline.host_editor", resource.hostEditor)] : []),
                        intAttribute("dline.dropped_records", droppedRecords),
                    ],
                },
                scopeLogs: [
                    {
                        scope: { name: "dline.diagnostics" },
                        logRecords: records.map((record) => ({
                            timeUnixNano: `${Math.trunc(record.firstSeenMs)}000000`,
                            severityNumber: SEVERITY_NUMBER[record.severity],
                            body: { stringValue: record.name },
                            attributes: [
                                stringAttribute("dline.channel", record.channel),
                                intAttribute("dline.occurrences", record.occurrences),
                                intAttribute("dline.last_seen_ms", record.lastSeenMs),
                                ...Object.entries(record.attributes).map(([key, value]) => anyAttribute(key, value)),
                            ],
                        })),
                    },
                ],
            },
        ],
    })
}

function stringAttribute(key: string, value: string) {
    return { key, value: { stringValue: value } }
}

function intAttribute(key: string, value: number) {
    return { key, value: { intValue: String(Math.trunc(value)) } }
}

function anyAttribute(key: string, value: DiagnosticAttributeValue) {
    if (typeof value === "boolean") return { key, value: { boolValue: value } }
    if (typeof value === "number") return intAttribute(key, value)
    return stringAttribute(key, value)
}
