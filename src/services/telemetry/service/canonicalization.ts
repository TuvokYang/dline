import type { TelemetryProperties } from "../providers/ITelemetryProvider"
import { type AttributePolicyResult, RuntimeContentPolicy } from "../runtime/content-policy"

const MAX_DEPTH = 10
const MAX_ARRAY_ITEMS = 32
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"])

export interface CanonicalTelemetryProperties {
    readonly attributes: AttributePolicyResult["attributes"]
    readonly contentPolicy: {
        readonly rejectedCount: number
        readonly rejections: Readonly<Record<string, string>>
    }
}

/** Flatten nested telemetry properties without serializing arrays or objects into policy-bypassing JSON strings. */
export function flattenTelemetryProperties(properties?: TelemetryProperties): Record<string, string | number | boolean> {
    const flattened: Record<string, string | number | boolean> = {}
    if (!properties) return flattened
    visit(properties, "", flattened, new WeakSet<object>(), 0)
    return flattened
}

/** Apply the shared content policy, preserving field names while masking sensitive values. */
export function canonicalizeTelemetryProperties(
    properties: TelemetryProperties | undefined,
    policy: RuntimeContentPolicy,
): CanonicalTelemetryProperties {
    const result = policy.apply(properties)
    return {
        attributes: result.attributes,
        contentPolicy: {
            rejectedCount: result.rejections.size,
            rejections: Object.fromEntries(result.rejections),
        },
    }
}

function visit(
    value: unknown,
    prefix: string,
    output: Record<string, string | number | boolean>,
    seen: WeakSet<object>,
    depth: number,
): void {
    if (value === null || value === undefined) {
        if (prefix) output[prefix] = String(value)
        return
    }
    if (typeof value === "string" || typeof value === "boolean") {
        if (prefix) output[prefix] = value
        return
    }
    if (typeof value === "number") {
        if (prefix && Number.isFinite(value)) output[prefix] = value
        return
    }
    if (typeof value !== "object" || depth >= MAX_DEPTH || seen.has(value)) return
    seen.add(value)

    if (value instanceof Date) {
        if (prefix) output[prefix] = value.toISOString()
        return
    }
    if (value instanceof Error) {
        if (prefix) output[`${prefix}.name`] = value.name
        return
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index++) {
            visit(value[index], `${prefix}.${index}`, output, seen, depth + 1)
        }
        if (value.length > MAX_ARRAY_ITEMS) output[`${prefix}.truncated`] = true
        return
    }

    for (const [key, entry] of Object.entries(value)) {
        if (PROTOTYPE_KEYS.has(key)) continue
        visit(entry, prefix ? `${prefix}.${key}` : key, output, seen, depth + 1)
    }
}
