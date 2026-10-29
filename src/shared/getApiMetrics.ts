import { UiMessage } from "./ExtensionMessage"

export interface ApiMetrics {
    totalTokensIn: number
    totalTokensOut: number
    totalCacheWrites?: number
    totalCacheReads?: number
    totalCost: number
    cacheHitRate?: number
    currency?: string
    activeSeconds?: number
    requestsPerMinute?: number
    tokensPerMinute?: number
}

/**
 * Calculates API metrics from an array of ClineMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of UiMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: UiMessage[]): ApiMetrics {
    const result: ApiMetrics = {
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCacheWrites: undefined,
        totalCacheReads: undefined,
        totalCost: 0,
    }

    messages.forEach((message) => {
        if (
            message.type === "say" &&
            (message.say === "api_req_started" || message.say === "deleted_api_reqs" || message.say === "subagent_usage") &&
            message.text
        ) {
            try {
                const parsedData = JSON.parse(message.text)
                const { tokensIn, tokensOut, cacheWrites, cacheReads, cost } = parsedData

                if (typeof tokensIn === "number") {
                    result.totalTokensIn += tokensIn
                }
                if (typeof tokensOut === "number") {
                    result.totalTokensOut += tokensOut
                }
                if (typeof cacheWrites === "number") {
                    result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
                }
                if (typeof cacheReads === "number") {
                    result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
                }
                if (typeof cost === "number") {
                    result.totalCost += cost
                }
                // Extract currency from the first message that has it
                if (!result.currency && typeof parsedData.currency === "string") {
                    result.currency = parsedData.currency
                }
            } catch {
                // Ignore JSON parse errors
            }
        }
    })

    // Calculate overall cache hit rate
    const totalInput = result.totalTokensIn + (result.totalCacheWrites ?? 0) + (result.totalCacheReads ?? 0)
    if (totalInput > 0 && result.totalCacheReads !== undefined) {
        result.cacheHitRate = (result.totalCacheReads / totalInput) * 100
    }

    return result
}

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * @param messages - An array of UiMessage objects to process.
 * @returns The total tokens (tokensIn + tokensOut + cacheWrites + cacheReads) from the last api_req_started message, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: UiMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.type === "say" && msg.say === "api_req_started" && msg.text) {
            try {
                const { tokensIn, tokensOut, cacheWrites, cacheReads } = JSON.parse(msg.text)
                const total = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
                if (total > 0) {
                    return total
                }
            } catch {
                // Ignore JSON parse errors, continue searching
            }
        }
    }
    return 0
}

/**
 * Gets the last task_progress text from the message list.
 * Used as a fallback when taskState.currentFocusChainChecklist is null.
 *
 * @param messages - An array of UiMessage objects to search.
 * @returns The text of the last task_progress message, or null if none found.
 */
export function getLastTaskProgressText(messages: UiMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.type === "say" && m.say === "task_progress" && m.text) {
            return m.text
        }
    }
    return null
}
