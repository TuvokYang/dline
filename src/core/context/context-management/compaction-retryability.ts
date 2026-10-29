const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429])

/** Decide whether replaying the same immutable compaction Pass can recover from an error. */
export function isRetryableCompactionError(error: unknown): boolean {
    const status = extractHttpStatus(error)
    if (status === undefined) return true
    return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500
}

/** Identify a deterministic Provider rejection caused by invalid tool-use/result pairing. */
export function isDeterministicToolPairingError(error: unknown): boolean {
    if (extractHttpStatus(error) !== 400) return false
    const message = extractErrorMessage(error)
    return [
        /no tool output found for function call/i,
        /messages? with role ['"]?tool['"]?.*preceding message.*tool_calls?/i,
        /tool_result.*no corresponding tool_use/i,
        /tool_use.*(?:without|missing|requires?).*tool_result/i,
        /each tool_use block.*corresponding tool_result/i,
        /tool (?:message|output|result).*(?:without|missing|requires?).*tool_(?:call|use)/i,
    ].some((pattern) => pattern.test(message))
}

/** Extract a wrapped HTTP status from structured errors or common diagnostic text. */
export function extractHttpStatus(error: unknown): number | undefined {
    const record = asRecord(error)
    const nestedError = asRecord(record?.error)
    const response = asRecord(record?.response)
    const cause = asRecord(record?.cause)
    for (const candidate of [
        record?.status,
        record?.statusCode,
        response?.status,
        nestedError?.status,
        nestedError?.statusCode,
        cause?.status,
        cause?.statusCode,
    ]) {
        const status = typeof candidate === "number" ? candidate : Number(candidate)
        if (Number.isInteger(status) && status >= 100 && status <= 599) return status
    }

    const message = extractErrorMessage(error)
    const match =
        message.match(/^\s*(\d{3})\b/) ??
        message.match(/\b(?:HTTP|API\s+Error|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i) ??
        message.match(/"(?:status|code)"\s*:\s*(\d{3})/)
    if (!match) return undefined
    const status = Number(match[1])
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    const record = asRecord(error)
    const nestedError = asRecord(record?.error)
    const cause = asRecord(record?.cause)
    return String(record?.message ?? nestedError?.message ?? cause?.message ?? "")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}
