/**
 * Shared presentation rules for task-history rows.
 *
 * The Recent preview and the History view render the same underlying task
 * metadata, so the completion verdict and the cost/token label must be derived
 * in exactly one place. Previously each panel re-implemented both rules and
 * they drifted apart.
 */

/** Minimal shape both history panels can supply. */
export interface TaskUsageSummary {
    totalCost?: number
    currency?: string
    tokensIn?: number
    tokensOut?: number
    cacheWrites?: number
    cacheReads?: number
}

/** Completion-carrying fields of a task row. */
export interface TaskCompletionSummary {
    isCompleted?: boolean
    /** Present only once a canonical completion projection exists. */
    completionStateRevision?: number
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥", EUR: "€", GBP: "£" }

/** Resolve the display symbol for a task's billing currency. */
export function getCostSymbol(currency?: string): string {
    return CURRENCY_SYMBOLS[currency?.trim().toUpperCase() ?? ""] ?? "$"
}

/**
 * Report whether a row carries an authoritative completion verdict.
 *
 * Rows written before the completion projection existed carry a bare
 * `isCompleted` with no revision; those are not authoritative and must not
 * render a checkmark.
 */
export function isTaskCompleted(item: TaskCompletionSummary): boolean {
    return item.completionStateRevision !== undefined && item.isCompleted === true
}

/** Total tokens billed across input, output and both cache directions. */
export function getTotalTokens(item: TaskUsageSummary): number {
    return (item.tokensIn ?? 0) + (item.tokensOut ?? 0) + (item.cacheWrites ?? 0) + (item.cacheReads ?? 0)
}

/** Compact token count, e.g. `1.2k`. */
export function formatTokenCount(tokens: number): string {
    if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}b`
    if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}m`
    if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`
    return String(tokens)
}

export interface TaskUsageLabel {
    readonly kind: "cost" | "tokens"
    readonly text: string
    readonly title: string
}

/**
 * Build the badge label for one task row.
 *
 * A zero cost means the run had no billable price — either a free/local model
 * or a provider without pricing metadata — so a bare `$0.00` carries no
 * information. Those rows show the tokens actually consumed instead.
 *
 * @param item Usage metadata of the task row.
 * @param fractionDigits Decimal places used when a real cost exists.
 * @returns The label to render, or undefined when there is nothing to show.
 */
export function getTaskUsageLabel(item: TaskUsageSummary, fractionDigits = 2): TaskUsageLabel | undefined {
    const cost = item.totalCost ?? 0
    if (Number.isFinite(cost) && cost > 0) {
        return {
            kind: "cost",
            text: `${getCostSymbol(item.currency)}${cost.toFixed(fractionDigits)}`,
            title: "Total cost",
        }
    }

    const tokens = getTotalTokens(item)
    if (tokens <= 0) return undefined
    return {
        kind: "tokens",
        text: `${formatTokenCount(tokens)} tokens`,
        title: `Total tokens: ${tokens.toLocaleString()}`,
    }
}
