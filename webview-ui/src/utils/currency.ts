const COMPACT_CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
    USD: "$",
    CNY: "¥",
    EUR: "€",
    GBP: "£",
}

const UNAMBIGUOUS_CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
    ...COMPACT_CURRENCY_SYMBOLS,
    CNY: "CN¥",
    CNH: "CN¥",
    RMB: "CN¥",
    JPY: "JP¥",
}

/** Normalize an optional billing currency without inventing a non-ISO display value. */
export function normalizeCurrencyCode(currency?: string): string {
    return currency?.trim().toUpperCase() || "USD"
}

/** Resolve the compact symbol used by model configuration controls. */
export function getCurrencySymbol(currency?: string): string {
    const code = normalizeCurrencyCode(currency)
    return COMPACT_CURRENCY_SYMBOLS[code] ?? `${code} `
}

/**
 * Format a billed amount while preserving the model's declared currency.
 *
 * Yuan and yen share the `¥` glyph, so runtime metrics include an ISO prefix
 * instead of presenting one currency as the other. Unknown codes remain visible
 * rather than silently falling back to dollars or yuan.
 */
export function formatCurrencyAmount(amount: number, currency?: string, fractionDigits = 2): string {
    const code = normalizeCurrencyCode(currency)
    const symbol = UNAMBIGUOUS_CURRENCY_SYMBOLS[code] ?? `${code} `
    return `${symbol}${amount.toFixed(fractionDigits)}`
}
