/**
 * Z.AI (International) provider model definitions.
 *
 * Mirrors `zai-cn.ts` so a Profile keeps the same choices when it switches
 * region. `glm-5.3` is the current flagship and always runs with thinking
 * enabled; `glm-5.1` has no documentation page and is no longer reachable, and
 * the `glm-4.x` family is superseded by GLM-5.
 *
 * Source: https://docs.z.ai/guides/overview/migrate-to-glm-new
 */
import type { ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { flatPricing } from "./pricing"

export const internationalZAiModels: Record<string, ModelInfo> = {
    "glm-5.3": {
        id: "glm-5.3",
        name: "glm-5.3",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            // GLM-5.3 rejects `thinking.type: "disabled"`; the model is always on.
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "enabled" }),
        },
        pricing: flatPricing(1.4, 4.4, undefined, 0.26),
    },
    "glm-5.2": {
        id: "glm-5.2",
        name: "glm-5.2",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "enabled" }),
        },
        pricing: flatPricing(1.2, 3.8, undefined, 0.22),
    },
    "glm-5": {
        id: "glm-5",
        name: "glm-5",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "enabled" }),
        },
        pricing: flatPricing(1.0, 3.2, undefined, 0.2),
    },
    "glm-4.7": {
        id: "glm-4.7",
        name: "glm-4.7",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "enabled" }),
        },
        pricing: flatPricing(0.6, 2.2, undefined, 0.11),
    },
}

/** Default model IDs for ZAi international provider */
export const internationalZAiDefaultModelId = "glm-5.3"
