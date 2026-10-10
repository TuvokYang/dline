export const MAX_SERIALIZED_PAYLOAD_CHARS = 50_000
const TRUNCATION_MARKER = "…[payload truncated]"

export function boundStructuredPayload(value, maxChars = MAX_SERIALIZED_PAYLOAD_CHARS) {
    const serialized = JSON.stringify(value)
    if (serialized.length <= maxChars) return value

    const summary = value && typeof value === "object" && !Array.isArray(value) ? value.summary : undefined
    return {
        truncated: true,
        originalChars: serialized.length,
        ...(summary ? { summary } : {}),
        preview: `${serialized.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`,
    }
}

export function stringifyBoundedPayload(value, space = 2, maxChars = MAX_SERIALIZED_PAYLOAD_CHARS) {
    return JSON.stringify(boundStructuredPayload(value, maxChars), null, space)
}
