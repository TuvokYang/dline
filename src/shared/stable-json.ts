import crypto from "crypto"

function normalizeJsonValue(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeJsonValue(entry) ?? null)
    }
    if (typeof value === "object") {
        const normalized: Record<string, unknown> = {}
        for (const key of Object.keys(value).sort()) {
            const entry = normalizeJsonValue((value as Record<string, unknown>)[key])
            if (entry !== undefined) normalized[key] = entry
        }
        return normalized
    }
    return undefined
}

/** Serialize JSON-compatible data with stable object-key ordering. */
export function stableJsonStringify(value: unknown): string {
    return JSON.stringify(normalizeJsonValue(value)) ?? "null"
}

/** Compute a privacy-safe SHA-256 fingerprint for JSON-compatible data. */
export function hashStableJson(value: unknown): string {
    return `sha256:${crypto.createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex")}`
}
