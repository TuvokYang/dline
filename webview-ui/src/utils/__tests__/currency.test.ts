import { describe, expect, it } from "vitest"
import { formatCurrencyAmount, getCurrencySymbol, normalizeCurrencyCode } from "../currency"

describe("getCurrencySymbol", () => {
    it.each([
        ["USD", "$"],
        ["CNY", "¥"],
        ["EUR", "€"],
    ])("resolves %s to its bare symbol", (code, symbol) => {
        expect(getCurrencySymbol(code)).toBe(symbol)
    })

    it("normalizes case and whitespace from model metadata", () => {
        expect(getCurrencySymbol(" cny ")).toBe("¥")
    })

    it("treats a missing currency as US dollars", () => {
        expect(normalizeCurrencyCode(undefined)).toBe("USD")
        expect(getCurrencySymbol("")).toBe("$")
    })

    it("names an unlisted currency instead of borrowing another symbol", () => {
        expect(getCurrencySymbol("CHF")).toBe("CHF ")
    })
})

describe("formatCurrencyAmount", () => {
    it("prefixes the model currency symbol with the requested precision", () => {
        expect(formatCurrencyAmount(0.0123, "CNY", 4)).toBe("¥0.0123")
        expect(formatCurrencyAmount(1.5, "EUR")).toBe("€1.50")
    })

    it("groups thousands so large balances stay readable", () => {
        expect(formatCurrencyAmount(1234.5, "CNY")).toBe("¥1,234.50")
    })

    it("places the minus sign before the symbol", () => {
        expect(formatCurrencyAmount(-0.25, "USD")).toBe("-$0.25")
    })

    it("keeps an unlisted currency code visible", () => {
        expect(formatCurrencyAmount(2, "CHF")).toBe("CHF 2.00")
    })
})
