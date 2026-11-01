/**
 * OpenCode declarations the gateway listing cannot state.
 *
 * The model set, limits, capabilities, prices and accepted protocols all come
 * from `GET https://opencode.ai/inference/v1/models`, read by
 * `model-registry/remote/vendors/opencode.ts`. This file keeps only the facts a
 * listing cannot express:
 *
 * - which models a subscription plan covers;
 * - which pricing mode a plan uses, since a Go Profile pays a plan rather than
 *   per-request rates;
 * - which model a plan defaults to;
 * - the thinking control a model declares, which the listing reports only as a
 *   reasoning flag with no effort levels or budget bounds;
 * - provider-hosted tools, which the listing does not mention at all.
 *
 * Hand-copied limits and prices used to live here and drifted from the live
 * listing, so they are deliberately absent now: a wrong number is worse than a
 * value read at discovery time.
 */
import type { ModelInfo } from "@shared/api"
import { ApiFormat, ServerTool, type ThinkingConfig } from "@shared/proto/dline/models/metadata"

/**
 * Wire protocols the Console gateway accepts for every paid text model.
 *
 * GEMINI_CHAT is excluded on purpose: the Gemini endpoint exists, but this build
 * has no Gemini tool-schema path for OpenCode yet, so declaring it would let the
 * user select a protocol that cannot carry tools.
 */
export const OPENCODE_API_FORMATS = [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT] as const

/** Effort-style reasoning: the user picks a level, and the provider default applies when unset. */
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

/** Budget-style reasoning: the seller accepts a token budget without publishing the levels. */
function budgetThinking(): ThinkingConfig {
    return { supported: true, mode: "budget", defaultEnabled: true }
}

/** Provider-hosted tools the gateway runs outside Dline's local executor. */
const HOSTED_TOOLS = [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH]

/** Thinking control each known model declares, keyed by model id. */
const THINKING: Readonly<Record<string, ThinkingConfig>> = {
    "gpt-6-astra": effortThinking(["low", "medium", "high", "xhigh", "max"]),
    "gpt-6-sol": effortThinking(["none", "low", "medium", "high", "xhigh", "max"]),
    "gpt-6.1-sol": effortThinking(["low", "medium", "high", "xhigh", "max"]),
    "gpt-6-luna": effortThinking(["none", "low", "medium", "high", "xhigh", "max"]),
    "claude-sonnet-5-5": effortThinking(["low", "medium", "high"]),
    "claude-opus-5": effortThinking(["low", "medium", "high"]),
    "claude-haiku-5": effortThinking(["low", "medium", "high"]),
    "gemini-4.0-pro": effortThinking(["low", "high"]),
    "qwen3.8-max": effortThinking(["low", "medium", "xhigh"]),
    "qwen3.8-flash": effortThinking(["low", "medium", "xhigh"]),
    "qwen3.6-plus": budgetThinking(),
    "qwen3.5-plus": budgetThinking(),
    "mistral-large-4": effortThinking(["none", "high"]),
    "muse-wonder-1.0": effortThinking(["minimal", "low", "medium", "high", "xhigh", "max"]),
    "muse-spark-1.3": effortThinking(["minimal", "low", "medium", "high", "xhigh"]),
    "muse-spark-1.2": effortThinking(["minimal", "low", "medium", "high", "xhigh"]),
}

/** One model's declarations, which the gateway listing cannot carry. */
export interface OpenCodeCatalogDeclaration {
    readonly tools?: readonly ServerTool[]
    readonly thinking?: ThinkingConfig
}

/**
 * Declarations for one model.
 *
 * Undefined means the listing carries this model but this file does not describe
 * it, so a newly released model still reaches the picker with the listing's own
 * limits and prices.
 */
export function openCodeCatalogDeclaration(modelId: string): OpenCodeCatalogDeclaration | undefined {
    const thinking = THINKING[modelId]
    if (!thinking) {
        return undefined
    }
    return { tools: HOSTED_TOOLS, thinking }
}

/**
 * Seed catalog for a first start with no discovered catalog on disk.
 *
 * Only identity and the declaration shape are present: limits, prices and
 * protocols arrive when the listing is fetched. A seed entry therefore reports
 * no price and no context window instead of a stale number.
 */
function declarationSeed(modelId: string): ModelInfo {
    const declaration = openCodeCatalogDeclaration(modelId)
    return {
        id: modelId,
        name: modelId,
        capabilities: {
            supportsTools: true,
            ...(declaration?.tools ? { tools: [...declaration.tools] } : {}),
            supportsReasoning: declaration?.thinking !== undefined,
            ...(declaration?.thinking ? { thinking: declaration.thinking } : {}),
        },
    }
}

export const openCodeModels: Record<string, ModelInfo> = Object.fromEntries(
    Object.keys(THINKING).map((modelId) => [modelId, declarationSeed(modelId)]),
)
