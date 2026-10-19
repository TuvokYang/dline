/**
 * Response contract of the Dline feature service (`POST /v1/features`).
 *
 * ```json
 * { "schema_version": 1, "flags": { "account": true }, "ttl_seconds": 3600 }
 * ```
 *
 * A flag the response omits has no remote opinion and falls back to the
 * client's default. Only boolean answers are accepted; any other value is
 * dropped rather than coerced, so a server mistake cannot turn into `true`.
 */

export const FEATURE_FLAGS_SCHEMA_VERSION = 1
export const DEFAULT_FEATURE_FLAGS_TTL_SECONDS = 3_600
/** Polling faster than this would only load the service; answers change on rollout, not per minute. */
export const MIN_FEATURE_FLAGS_TTL_SECONDS = 300
/** A rollout stop must reach clients within a day even if the service asks for longer. */
export const MAX_FEATURE_FLAGS_TTL_SECONDS = 86_400

export interface FeatureFlagsDocument {
    readonly flags: Readonly<Record<string, boolean>>
    readonly ttlSeconds: number
}

/** Parse a response body, or `undefined` when it is not a document of the supported schema. */
export function parseFeatureFlagsDocument(value: unknown): FeatureFlagsDocument | undefined {
    if (!isRecord(value) || value.schema_version !== FEATURE_FLAGS_SCHEMA_VERSION || !isRecord(value.flags)) {
        return undefined
    }
    const flags: Record<string, boolean> = {}
    for (const [key, answer] of Object.entries(value.flags)) {
        if (typeof answer === "boolean") flags[key] = answer
    }
    return { flags, ttlSeconds: clampTtlSeconds(value.ttl_seconds) }
}

function clampTtlSeconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FEATURE_FLAGS_TTL_SECONDS
    return Math.min(MAX_FEATURE_FLAGS_TTL_SECONDS, Math.max(MIN_FEATURE_FLAGS_TTL_SECONDS, Math.floor(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
