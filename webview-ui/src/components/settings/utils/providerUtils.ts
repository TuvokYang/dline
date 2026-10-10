import {
    ApiConfiguration,
    ApiProvider,
    anthropicModels,
    askSageModels,
    basetenModels,
    bedrockModels,
    cerebrasModels,
    claudeCodeModels,
    deepSeekModels,
    doubaoModels,
    fireworksModels,
    geminiModels,
    groqModels,
    huaweiCloudMaasModels,
    huggingFaceModels,
    internationalQwenModels,
    internationalZAiModels,
    ModelInfo,
    minimaxModels,
    mistralModels,
    moonshotModels,
    nebiusModels,
    nousResearchModels,
    openAiCodexModels,
    qwenCodeModels,
    sambanovaModels,
    sapAiCoreModels,
    vertexModels,
    wandbModels,
    xaiModels,
} from "@shared/api"

/**
 * Returns the static model list for a provider.
 * For providers with dynamic models (openrouter, cline, ollama, etc.), returns undefined.
 * Some providers depend on configuration (qwen, zai) for region-specific models.
 */
export function getModelsForProvider(
    provider: ApiProvider,
    _apiConfiguration?: ApiConfiguration,
    dynamicModels: { liteLlmModels?: Record<string, ModelInfo>; basetenModels?: Record<string, ModelInfo> } = {},
): Record<string, ModelInfo> | undefined {
    switch (provider) {
        case "anthropic":
            return anthropicModels
        case "claude-code":
            return claudeCodeModels
        case "bedrock":
            return bedrockModels
        case "vertex":
            return vertexModels
        case "gemini":
            return geminiModels
        case "openai-codex":
            return openAiCodexModels
        case "deepseek":
            return deepSeekModels
        case "qwen":
            return internationalQwenModels
        case "qwen-code":
            return qwenCodeModels
        case "doubao":
            return doubaoModels
        case "mistral":
            return mistralModels
        case "asksage":
            return askSageModels
        case "xai":
            return xaiModels
        case "moonshot":
            return moonshotModels
        case "nebius":
            return nebiusModels
        case "wandb":
            return wandbModels
        case "sambanova":
            return sambanovaModels
        case "cerebras":
            return cerebrasModels
        case "groq":
            return groqModels
        case "baseten":
            return dynamicModels?.basetenModels || basetenModels
        case "sapaicore":
            return sapAiCoreModels
        case "huawei-cloud-maas":
            return huaweiCloudMaasModels
        case "zai":
            return internationalZAiModels
        case "fireworks":
            return fireworksModels
        case "minimax":
            return minimaxModels
        case "huggingface":
            return huggingFaceModels
        case "nousResearch":
            return nousResearchModels
        case "litellm":
            return dynamicModels?.liteLlmModels
        default:
            return undefined
    }
}

export { filterOpenRouterModelIds } from "@shared/utils/model-filters"
