import { UiMessage } from "./ExtensionMessage"

/**
 * One run of consecutive amounts that share a billing currency.
 *
 * A task can outlive the model it started on, so its cost is not one number in one unit. Amounts
 * are only ever summed inside a segment; two currencies are never added together, because that sum
 * would have no unit at all.
 */
export interface ApiCostSegment {
    /** Billing currency of this segment. Empty when the source reported an amount without one. */
    currency: string
    /** Sum of this segment's amounts, in `currency`. */
    totalCost: number
}

export interface ApiMetrics {
    totalTokensIn: number
    totalTokensOut: number
    totalCacheWrites?: number
    totalCacheReads?: number
    /** Sum of every recorded amount, regardless of currency. Use `costSegments` to display a unit. */
    totalCost: number
    cacheHitRate?: number
    currency?: string
    /**
     * Per-currency runs in the order they were recorded; the last one is the newest.
     *
     * Optional because a projection built from persisted task metadata has no segment history;
     * `getApiMetrics` always populates it. A consumer that needs a labelled amount must treat an
     * absent list as "no segmented history" and fall back to `totalCost` / `currency`.
     */
    costSegments?: ApiCostSegment[]
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
    // Kept local so the running segments are never read through an optional field.
    const costSegments: ApiCostSegment[] = []

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
                    const reportedCurrency = typeof parsedData.currency === "string" ? parsedData.currency.trim() : ""
                    const newestSegment = costSegments.at(-1)
                    // Consecutive amounts in the same currency stay one segment; a different
                    // currency starts a new one instead of being added to the previous total.
                    if (newestSegment && newestSegment.currency === reportedCurrency) {
                        newestSegment.totalCost += cost
                    } else {
                        costSegments.push({ currency: reportedCurrency, totalCost: cost })
                    }
                    result.currency = reportedCurrency || undefined
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

    result.costSegments = costSegments
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
