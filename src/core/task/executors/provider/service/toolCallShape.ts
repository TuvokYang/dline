import type { ApiStreamToolCallsChunk } from "@core/api/transform/stream"
import type { ToolUse } from "@core/assistant-message"

/** Apply one streamed tool-argument update to the call accumulated so far. */
export function mergeArguments(current: unknown, incoming: unknown, mode: ApiStreamToolCallsChunk["argumentsMode"]): unknown {
    if (mode === "snapshot") return incoming ?? {}
    if (typeof current === "string" || typeof incoming === "string")
        return `${typeof current === "string" ? current : ""}${typeof incoming === "string" ? incoming : ""}`
    if (current && incoming && typeof current === "object" && typeof incoming === "object") return { ...current, ...incoming }
    return incoming ?? current ?? {}
}

/**
 * The card of a call written as markup, drawn before the call settles.
 *
 * Provisional: the turn either settles the call on this row or the presenter
 * withdraws it, so an unclosed or unmaterialized call leaves nothing behind.
 */
export function xmlCardProjection(card: ToolUse): Readonly<Record<string, unknown>> {
    return { kind: "provider.tool_partial", dlineTid: `xml:${card.ts}`, provisional: true, block: card }
}

/**
 * Identify a call by name and argument values, for dropping a text copy of a
 * call the provider already returned natively.
 *
 * Scalars compare as text so a numeric native argument and the same argument
 * written as markup still match. A nested value compares by canonical JSON:
 * `String(value)` would flatten every object to `[object Object]` and let a
 * repeated structured call run twice. Unreadable arguments fall back to their
 * raw text, which only prevents a match rather than inventing one.
 */
export function duplicateCallKey(name: string, argumentsValue: unknown): string {
    const parsed = parseToolArguments(argumentsValue)
    if (parsed === undefined) return `${name}:${typeof argumentsValue === "string" ? argumentsValue : ""}`
    const entries = Object.keys(parsed)
        .sort()
        .map((key) => [key, canonicalValue(parsed[key])])
    return `${name}:${JSON.stringify(entries)}`
}

function canonicalValue(value: unknown): string {
    if (value !== null && typeof value === "object") return JSON.stringify(sortKeys(value))
    const nested = typeof value === "string" ? parseNestedJson(value) : undefined
    return nested === undefined ? String(value) : JSON.stringify(sortKeys(nested))
}

function parseNestedJson(value: string): object | undefined {
    const trimmed = value.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
    try {
        const parsed: unknown = JSON.parse(trimmed)
        return parsed !== null && typeof parsed === "object" ? parsed : undefined
    } catch {
        return undefined
    }
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value === null || typeof value !== "object") return value
    const record = value as Record<string, unknown>
    return Object.fromEntries(
        Object.keys(record)
            .sort()
            .map((key): [string, unknown] => [key, sortKeys(record[key])]),
    )
}

function parseToolArguments(argumentsValue: unknown): Record<string, unknown> | undefined {
    if (typeof argumentsValue !== "string") {
        return argumentsValue !== null && typeof argumentsValue === "object"
            ? (argumentsValue as Record<string, unknown>)
            : undefined
    }
    try {
        const parsed: unknown = JSON.parse(argumentsValue)
        return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
    } catch {
        return undefined
    }
}
