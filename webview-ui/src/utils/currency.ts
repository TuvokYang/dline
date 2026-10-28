/**
 * Display symbols for the billing currencies model metadata declares.
 *
 * `ModelInfo.pricing.currency` carries the ISO 4217 code; every surface that
 * shows a price or a cost resolves its symbol here, so one currency never
 * renders two different ways.
 */
const CURRENCY_SYMBOLS = {
    USD: "$",
    CNY: "¥",
    EUR: "€",
    GBP: "£",
} as const satisfies Readonly<Record<string, string>>

export type SupportedCurrencyCode = keyof typeof CURRENCY_SYMBOLS

/** Currency codes offered by pricing editors, in display order. */
export const SUPPORTED_CURRENCY_CODES = Object.keys(CURRENCY_SYMBOLS) as readonly SupportedCurrencyCode[]

const DEFAULT_CURRENCY_CODE: SupportedCurrencyCode = "USD"

const amountFormatters = new Map<number, Intl.NumberFormat>()

/** Normalize an optional billing currency without inventing a non-ISO display value. */
export function normalizeCurrencyCode(currency?: string): string {
    return currency?.trim().toUpperCase() || DEFAULT_CURRENCY_CODE
}

function isSupportedCurrencyCode(code: string): code is SupportedCurrencyCode {
    return Object.hasOwn(CURRENCY_SYMBOLS, code)
}

/**
 * Resolve the display symbol of a billing currency.
 *
 * An unknown code is shown as itself followed by a space rather than borrowing
 * another currency's symbol, so a price is never presented in the wrong unit.
 */
export function getCurrencySymbol(currency?: string): string {
    const code = normalizeCurrencyCode(currency)
    return isSupportedCurrencyCode(code) ? CURRENCY_SYMBOLS[code] : `${code} `
}

function getAmountFormatter(fractionDigits: number): Intl.NumberFormat {
    let formatter = amountFormatters.get(fractionDigits)
    if (!formatter) {
        // A fixed locale keeps grouping and the decimal mark aligned with the English UI.
        formatter = new Intl.NumberFormat("en-US", {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
        })
        amountFormatters.set(fractionDigits, formatter)
    }
    return formatter
}

/**
 * Format an amount in the given billing currency, e.g. `¥1,234.50` or `-$0.25`.
 *
 * @param amount Amount expressed in `currency`.
 * @param currency ISO 4217 code, normally `ModelInfo.pricing.currency`; defaults to USD.
 * @param fractionDigits Exact number of fraction digits to show.
 */
export function formatCurrencyAmount(amount: number, currency?: string, fractionDigits = 2): string {
    const sign = amount < 0 ? "-" : ""
    return `${sign}${getCurrencySymbol(currency)}${getAmountFormatter(fractionDigits).format(Math.abs(amount))}`
}
