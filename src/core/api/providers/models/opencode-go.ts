/**
 * OpenCode Go (subscription plan) model catalog.
 *
 * Verified 2026-10-31 against the official Go page:
 * https://opencode.ai/docs/console/go/
 *
 * A Go Profile pays a monthly plan instead of per-request rates, so every paid
 * entry declares `subscription` and carries no price numbers. The token prices
 * the plan page lists are the rate at which usage counts against the monthly
 * dollar allowance, not a bill; writing them into the catalog would report a
 * charge the user never incurs.
 *
 * DeepSeek is the exception inside the catalog shape: the plan publishes two
 * rate cards for it, and only those two models therefore declare a schedule.
 * Their off-peak rate is half the peak rate, matching the seller's own page.
 *
 * Free models are absent: they require the OpenCode client and answer 403 to
 * other harnesses.
 *
 * Context limits are absent because the Go page publishes only prices and
 * allowances, never token limits. An absent limit is reported as unknown; a
 * guessed one would silently misconfigure compaction.
 */
import type { ModelInfo } from "@shared/api"
import { ApiFormat, ServerTool, type ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { priceSet, subscriptionPricing, timeOfDayPricing } from "./pricing"

/** Protocols the Go gateway accepts for every paid text model. */
export const OPENCODE_GO_API_FORMATS = [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT] as const

/**
 * The windows Go bills at the full rate for DeepSeek.
 *
 * The page states 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday, with
 * the discounted rate for all other hours including weekends. Unlike the direct
 * DeepSeek endpoint, Go does not mention holidays, so the schedule names no
 * calendar. The two periods never overlap.
 * @see https://opencode.ai/docs/console/go/
 */
const OPENCODE_GO_PEAK_WINDOWS = [
    { startMinute: 1 * 60, endMinute: 4 * 60 },
    { startMinute: 6 * 60, endMinute: 10 * 60 },
]

function effortThinking(effortLevels: readonly string[], defaultEffort = "high"): ThinkingConfig {
    return {
        supported: true,
        mode: "effort",
        effortLevels: [...effortLevels],
        defaultEnabled: true,
        canDisable: effortLevels.includes("none"),
        defaultEffort,
    }
}

function budgetThinking(): ThinkingConfig {
    return { supported: true, mode: "budget", defaultEnabled: true }
}

interface GoModelFacts {
    readonly id: string
    readonly supportsImages?: boolean
    readonly supportsPromptCache?: boolean
    readonly thinking?: ThinkingConfig
}

/**
 * One Go entry.
 *
 * `maxTokens` and `contextWindow` stay absent on purpose: the Go page publishes
 * neither, and inventing them would make compaction disagree with the gateway.
 */
function goModel(facts: GoModelFacts, pricing: ModelInfo["pricing"]): ModelInfo {
    return {
        id: facts.id,
        name: facts.id,
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            supportsImages: facts.supportsImages === true,
            supportsPromptCache: facts.supportsPromptCache === true,
            supportsReasoning: facts.thinking !== undefined,
            ...(facts.thinking === undefined ? {} : { thinking: facts.thinking }),
        },
        apiFormats: [...OPENCODE_GO_API_FORMATS],
        pricing,
    }
}

/**
 * DeepSeek on Go: a subscription whose usage counts at a peak or off-peak rate.
 *
 * The plan covers the request, so the model stays a subscription for billing.
 * The schedule is recorded because the console reports usage in dollars and the
 * same request consumes half the allowance off-peak.
 */
function deepSeekOnGo(peak: readonly [number, number, number, number], offPeak: readonly [number, number, number, number]) {
    const peakPrices = priceSet(...peak)
    return timeOfDayPricing({
        schedule: {
            timezoneOffsetMinutes: 0,
            dayRule: 1,
            defaultOnPublicHolidays: false,
            holidayCalendar: "",
        },
        defaultPrices: priceSet(...offPeak),
        timeWindows: OPENCODE_GO_PEAK_WINDOWS.map((window) => ({ ...window, prices: peakPrices })),
        currency: "USD",
    })
}

/** The plan covers the model, so no per-request cost is computed. */
const GO_SUBSCRIPTION = subscriptionPricing()

export const openCodeGoModels: Record<string, ModelInfo> = {
    "grok-4.7": goModel(
        { id: "grok-4.7", supportsImages: true, thinking: effortThinking(["low", "medium", "high", "xhigh"]) },
        GO_SUBSCRIPTION,
    ),
    "glm-5.3-flash": goModel(
        { id: "glm-5.3-flash", supportsImages: true, thinking: effortThinking(["low", "high", "max"]) },
        GO_SUBSCRIPTION,
    ),
    "glm-5.3": goModel({ id: "glm-5.3", thinking: effortThinking(["low", "high", "max"]) }, GO_SUBSCRIPTION),
    "glm-5.2": goModel({ id: "glm-5.2", thinking: effortThinking(["low", "high", "max"]) }, GO_SUBSCRIPTION),
    "gpt-6-luna": goModel(
        {
            id: "gpt-6-luna",
            supportsPromptCache: true,
            thinking: effortThinking(["none", "low", "medium", "high", "xhigh", "max"]),
        },
        GO_SUBSCRIPTION,
    ),
    "gpt-5.6-luna": goModel(
        {
            id: "gpt-5.6-luna",
            supportsPromptCache: true,
            thinking: effortThinking(["none", "low", "medium", "high", "xhigh", "max"]),
        },
        GO_SUBSCRIPTION,
    ),
    "claude-haiku-5-5": goModel(
        {
            id: "claude-haiku-5-5",
            supportsImages: true,
            supportsPromptCache: true,
            thinking: effortThinking(["low", "medium", "high", "xhigh", "max"]),
        },
        GO_SUBSCRIPTION,
    ),
    "gemini-4-argon": goModel(
        { id: "gemini-4-argon", thinking: effortThinking(["low", "medium", "high", "xhigh", "max"]) },
        GO_SUBSCRIPTION,
    ),
    "kimi-k3.1-pro": goModel({ id: "kimi-k3.1-pro", supportsPromptCache: true, thinking: budgetThinking() }, GO_SUBSCRIPTION),
    "kimi-k3": goModel(
        { id: "kimi-k3", supportsImages: true, supportsPromptCache: true, thinking: budgetThinking() },
        GO_SUBSCRIPTION,
    ),
    "kimi-k2.7-code": goModel({ id: "kimi-k2.7-code", supportsImages: true, thinking: budgetThinking() }, GO_SUBSCRIPTION),
    "longcat-2.0": goModel({ id: "longcat-2.0" }, GO_SUBSCRIPTION),
    "step-5-preview": goModel({ id: "step-5-preview" }, GO_SUBSCRIPTION),
    "mimo-v2.6-flash": goModel({ id: "mimo-v2.6-flash", supportsImages: true }, GO_SUBSCRIPTION),
    "mimo-v2.6-pro": goModel({ id: "mimo-v2.6-pro" }, GO_SUBSCRIPTION),
    "mimo-v2.5": goModel({ id: "mimo-v2.5" }, GO_SUBSCRIPTION),
    "mimo-v2.5-pro": goModel({ id: "mimo-v2.5-pro" }, GO_SUBSCRIPTION),
    "minimax-m3.1-flash": goModel({ id: "minimax-m3.1-flash" }, GO_SUBSCRIPTION),
    "minimax-m3": goModel({ id: "minimax-m3", supportsImages: true, thinking: budgetThinking() }, GO_SUBSCRIPTION),
    "muse-spark-1.3-contributor": goModel({ id: "muse-spark-1.3-contributor", supportsImages: true }, GO_SUBSCRIPTION),
    "muse-spark-1.2-contributor": goModel({ id: "muse-spark-1.2-contributor", supportsImages: true }, GO_SUBSCRIPTION),
    "qwen3.8-max": goModel(
        { id: "qwen3.8-max", supportsImages: true, thinking: effortThinking(["low", "medium", "xhigh"]) },
        GO_SUBSCRIPTION,
    ),
    "qwen3.8-flash": goModel(
        {
            id: "qwen3.8-flash",
            supportsImages: true,
            supportsPromptCache: true,
            thinking: effortThinking(["low", "medium", "xhigh"]),
        },
        GO_SUBSCRIPTION,
    ),
    "qwen3.7-plus": goModel(
        { id: "qwen3.7-plus", supportsImages: true, supportsPromptCache: true, thinking: budgetThinking() },
        GO_SUBSCRIPTION,
    ),
    "deepseek-v4.1-flash": goModel(
        { id: "deepseek-v4.1-flash", supportsImages: true, thinking: effortThinking(["low", "high", "max"]) },
        deepSeekOnGo([0.3, 1.2, 0, 0.006], [0.15, 0.6, 0, 0.003]),
    ),
    "deepseek-v4-pro": goModel({ id: "deepseek-v4-pro" }, deepSeekOnGo([1.32, 3.96, 0, 0.044], [0.66, 1.98, 0, 0.022])),
    "hy4-preview": goModel({ id: "hy4-preview" }, GO_SUBSCRIPTION),
    hy3: goModel({ id: "hy3" }, GO_SUBSCRIPTION),
}
