import type { BillableTokens, ResolvedPrices } from "./types"

const TOKENS_PER_PRICE_UNIT = 1_000_000

/**
 * Cost of one request.
 *
 * Prices are quoted per million tokens; every term is a slot count multiplied by
 * its own unit price, so a thinking budget of zero removes that term without a
 * separate branch. Whether a thinking price exists is decided by the caller
 * through `resolveThinkingPrice`.
 *
 * @param prices Prices resolved for this request.
 * @param tokens Token counts already mapped onto price slots.
 * @returns The request cost in `prices.currency`.
 */
export function costOf(prices: ResolvedPrices, tokens: BillableTokens): number {
    const inputCost = (prices.inputPrice / TOKENS_PER_PRICE_UNIT) * tokens.regularInput
    const outputCost = (prices.outputPrice / TOKENS_PER_PRICE_UNIT) * tokens.output
    const thinkingCost = (resolveThinkingPrice(prices) / TOKENS_PER_PRICE_UNIT) * tokens.thinking
    const cacheWriteCost = (prices.cacheWritePrice / TOKENS_PER_PRICE_UNIT) * tokens.cacheWrite
    const cacheReadCost = (prices.cacheReadPrice / TOKENS_PER_PRICE_UNIT) * tokens.cacheRead
    return inputCost + outputCost + thinkingCost + cacheWriteCost + cacheReadCost
}

/**
 * Output price that applies to thinking tokens.
 *
 * A model without a separate thinking price bills thinking tokens at the normal
 * output rate instead of free, which matches how every published price list
 * treats reasoning output.
 *
 * @param prices Prices resolved for this request.
 * @returns The unit price for thinking output.
 */
export function resolveThinkingPrice(prices: ResolvedPrices): number {
    return prices.thinkingOutputPrice ?? prices.outputPrice
}
