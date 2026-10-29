const ESCAPE_MAP: Record<string, string> = {
    "\\n": "\n",
    "\\t": "\t",
    "\\r": "\r",
    '\\"': '"',
    "\\\\": "\\",
}

const ESCAPE_PATTERN = /\\[ntr"\\]/g
const STREAMING_TEXT_FIELDS = ["context", "content", "diff", "response", "result"] as const

function unescapeJsonString(value: string): string {
    return value.replace(ESCAPE_PATTERN, (match) => ESCAPE_MAP[match] ?? match)
}

/**
 * Recover display-safe string fields from an incomplete streamed tool input.
 *
 * Ordinary fields require a closing quote so a half-written path cannot open an
 * editor at the wrong location. Long text fields are allowed to grow before the
 * closing quote so Q&A, reports, completion results and file edits stay live.
 */
export function parsePartialToolInput(value: unknown): Readonly<Record<string, unknown>> {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>
    if (typeof value !== "string" || value.length === 0) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Readonly<Record<string, unknown>>) : {}
    } catch {
        const result: Record<string, unknown> = {}
        const closedPattern = /"(\w+)":\s*"((?:[^"\\]|\\.)*)"/g
        for (const match of value.matchAll(closedPattern)) result[match[1]] = unescapeJsonString(match[2])
        for (const field of STREAMING_TEXT_FIELDS) {
            if (result[field] !== undefined) continue
            const match = value.match(new RegExp(`"${field}":\\s*"((?:[^"\\\\]|\\\\.)*)`))
            if (match) result[field] = unescapeJsonString(match[1])
        }
        return result
    }
}
