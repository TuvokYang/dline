/**
 * DeepSeek provider model definitions.
 * Extracted from api.ts deepSeekModels (lines 2213-2238).
 */
import type { ModelInfo } from "@shared/api"
import { ApiFormat, type PriceSet, PricingDayRule, ServerTool } from "@shared/proto/dline/models/metadata"
import { timeOfDayPricing } from "./pricing"

export const DEEPSEEK_REASONING_EFFORT_OPTIONS = ["low", "high", "max"] as const

/**
 * The windows the seller bills at the full rate instead of the default.
 *
 * DeepSeek publishes 01:00-04:00 and 06:00-10:00 UTC on weekdays, excluding
 * Chinese public holidays. Expressed as minutes from midnight in the seller's
 * own UTC+8, that is 09:00-12:00 and 14:00-18:00 local. The two periods never
 * overlap, so an instant bills at exactly one rate.
 * @see https://api-docs.deepseek.com/quick_start/pricing/
 */
const DEEPSEEK_PEAK_WINDOWS = [
    { startMinute: 9 * 60, endMinute: 12 * 60 },
    { startMinute: 14 * 60, endMinute: 18 * 60 },
]

/**
 * Peak/off-peak schedule for the direct DeepSeek endpoint.
 *
 * The seller charges the default rate on weekends and whole public holidays.
 * The schedule names the CN calendar instead of duplicating its dates here.
 */
function deepSeekSchedule() {
    return {
        timezoneOffsetMinutes: 8 * 60,
        dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
        defaultOnPublicHolidays: true,
        holidayCalendar: "CN",
    } as const
}

/**
 * Time-of-day pricing in CNY with the seller's published peak rates.
 *
 * The seller publishes two daily peak periods, so both become windows over one
 * default rate. Off-peak values are written out instead of derived from a
 * multiplier: the catalog is the price authority, and a derived value cannot
 * express a seller that discounts by anything other than half.
 */
function deepSeekPricing(peak: PriceSet, offPeak: PriceSet) {
    return timeOfDayPricing({
        schedule: deepSeekSchedule(),
        defaultPrices: offPeak,
        timeWindows: DEEPSEEK_PEAK_WINDOWS.map((window) => ({ ...window, prices: peak })),
        currency: "CNY",
    })
}

/** Declared thinking capability for the seeded DeepSeek models. */
function thinkingCapabilities() {
    return {
        supported: true,
        mode: "effort",
        effortLevels: [...DEEPSEEK_REASONING_EFFORT_OPTIONS],
        defaultEnabled: true,
        canDisable: true,
        defaultEffort: "high",
    }
}

/**
 * Hosted Web Search declaration per model.
 *
 * The declaration is the only authority the routing plan reads, and a hosted route
 * withholds the local `web_search` tool. Declaring search for a model the provider
 * cannot run it on therefore removes both routes at once.
 *
 * DeepSeek documents hosted search for `deepseek-v4-pro` only: in the Responses API
 * `web_search` is "supported with deepseek-v4-pro ... ignored with deepseek-flash".
 * The Anthropic-compatible surface rejects the declaration outright. Flash keeps no
 * declaration so Auto mode falls back to Dline's local search executor, and Chat
 * Completions carries no hosted search for either model.
 * @see https://api-docs.deepseek.com/guides/responses_api
 */
export const deepSeekModels: Record<string, ModelInfo> = {
    "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "deepseek-v4-pro",
        capabilities: {
            supportsTools: true,
            maxTokens: 384_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            supportsReasoning: true,
            thinking: thinkingCapabilities(),
            tools: [ServerTool.WEB_SEARCH],
        },
        apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
        // Published CNY / 1M tokens, verified 2026-11-03. Cache-write has no
        // separate published rate and remains absent rather than fabricated.
        pricing: deepSeekPricing(
            { inputPrice: 9, outputPrice: 27, cacheReadPrice: 0.3 },
            { inputPrice: 4.5, outputPrice: 13.5, cacheReadPrice: 0.15 },
        ),
    },
    "deepseek-flash": {
        id: "deepseek-flash",
        name: "deepseek-flash",
        capabilities: {
            supportsTools: true,
            maxTokens: 384_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            thinking: thinkingCapabilities(),
            // No hosted tools: `web_search` is ignored for this model, so declaring it
            // would route Auto to a hosted search that never runs and hide the local one.
        },
        apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
        pricing: deepSeekPricing(
            { inputPrice: 2, outputPrice: 8, cacheReadPrice: 0.04 },
            { inputPrice: 1, outputPrice: 4, cacheReadPrice: 0.02 },
        ),
    },
}

/** Default model ID for DeepSeek provider */
export const deepSeekDefaultModelId = "deepseek-flash"
