import { createHash } from "node:crypto"

/**
 * Serialize one JSON-compatible value with sorted object keys so identical
 * logical values always produce the same bytes regardless of key order.
 */
export function stableSerializeForCompaction(value: unknown): string {
    return stableSerialize(value)
}

/** Hash one JSON-compatible value with a stable, key-order-independent serializer. */
export function hashCompactionValue(value: unknown): string {
    return `sha256:${createHash("sha256").update(stableSerialize(value), "utf8").digest("hex")}`
}

/** Hash a plain summary string without wrapping it in JSON object semantics. */
export function hashCompactionSummary(value: string): string {
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

function stableSerialize(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null"
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(",")}]`
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
        .join(",")}}`
}
