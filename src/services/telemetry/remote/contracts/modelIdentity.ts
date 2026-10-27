/**
 * The single model identity projector of Usage schema 5 revision 1 (§3.1).
 *
 * Usage facts, diagnostic Logs/Metrics and Traces must all carry the result of
 * this function for the same send. The input is the model ID the final encoder
 * actually sent; the namespace records how the Profile selected it, never
 * whether a local registry happens to know the model.
 */

export const USAGE_MODEL_ID_MAX_LENGTH = 96
export const USAGE_MODEL_PRIVATE = "state:private"
export const USAGE_MODEL_UNKNOWN = "state:unknown"

const USAGE_MODEL_ID_PATTERN = /^(?:(?:catalog|custom):[a-z0-9][a-z0-9_.:/@-]{0,95}|state:(?:private|unknown))$/u
const DISALLOWED_CHARACTER = /[^a-z0-9_.:/@-]/gu
const LEADING_SEPARATORS = /^[^a-z0-9]+/u
const PATH_PREFIXES = ["/", "~", "./", "../", "file:"] as const
const DRIVE_PATH = /^[A-Za-z]:[\\/]/u
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u

export interface UsageModelSelection {
    /** The Profile uses a manually entered model ID (including Bedrock "Custom") instead of a listed one. */
    readonly customModel: boolean
}

export function projectUsageModelId(wireModelId: string | null | undefined, selection: UsageModelSelection): string {
    if (typeof wireModelId !== "string") return USAGE_MODEL_UNKNOWN
    const trimmed = wireModelId.trim()
    // Checking the trimmed value is a superset of checking the raw value: surrounding
    // whitespace must not let a path, URL or address through as an ordinary ID.
    if (isUndisclosedForm(trimmed)) return USAGE_MODEL_PRIVATE
    const id = trimmed
        .toLowerCase()
        .replace(DISALLOWED_CHARACTER, "_")
        .replace(LEADING_SEPARATORS, "")
        .slice(0, USAGE_MODEL_ID_MAX_LENGTH)
    if (id.length === 0) return USAGE_MODEL_UNKNOWN
    return `${selection.customModel ? "custom" : "catalog"}:${id}`
}

export function isUsageModelId(value: unknown): value is string {
    return typeof value === "string" && USAGE_MODEL_ID_PATTERN.test(value)
}

/** File paths, URLs and e-mail addresses are never disclosed (analysis requirements §3.1, §10). */
function isUndisclosedForm(value: string): boolean {
    if (value.includes("\\") || value.includes("://")) return true
    if (PATH_PREFIXES.some((prefix) => value.startsWith(prefix))) return true
    return DRIVE_PATH.test(value) || EMAIL.test(value)
}
