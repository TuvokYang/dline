import type { ModelInfo } from "@shared/api"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
	USD: "$",
	CNY: "¥",
	EUR: "€",
	GBP: "£",
}

/** Resolve a compact display symbol without silently changing the declared currency. */
export const getCurrencySymbol = (currency?: string): string => {
	const code = currency?.trim().toUpperCase() || "USD"
	return CURRENCY_SYMBOLS[code] ?? `${code} `
}

/**
 * Formats a price as a currency string.
 */
export const formatPrice = (price: number, currency = "USD") => {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.trim().toUpperCase() || "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(price)
}

/**
 * Helper function to format token prices for display.
 * @param price The price per million tokens.
 * @param currency ISO 4217 billing currency.
 */
export const formatTokenPrice = (price: number, currency = "USD") => {
	return `${formatPrice(price, currency)}/million tokens`
}

/**
 * Helper function to determine if a model supports thinking budget
 */
export const hasThinkingBudget = (modelInfo: ModelInfo): boolean => {
	const capabilities = modelInfo.capabilities
	const thinking = capabilities?.thinking
	return (
		capabilities?.supportsReasoning !== false &&
		thinking?.supported === true &&
		(thinking.mode === "budget" || thinking.mode === "both") &&
		resolveThinkingBudgetBounds(thinking) !== undefined
	)
}

/**
 * Helper function to check if a model supports images
 */
export const supportsImages = (modelInfo: ModelInfo): boolean => {
	return !!modelInfo.capabilities?.supportsImages
}

/**
 * Helper function to check if a model supports browser use
 */
export const supportsBrowserUse = (modelInfo: ModelInfo): boolean => {
	const tools = modelInfo.capabilities?.tools as Array<ServerTool | string> | undefined
	const supportsWebSearch = tools?.some((tool) => tool === ServerTool.WEB_SEARCH || String(tool).toUpperCase() === "WEB_SEARCH")
	return !!modelInfo.capabilities?.supportsImages || supportsWebSearch === true
}

/**
 * Helper function to check if a model supports prompt caching
 */
export const supportsPromptCache = (modelInfo: ModelInfo): boolean => {
	return !!modelInfo.capabilities?.supportsPromptCache
}

/**
 * Helper function to format token limits for display
 */
export const formatTokenLimit = (limit: number): string => {
	return limit.toLocaleString()
}

/**
 * Parses a price input string to a number, handling edge cases like
 * incomplete decimals (e.g., ".", ".5", "0.") gracefully.
 *
 * @param value - The input string to parse
 * @param defaultValue - The fallback value if input is empty or invalid
 * @returns A valid number, or the default value if parsing fails
 */
export const parsePrice = (value: string, defaultValue: number): number => {
	if (value === "" || value === ".") {
		return defaultValue
	}
	const num = Number.parseFloat(value)
	return Number.isNaN(num) ? defaultValue : num
}
