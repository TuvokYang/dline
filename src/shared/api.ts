import { vertexModels } from "../core/api/providers/models/vertex"
import type { ModelInfo } from "./providers/types"
import type { TaskServiceTierOverride } from "./task-provider-overrides"
import type { TaskReasoningOverride } from "./task-reasoning"

export type ApiProvider =
    | "anthropic"
    | "claude-code"
    | "openrouter"
    | "bedrock"
    | "vertex"
    | "openai"
    | "ollama"
    | "lmstudio"
    | "gemini"
    | "openai-codex"
    | "requesty"
    | "together"
    | "deepseek"
    | "qwen"
    | "qwen-code"
    | "doubao"
    | "mistral"
    | "vscode-lm"
    | "cline"
    | "litellm"
    | "moonshot"
    | "nebius"
    | "fireworks"
    | "asksage"
    | "xai"
    | "sambanova"
    | "cerebras"
    | "sapaicore"
    | "groq"
    | "huggingface"
    | "huawei-cloud-maas"
    | "dify"
    | "baseten"
    | "vercel-ai-gateway"
    | "zai"
    | "oca"
    | "aihubmix"
    | "minimax"
    | "hicap"
    | "nousResearch"
    | "wandb"

export const DEFAULT_API_PROVIDER = "openrouter" as ApiProvider

/**
 * Provider+model configuration driven by ApiProfile.
 * All provider-specific fields (apiKey, baseUrl, modelId, modelInfo, etc.)
 * are now sourced from ApiProfile + ModelRegistry at runtime.
 */
export interface ApiConfiguration {
    /** Stable Profile identity for plan mode. */
    planModeProfileId?: string
    /** Legacy/display Profile name for plan mode. */
    planModeProfile?: string
    /** Stable Profile identity for act mode. */
    actModeProfileId?: string
    /** Legacy/display Profile name for act mode. */
    actModeProfile?: string
    /** Stable Profile identity for image generation. */
    imageProfileId?: string
    /** Legacy/display Profile name for image generation. */
    imageProfile?: string
    /** Task-local reasoning override for plan mode. */
    planModeReasoningOverride?: TaskReasoningOverride
    /** Task-local reasoning override for act mode. */
    actModeReasoningOverride?: TaskReasoningOverride
    /** Task-local OpenAI service tier override for plan mode. */
    planModeServiceTierOverride?: TaskServiceTierOverride
    /** Task-local OpenAI service tier override for act mode. */
    actModeServiceTierOverride?: TaskServiceTierOverride
    /** Stable workspace identity for provider-side routing affinity. */
    workspaceId?: string
    /** Task identifier */
    ulid?: string
    /** Retry callback */
    onRetryAttempt?: (attempt: number, maxRetries: number, delay: number, error: any) => void
    /** Global request timeout (ms) */
    requestTimeoutMs?: number
    /** Whether parallel tool calling is enabled */
    enableParallelToolCalling?: boolean
    /** Report estimated streaming token activity for Task-local rate metrics. */
    onStreamEstimatedTokens?: (tokens: number) => void
}

// ModelInfo type re-exported from proto/dline/models (canonical source)
export type { ModelInfo } from "./proto/dline/models"
export type { ModelCapabilities, ModelPricing, ThinkingConfig } from "./proto/dline/models/metadata"

/**
 * Provider-specific constants and types are now defined in their respective
 * model files under src/core/api/providers/models/.  This file re-exports
 * them for backward compatibility.
 */

// Anthropic constants (used by webview-ui)
export {
    ANTHROPIC_FAST_MODE_SUFFIX,
    ANTHROPIC_MAX_THINKING_BUDGET,
    ANTHROPIC_MIN_THINKING_BUDGET,
    anthropicDefaultModelId,
    anthropicModelInfoSaneDefaults,
    CLAUDE_SONNET_1M_SUFFIX,
} from "../core/api/providers/models/anthropic"
export { askSageDefaultModelId, askSageDefaultURL } from "../core/api/providers/models/asksage"
export { basetenDefaultModelId } from "../core/api/providers/models/baseten"
export { bedrockDefaultModelId } from "../core/api/providers/models/bedrock"
export { cerebrasDefaultModelId } from "../core/api/providers/models/cerebras"
// Provider default model IDs (used by webview-ui provider components)
export { claudeCodeDefaultModelId } from "../core/api/providers/models/claude-code"
export { deepSeekDefaultModelId } from "../core/api/providers/models/deepseek"
export { doubaoDefaultModelId } from "../core/api/providers/models/doubao"
export { fireworksDefaultModelId } from "../core/api/providers/models/fireworks"
export { geminiDefaultModelId } from "../core/api/providers/models/gemini"
export { groqDefaultModelId } from "../core/api/providers/models/groq"
export { huaweiCloudMaasDefaultModelId } from "../core/api/providers/models/huawei-cloud-maas"
export { huggingFaceDefaultModelId } from "../core/api/providers/models/huggingface"
// LiteLLM
export { type LiteLLMModelInfo, liteLlmDefaultModelId, liteLlmModelInfoSaneDefaults } from "../core/api/providers/models/litellm"
export { minimaxDefaultModelId } from "../core/api/providers/models/minimax"
export { mistralDefaultModelId } from "../core/api/providers/models/mistral"
export { moonshotDefaultModelId } from "../core/api/providers/models/moonshot"
export { nebiusDefaultModelId } from "../core/api/providers/models/nebius"
export { nousResearchDefaultModelId } from "../core/api/providers/models/nousresearch"
export { openAiDefaultModelId } from "../core/api/providers/models/openai"
export { openAiCodexDefaultModelId } from "../core/api/providers/models/openai-codex"
// OpenAI-compatible
export { azureOpenAiDefaultApiVersion, openAiModelInfoSaneDefaults } from "../core/api/providers/models/openai-compatible"
// OpenRouter
export {
    OPENROUTER_PROVIDER_PREFERENCES,
    openRouterClaudeOpus461mModelId,
    openRouterClaudeOpus471mModelId,
    openRouterClaudeSonnet41mModelId,
    openRouterClaudeSonnet451mModelId,
    openRouterClaudeSonnet461mModelId,
    openRouterDefaultModelId,
    openRouterDefaultModelInfo,
} from "../core/api/providers/models/openrouter"
export { mainlandQwenDefaultModelId } from "../core/api/providers/models/qwen-cn"
export { qwenCodeDefaultModelId } from "../core/api/providers/models/qwen-code"
export { internationalQwenDefaultModelId, QwenApiRegions } from "../core/api/providers/models/qwen-intl"
// Requesty
export { requestyDefaultModelId, requestyDefaultModelInfo } from "../core/api/providers/models/requesty"
export { sambanovaDefaultModelId } from "../core/api/providers/models/sambanova"
export { sapAiCoreDefaultModelId } from "../core/api/providers/models/sapaicore"
export { vertexDefaultModelId, vertexGlobalModels } from "../core/api/providers/models/vertex"
export { wandbDefaultModelId } from "../core/api/providers/models/wandb"
export { xaiDefaultModelId } from "../core/api/providers/models/xai"
export { mainlandZAiDefaultModelId } from "../core/api/providers/models/zai-cn"
export { internationalZAiDefaultModelId } from "../core/api/providers/models/zai-intl"

// OcaModelInfo (used by oca provider, proto-conversions, state-keys)
export type OcaModelInfo = ModelInfo & {
    modelName: string
    surveyId?: string
    banner?: string
    surveyContent?: string
    supportsReasoning?: boolean
    reasoningEffortOptions: string[]
}

// Provider model ID type aliases (all string-based, used by backend provider files)
export type AnthropicModelId = string
export type ClaudeCodeModelId = string
export type BedrockModelId = string
export type VertexModelId = string
export type GeminiModelId = string
export type OpenAiCodexModelId = string
export type DeepSeekModelId = string
export type HuggingFaceModelId = string
export type InternationalQwenModelId = string
export type MainlandQwenModelId = string
export type DoubaoModelId = string
export type MistralModelId = string
export type AskSageModelId = string
export type NebiusModelId = string
export type WandbModelId = string
export type XAIModelId = string
export type SambanovaModelId = string
export type CerebrasModelId = string
export type GroqModelId = string
export type SapAiCoreModelId = string
export type MoonshotModelId = string
export type HuaweiCloudMaasModelId = string
export type BasetenModelId = string
export type internationalZAiModelId = string
export type mainlandZAiModelId = string
export type FireworksModelId = string
export type QwenCodeModelId = string
export type MinimaxModelId = string
export type NousResearchModelId = string

// CLAUDE tiers (used by refresh models)
export { CLAUDE_OPUS_1M_TIERS, CLAUDE_SONNET_1M_TIERS } from "../core/api/providers/models/anthropic"

// Hicap (kept inline to avoid circular dependency with @shared/api ModelInfo import)
export interface HicapCompatibleModelInfo extends ModelInfo {
    temperature?: number
}
export const hicapModelInfoSaneDefaults: HicapCompatibleModelInfo = {
    id: "",
    capabilities: {
        supportsImages: true,
        supportsPromptCache: true,
        supportsReasoning: false,
        maxTokens: -1,
        contextWindow: 128_000,
    },
    pricing: { inputPrice: 0, outputPrice: 0 },
    temperature: 1,
}

// Model data re-exports (canonical source: src/core/api/providers/models/)
export { anthropicModels } from "../core/api/providers/models/anthropic"
export { askSageModels } from "../core/api/providers/models/asksage"
export { basetenModels } from "../core/api/providers/models/baseten"
export { bedrockModels } from "../core/api/providers/models/bedrock"
export { cerebrasModels } from "../core/api/providers/models/cerebras"
export { claudeCodeModels } from "../core/api/providers/models/claude-code"
export { deepSeekModels } from "../core/api/providers/models/deepseek"
export { doubaoModels } from "../core/api/providers/models/doubao"
export { fireworksModels } from "../core/api/providers/models/fireworks"
export { geminiModels } from "../core/api/providers/models/gemini"
export { groqModels } from "../core/api/providers/models/groq"
export { huaweiCloudMaasModels } from "../core/api/providers/models/huawei-cloud-maas"
export { huggingFaceModels } from "../core/api/providers/models/huggingface"
export { minimaxModels } from "../core/api/providers/models/minimax"
export { mistralModels } from "../core/api/providers/models/mistral"
export { moonshotModels } from "../core/api/providers/models/moonshot"
export { nebiusModels } from "../core/api/providers/models/nebius"
export { nousResearchModels } from "../core/api/providers/models/nousresearch"
export { openAiModels } from "../core/api/providers/models/openai"
export { openAiCodexModels } from "../core/api/providers/models/openai-codex"
export { mainlandQwenModels } from "../core/api/providers/models/qwen-cn"
export { qwenCodeModels } from "../core/api/providers/models/qwen-code"
export { internationalQwenModels } from "../core/api/providers/models/qwen-intl"
export { sambanovaModels } from "../core/api/providers/models/sambanova"
export { sapAiCoreModels } from "../core/api/providers/models/sapaicore"
export { wandbModels } from "../core/api/providers/models/wandb"
export { xaiModels } from "../core/api/providers/models/xai"
export { mainlandZAiModels } from "../core/api/providers/models/zai-cn"
export { internationalZAiModels } from "../core/api/providers/models/zai-intl"
export { vertexModels }
