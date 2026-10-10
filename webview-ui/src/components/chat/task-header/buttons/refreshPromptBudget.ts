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
const DEFAULT_CURRENCY = "USD"
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
    CNY: "¥",
    EUR: "€",
    GBP: "£",
    USD: "$",
}

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

    const currency = normalizeCurrency(input.currency)
    const symbol = formatCurrencySymbol(currency)
    const estimatedCost = (input.estimatedInputTokens / MILLION_UNIT) * input.inputPrice
    return {
        tokenLine,
        priceLine: `≈ ${formatCurrencyAmount(symbol, estimatedCost, 4)}`,
        inputPriceLine: `Input price: ${formatCurrencyAmount(symbol, input.inputPrice, 2)} / 1M tokens`,
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
 * Normalize a currency code for display.
 * @param currency Optional raw currency code.
 * @returns Uppercase currency code, defaulting to USD.
 */
function normalizeCurrency(currency: string | undefined): string {
    return currency?.trim().toUpperCase() || DEFAULT_CURRENCY
}

/**
 * Format currency symbol using the same common symbols as the task header.
 * @param currency Normalized currency code.
 * @returns Currency symbol for known currencies, dollar fallback otherwise.
 */
function formatCurrencySymbol(currency: string): string {
    return CURRENCY_SYMBOLS[currency] || "$"
}

/**
 * Format a currency amount with spacing between symbol and number.
 * @param symbol Currency symbol to display.
 * @param amount Numeric amount to format.
 * @param fractionDigits Number of decimal places to keep.
 * @returns Currency display without redundant currency suffix.
 */
function formatCurrencyAmount(symbol: string, amount: number, fractionDigits: number): string {
    return `${symbol} ${amount.toFixed(fractionDigits)}`
}

/**
 * Check whether pricing can produce a useful budget estimate.
 * @param price Optional input price per million tokens.
 * @returns True when price is finite and positive.
 */
function isUsablePrice(price: number | undefined): price is number {
    return typeof price === "number" && Number.isFinite(price) && price > 0
}
