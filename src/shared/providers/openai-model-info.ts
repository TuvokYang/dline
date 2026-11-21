import type { ModelInfo } from "@shared/proto/dline/models"
import type { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { mergeDefined } from "./effective-model-info"
import { inheritModelInfo } from "./model-inheritance"

/** Product compatibility choices, not a claim that every gateway accepts every effort. */
function compatibleThinking(thinking: ThinkingConfig | undefined): ThinkingConfig {
    if (thinking?.mode && (thinking.mode !== "effort" || thinking.effortLevels !== undefined)) {
        return { ...thinking, ...(thinking.effortLevels ? { effortLevels: [...thinking.effortLevels] } : {}) }
    }
    return mergeDefined<ThinkingConfig>(
        {
            supported: true,
            mode: "effort",
            effortLevels: ["none", "low", "medium", "high"],
            defaultEnabled: true,
            canDisable: true,
        },
        thinking ?? {},
    )
}

/**
 * Fill effective OpenAI metadata before Profile overrides are applied.
 *
 * Only cache and reasoning can inherit across a GPT minor version. Identity,
 * rates, limits, protocols and hosted tools remain the selected model's own.
 * Explicit false values and empty effort lists survive; an unselected effort
 * stays absent so enabling compatibility never fabricates a medium preference.
 */
export function resolveOpenAIModel(
    modelId: string,
    base: ModelInfo | undefined,
    models: Readonly<Record<string, ModelInfo>> = {},
): ModelInfo {
    const inherited = inheritModelInfo(modelId, base, models, "gpt")
    const capabilities = inherited.capabilities
    if (capabilities.supportsReasoning !== false && capabilities.thinking?.supported !== false) {
        capabilities.thinking = compatibleThinking(capabilities.thinking)
        capabilities.supportsReasoning ??= capabilities.thinking.supported
    }
    return { ...inherited, capabilities }
}
