import type { UiMessage } from "@shared/ExtensionMessage"

/** Model work whose failure the chat presents as an API error. */
export type ApiWork = "api_request" | "compaction"

/**
 * The single decision about which recorded API failures the chat still draws.
 *
 * A failed API request or compaction stays in the task's history, but once a
 * later attempt of the same work appears - Retry, an automatic retry, or a
 * later round - the chat stops drawing it. That holds whether or not the
 * failure was retryable: an account limit or a rejected key is not retried
 * automatically (see `isRetryableProviderError`), yet the request the user sends
 * after fixing it supersedes the error all the same. Repeated failures
 * therefore leave only the latest on screen.
 *
 * Rows that are not API failures (a tool error, a mistake limit, an
 * ignore-file refusal) are not decided here.
 *
 * Returns the indexes of the rows to hide; the rows themselves are untouched.
 */
export function supersededFailureIndexes(messages: readonly UiMessage[]): ReadonlySet<number> {
    const hidden = new Set<number>()
    const laterAttempt = new Set<ApiWork>()
    // An `api_req_failed` ask belongs to the request it follows; walking backwards it is
    // seen first and handed to the next request row reached.
    let requestFailureAhead = false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.type === "ask" && message.ask === "api_req_failed") requestFailureAhead = true
        const failed = apiFailureOf(message, requestFailureAhead)
        if (failed && laterAttempt.has(failed)) hidden.add(index)
        const attempted = attemptOf(message)
        if (attempted) laterAttempt.add(attempted)
        if (attempted === "api_request") requestFailureAhead = false
    }
    return hidden
}

/**
 * The work a row reports an API failure of, or undefined for any other row.
 * `ownFailureFollows` tells a request row that its failure was recorded as a
 * separate `api_req_failed` ask rather than in the row itself.
 */
export function apiFailureOf(message: UiMessage, ownFailureFollows = false): ApiWork | undefined {
    if (message.type !== "say") return undefined
    if (message.say === "api_req_started") {
        const failed = ownFailureFollows || Boolean(message.text && parseObject(message.text)?.streamingFailedMessage)
        return failed ? "api_request" : undefined
    }
    if (message.say === "tool" && message.text) {
        const card = compactionCardOf(message.text)
        return card?.compactionStatus === "failed" ? "compaction" : undefined
    }
    return undefined
}

/** The work a row is an attempt of, whatever its outcome. */
function attemptOf(message: UiMessage): ApiWork | undefined {
    if (message.type !== "say") return undefined
    if (message.say === "api_req_started") return "api_request"
    if (message.say === "tool" && message.text && compactionCardOf(message.text)) return "compaction"
    return undefined
}

function compactionCardOf(text: string): Record<string, unknown> | undefined {
    // Cheap pre-check: most tool rows are not compaction cards and need no parse.
    if (!text.includes("summarizeTask")) return undefined
    const card = parseObject(text)
    return card?.tool === "summarizeTask" ? card : undefined
}

function parseObject(text: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(text)
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined
    } catch {
        return undefined
    }
}
