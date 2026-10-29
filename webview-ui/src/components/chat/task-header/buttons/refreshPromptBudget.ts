import { formatCurrencyAmount } from "@/utils/currency"

export interface RefreshPromptBudgetInput {
    estimatedInputTokens: number
    inputPrice?: number
    currency?: string
}

export interface RefreshPromptBudgetView {
    tokenLine: string
    priceLine?: string
    inputPriceLine?: string
}

const TOKEN_UNIT = 1_000
const MILLION_UNIT = 1_000_000

/**
 * Build display lines for the refresh prompt cache budget dialog.
 * @param input Estimated miss tokens and optional pricing metadata.
 * @returns Prominent token and optional price display lines.
 */
export function buildRefreshPromptBudget(input: RefreshPromptBudgetInput): RefreshPromptBudgetView {
    const tokenLine = `${formatTokenAmount(input.estimatedInputTokens)} input tokens`
    if (!isUsablePrice(input.inputPrice)) {
        return { tokenLine }
    }

    const estimatedCost = (input.estimatedInputTokens / MILLION_UNIT) * input.inputPrice
    return {
        tokenLine,
        priceLine: `≈ ${formatCurrencyAmount(estimatedCost, input.currency, 4)}`,
        inputPriceLine: `Input price: ${formatCurrencyAmount(input.inputPrice, input.currency, 2)} / 1M tokens`,
    }
}

/**
 * Format token counts with one scale only.
 * @param tokens Raw token count.
 * @returns Token count formatted as K below one million, otherwise M.
 */
function formatTokenAmount(tokens: number): string {
    const safeTokens = Math.max(0, tokens)
    if (safeTokens >= MILLION_UNIT) {
        return `${formatScaledNumber(safeTokens / MILLION_UNIT)}M`
    }

    return `${formatScaledNumber(safeTokens / TOKEN_UNIT)}K`
}

/**
 * Format a scaled number without noisy trailing zeros.
 * @param value Numeric value to format.
 * @returns Compact one-decimal string when needed.
 */
function formatScaledNumber(value: number): string {
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
}

/**
 * Check whether pricing can produce a useful budget estimate.
 * @param price Optional input price per million tokens.
 * @returns True when price is finite and positive.
 */
function isUsablePrice(price: number | undefined): price is number {
    return typeof price === "number" && Number.isFinite(price) && price > 0
}
