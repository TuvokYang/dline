import type { JournalTelemetrySignal } from "../../providers/capabilities"

export type DiagnosticChannel = "error" | "runtime"
export type DiagnosticSeverity = "warn" | "error" | "fatal"
export type DiagnosticAttributeValue = string | number | boolean

/** One error or runtime event, reduced to what may leave the machine. */
export interface DiagnosticRecord {
    readonly timeUnixMs: number
    readonly name: string
    readonly channel: DiagnosticChannel
    readonly severity: DiagnosticSeverity
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
const MAX_ATTRIBUTES = 32
/**
 * Key segments that mark free text, locations or identity. A key is split on
 * `_ . -` and camelCase boundaries; one matching segment drops the attribute.
 */
const DENIED_KEY_SEGMENTS = new Set([
    "message",
    "msg",
    "text",
    "content",
    "prompt",
    "body",
    "stack",
    "trace",
    "frame",
    "args",
    "arg",
    "path",
    "file",
    "filename",
    "dir",
    "directory",
    "cwd",
    "url",
    "uri",
    "href",
    "host",
    "hostname",
    "query",
    "command",
    "metadata",
    "session",
    "task",
    "ulid",
    "workspace",
    "controller",
    "instance",
    "device",
    "distinct",
    "account",
    "user",
    "email",
    "org",
    "organization",
    "machine",
    "request",
    "pid",
    "token",
    "secret",
    "key",
    "password",
    "auth",
    "authorization",
    "cookie",
])

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
        timeUnixMs: now,
        name: signal.name,
        channel: signal.channel,
        severity: signal.severity,
        attributes: remoteSafeAttributes(signal.properties),
    }
}

/** Keep finite numbers, booleans and short tokens under keys that name neither content nor identity. */
export function remoteSafeAttributes(
    properties: Readonly<Record<string, unknown>> | undefined,
): Record<string, DiagnosticAttributeValue> {
    const safe: Record<string, DiagnosticAttributeValue> = {}
    if (!properties) return safe
    let count = 0
    for (const [key, value] of Object.entries(properties)) {
        if (count >= MAX_ATTRIBUTES) break
        if (!isSafeKey(key)) continue
        if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
            safe[key] = value
        } else if (typeof value === "string" && TOKEN_VALUE.test(value)) {
            safe[key] = value
        } else {
            continue
        }
        count++
    }
    return safe
}

function isSafeKey(key: string): boolean {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return false
    const segments = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .split(/[_.-]+/)
    return !segments.some((segment) => DENIED_KEY_SEGMENTS.has(segment))
}

/** What the resource of every request says about this client; nothing that identifies a device or a user. */
export interface DiagnosticResource {
    readonly clientVersion: string
    readonly platform: string
}

const SEVERITY_NUMBER: Record<DiagnosticSeverity, number> = { warn: 13, error: 17, fatal: 21 }

/** Encode records as one OTLP/HTTP JSON logs request. */
export function encodeDiagnosticLogs(records: readonly DiagnosticRecord[], resource: DiagnosticResource): string {
    return JSON.stringify({
        resourceLogs: [
            {
                resource: {
                    attributes: [
                        stringAttribute("service.name", "dline"),
                        stringAttribute("service.version", resource.clientVersion),
                        stringAttribute("os.type", resource.platform),
                    ],
                },
                scopeLogs: [
                    {
                        scope: { name: "dline.diagnostics" },
                        logRecords: records.map((record) => ({
                            timeUnixNano: `${Math.trunc(record.timeUnixMs)}000000`,
                            severityNumber: SEVERITY_NUMBER[record.severity],
                            severityText: record.severity.toUpperCase(),
                            body: { stringValue: record.name },
                            attributes: [
                                stringAttribute("event.name", record.name),
                                stringAttribute("dline.channel", record.channel),
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

function anyAttribute(key: string, value: DiagnosticAttributeValue) {
    if (typeof value === "boolean") return { key, value: { boolValue: value } }
    if (typeof value === "number") {
        return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } }
    }
    return stringAttribute(key, value)
}
