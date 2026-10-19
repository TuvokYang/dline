import type { JournalTelemetrySignal } from "../../providers/capabilities"
import { usageModelSegments } from "../usage/usageCatalog"

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
const MAX_TOKEN_LENGTH = 64
const MAX_ATTRIBUTES = 32
/**
 * The keys the telemetry console reads an error by (otel contract §9). They are
 * kept ahead of every other attribute, so the attribute cap never drops them.
 */
export const DIAGNOSTIC_CONTRACT_KEYS = [
    "error.class",
    "error.code",
    "error.type",
    "http.status",
    "provider",
    "model",
    "model.custom",
    "api.format",
    "retry.attempt",
    "retryable",
    "phase",
    "duration_ms",
] as const
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
        attributes: remoteSafeAttributes(withNormalizedModel(signal.properties)),
    }
}

/**
 * Report a provider event's model the way usage does: the raw ID may hold `/` or
 * `:`, which the value filter would drop with the whole attribute, and a custom
 * model's ID must not leave at all. A model not marked as catalog is custom.
 */
function withNormalizedModel(
    properties: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
    const model = properties?.model
    if (!properties || typeof model !== "string" || model.length === 0) return properties
    const custom = properties["model.custom"] !== false
    const provider = typeof properties.provider === "string" ? properties.provider : ""
    const segments = usageModelSegments({ provider, model, custom })
    const { api_format: apiFormat, ...rest } = properties
    return {
        ...rest,
        provider: segments.provider,
        model: segments.model.slice(0, MAX_TOKEN_LENGTH),
        "model.custom": custom,
        ...(typeof apiFormat === "string" && rest["api.format"] === undefined ? { "api.format": apiFormat } : {}),
    }
}

/** Keep finite numbers, booleans and short tokens under keys that name neither content nor identity. */
export function remoteSafeAttributes(
    properties: Readonly<Record<string, unknown>> | undefined,
): Record<string, DiagnosticAttributeValue> {
    const safe: Record<string, DiagnosticAttributeValue> = {}
    if (!properties) return safe
    let count = 0
    for (const [key, value] of contractKeysFirst(properties)) {
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

function contractKeysFirst(properties: Readonly<Record<string, unknown>>): [string, unknown][] {
    const contract: ReadonlySet<string> = new Set(DIAGNOSTIC_CONTRACT_KEYS)
    const entries = Object.entries(properties)
    return [...entries.filter(([key]) => contract.has(key)), ...entries.filter(([key]) => !contract.has(key))]
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
    /** `stable` or `insiders`; never under `dline.channel`, which separates error from runtime events. */
    readonly releaseChannel?: "stable" | "insiders"
    /** `vscode`, `cursor`, `vscodium`, `windsurf` or `other`. */
    readonly hostEditor?: string
}

/** The release channel of a build, read from its extension name (`dline-insiders` for Insiders). */
export function releaseChannelOf(extensionName: string): "stable" | "insiders" {
    return extensionName.endsWith("-insiders") ? "insiders" : "stable"
}

/** The editor hosting the extension, from its application name, in the service's fixed vocabulary. */
export function hostEditorOf(appName: string | undefined): string {
    const name = (appName ?? "").toLowerCase()
    if (name.includes("cursor")) return "cursor"
    if (name.includes("windsurf")) return "windsurf"
    if (name.includes("vscodium")) return "vscodium"
    if (name.includes("visual studio code") || name.includes("vscode")) return "vscode"
    return "other"
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
                        ...(resource.releaseChannel ? [stringAttribute("dline.release_channel", resource.releaseChannel)] : []),
                        ...(resource.hostEditor ? [stringAttribute("dline.host_editor", resource.hostEditor)] : []),
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
