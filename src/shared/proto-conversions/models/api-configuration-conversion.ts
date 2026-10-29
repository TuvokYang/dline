import {
    LiteLLMModelInfo,
    OpenAiCompatibleModelInfo,
    OpenRouterModelInfo,
    ModelsApiConfiguration as ProtoApiConfiguration,
    ApiProvider as ProtoApiProvider,
    OcaModelInfo as ProtoOcaModelInfo,
} from "@shared/proto/dline/models"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import {
    ApiConfiguration,
    ApiProvider,
    LiteLLMModelInfo as AppLiteLLMModelInfo,
    ModelInfo as AppModelInfo,
    ModelInfo,
    OcaModelInfo,
} from "../../api"

// Convert application ThinkingConfig to proto ThinkingConfig
function convertThinkingConfigToProto(config: ThinkingConfig | undefined): ThinkingConfig | undefined {
    if (!config) {
        return undefined
    }

    return {
        maxBudget: config.maxBudget,
        effortLevels: config.effortLevels ?? [],
    }
}

// Convert proto ThinkingConfig to application ThinkingConfig
function convertProtoToThinkingConfig(config: ThinkingConfig | undefined): ThinkingConfig | undefined {
    if (!config) {
        return undefined
    }

    return {
        supported: true,
        mode: config.maxBudget !== undefined ? "budget" : "effort",
        maxBudget: config.maxBudget,
        effortLevels: config.effortLevels ?? [],
    }
}

// Convert application ModelInfo to proto OpenRouterModelInfo
function _convertModelInfoToProtoOpenRouter(info: ModelInfo | undefined): OpenRouterModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        maxTokens: info.capabilities?.maxTokens,
        contextWindow: info.capabilities?.contextWindow,
        supportsImages: info.capabilities?.supportsImages,
        supportsPromptCache: info.capabilities?.supportsPromptCache ?? false,
        supportsReasoning: info.capabilities?.supportsReasoning,
        inputPrice: info.pricing?.inputPrice,
        outputPrice: info.pricing?.outputPrice,
        cacheWritesPrice: info.pricing?.cacheWritesPrice,
        cacheReadsPrice: info.pricing?.cacheReadsPrice,
        description: info.description,
        thinkingConfig: convertThinkingConfigToProto(info.capabilities?.thinking),
        supportsGlobalEndpoint: info.capabilities?.supportsGlobalEndpoint,
        tiers: info.pricing?.tiers || [],
    }
}

// Convert proto OpenRouterModelInfo to application ModelInfo
function _convertProtoToModelInfo(info: OpenRouterModelInfo | undefined): ModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        id: "",
        capabilities: {
            supportsImages: info.supportsImages ?? false,
            supportsPromptCache: info.supportsPromptCache ?? false,
            supportsReasoning: info.supportsReasoning ?? undefined,
            supportsGlobalEndpoint: info.supportsGlobalEndpoint ?? undefined,
            maxTokens: info.maxTokens ?? undefined,
            contextWindow: info.contextWindow ?? undefined,
            thinking: convertProtoToThinkingConfig(info.thinkingConfig),
        },
        pricing: {
            inputPrice: info.inputPrice,
            outputPrice: info.outputPrice,
            cacheWritesPrice: info.cacheWritesPrice,
            cacheReadsPrice: info.cacheReadsPrice,
            tiers: info.tiers.length > 0 ? info.tiers : undefined,
        },
        description: info.description,
    }
}

// Convert application ModelInfo to proto OcaModelInfo
function _convertOcaModelInfoToProtoOcaModelInfo(info: OcaModelInfo | undefined): ProtoOcaModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        maxTokens: info.capabilities?.maxTokens,
        contextWindow: info.capabilities?.contextWindow,
        supportsImages: info.capabilities?.supportsImages,
        supportsPromptCache: info.capabilities?.supportsPromptCache ?? false,
        inputPrice: info.pricing?.inputPrice,
        outputPrice: info.pricing?.outputPrice,
        cacheWritesPrice: info.pricing?.cacheWritesPrice,
        cacheReadsPrice: info.pricing?.cacheReadsPrice,
        description: info.description,
        thinkingConfig: convertThinkingConfigToProto(info.capabilities?.thinking),
        supportsReasoning: info.capabilities?.supportsReasoning,
        apiFormat: info.apiFormats?.[0],
        modelName: info.modelName,
        surveyContent: info.surveyContent,
        surveyId: info.surveyId,
        banner: info.banner,
        reasoningEffortOptions: info.reasoningEffortOptions,
    }
}

// Convert proto OpenRouterModelInfo to application ModelInfo
function _convertProtoOcaModelInfoToOcaModelInfo(info: ProtoOcaModelInfo | undefined): OcaModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        id: "",
        capabilities: {
            supportsImages: info.supportsImages ?? false,
            supportsPromptCache: info.supportsPromptCache ?? false,
            maxTokens: info.maxTokens ?? undefined,
            contextWindow: info.contextWindow ?? undefined,
        },
        pricing: {
            inputPrice: info.inputPrice,
            outputPrice: info.outputPrice,
            cacheWritesPrice: info.cacheWritesPrice,
            cacheReadsPrice: info.cacheReadsPrice,
        },
        description: info.description,
        surveyContent: info.surveyContent,
        surveyId: info.surveyId,
        banner: info.banner,
        modelName: info.modelName,
        apiFormats: info.apiFormat !== undefined ? [info.apiFormat] : undefined,
        supportsReasoning: info.supportsReasoning,
        reasoningEffortOptions: info.reasoningEffortOptions,
    }
}

// Convert application LiteLLMModelInfo to proto LiteLLMModelInfo
function _convertLiteLLMModelInfoToProto(info: AppLiteLLMModelInfo | undefined): LiteLLMModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        maxTokens: info.capabilities?.maxTokens,
        contextWindow: info.capabilities?.contextWindow,
        supportsImages: info.capabilities?.supportsImages,
        supportsPromptCache: info.capabilities?.supportsPromptCache ?? false,
        inputPrice: info.pricing?.inputPrice,
        outputPrice: info.pricing?.outputPrice,
        thinkingConfig: convertThinkingConfigToProto(info.capabilities?.thinking),
        supportsGlobalEndpoint: info.capabilities?.supportsGlobalEndpoint,
        cacheWritesPrice: info.pricing?.cacheWritesPrice,
        cacheReadsPrice: info.pricing?.cacheReadsPrice,
        description: info.description,
        tiers: info.pricing?.tiers || [],
        temperature: info.temperature,
        supportsReasoning: info.capabilities?.supportsReasoning,
    }
}

// Convert proto LiteLLMModelInfo to application LiteLLMModelInfo
function _convertProtoToLiteLLMModelInfo(info: LiteLLMModelInfo | undefined): AppLiteLLMModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        id: "",
        capabilities: {
            supportsImages: info.supportsImages ?? false,
            supportsPromptCache: info.supportsPromptCache ?? false,
            supportsReasoning: info.supportsReasoning ?? undefined,
            supportsGlobalEndpoint: info.supportsGlobalEndpoint ?? undefined,
            maxTokens: info.maxTokens ?? undefined,
            contextWindow: info.contextWindow ?? undefined,
            thinking: convertProtoToThinkingConfig(info.thinkingConfig),
        },
        pricing: {
            inputPrice: info.inputPrice,
            outputPrice: info.outputPrice,
            cacheWritesPrice: info.cacheWritesPrice,
            cacheReadsPrice: info.cacheReadsPrice,
            tiers: info.tiers.length > 0 ? info.tiers : undefined,
        },
        description: info.description,
        temperature: info.temperature,
    }
}

// Convert application OpenAiCompatibleModelInfo to proto OpenAiCompatibleModelInfo
function _convertOpenAiCompatibleModelInfoToProto(info: AppModelInfo | undefined): OpenAiCompatibleModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        maxTokens: info.capabilities?.maxTokens,
        contextWindow: info.capabilities?.contextWindow,
        supportsImages: info.capabilities?.supportsImages,
        supportsPromptCache: info.capabilities?.supportsPromptCache ?? false,
        inputPrice: info.pricing?.inputPrice,
        outputPrice: info.pricing?.outputPrice,
        thinkingConfig: convertThinkingConfigToProto(info.capabilities?.thinking),
        supportsGlobalEndpoint: info.capabilities?.supportsGlobalEndpoint,
        cacheWritesPrice: info.pricing?.cacheWritesPrice,
        cacheReadsPrice: info.pricing?.cacheReadsPrice,
        description: info.description,
        tiers: info.pricing?.tiers || [],
        temperature: info.temperature,
    }
}

// Convert proto OpenAiCompatibleModelInfo to application OpenAiCompatibleModelInfo
function _convertProtoToOpenAiCompatibleModelInfo(info: OpenAiCompatibleModelInfo | undefined): AppModelInfo | undefined {
    if (!info) {
        return undefined
    }

    return {
        id: "",
        capabilities: {
            supportsImages: info.supportsImages ?? false,
            supportsPromptCache: info.supportsPromptCache ?? false,
            supportsGlobalEndpoint: info.supportsGlobalEndpoint ?? undefined,
            maxTokens: info.maxTokens ?? undefined,
            contextWindow: info.contextWindow ?? undefined,
            thinking: convertProtoToThinkingConfig(info.thinkingConfig),
        },
        pricing: {
            inputPrice: info.inputPrice,
            outputPrice: info.outputPrice,
            cacheWritesPrice: info.cacheWritesPrice,
            cacheReadsPrice: info.cacheReadsPrice,
            tiers: info.tiers.length > 0 ? info.tiers : undefined,
        },
        description: info.description,
        temperature: info.temperature,
    }
}

// Convert application ApiProvider to proto ApiProvider
function _convertApiProviderToProto(provider: string | undefined): ProtoApiProvider {
    switch (provider) {
        case "anthropic":
            return ProtoApiProvider.ANTHROPIC
        case "openrouter":
            return ProtoApiProvider.OPENROUTER
        case "bedrock":
            return ProtoApiProvider.BEDROCK
        case "vertex":
            return ProtoApiProvider.VERTEX
        case "openai":
            return ProtoApiProvider.OPENAI
        case "ollama":
            return ProtoApiProvider.OLLAMA
        case "lmstudio":
            return ProtoApiProvider.LMSTUDIO
        case "gemini":
            return ProtoApiProvider.GEMINI
        case "requesty":
            return ProtoApiProvider.REQUESTY
        case "together":
            return ProtoApiProvider.TOGETHER
        case "deepseek":
            return ProtoApiProvider.DEEPSEEK
        case "qwen":
            return ProtoApiProvider.QWEN
        case "qwen-code":
            return ProtoApiProvider.QWEN_CODE
        case "doubao":
            return ProtoApiProvider.DOUBAO
        case "mistral":
            return ProtoApiProvider.MISTRAL
        case "vscode-lm":
            return ProtoApiProvider.VSCODE_LM
        case "cline":
            return ProtoApiProvider.CLINE
        case "litellm":
            return ProtoApiProvider.LITELLM
        case "moonshot":
            return ProtoApiProvider.MOONSHOT
        case "huggingface":
            return ProtoApiProvider.HUGGINGFACE
        case "nebius":
            return ProtoApiProvider.NEBIUS
        case "wandb":
            return ProtoApiProvider.WANDB
        case "fireworks":
            return ProtoApiProvider.FIREWORKS
        case "asksage":
            return ProtoApiProvider.ASKSAGE
        case "xai":
            return ProtoApiProvider.XAI
        case "sambanova":
            return ProtoApiProvider.SAMBANOVA
        case "cerebras":
            return ProtoApiProvider.CEREBRAS
        case "groq":
            return ProtoApiProvider.GROQ
        case "baseten":
            return ProtoApiProvider.BASETEN
        case "sapaicore":
            return ProtoApiProvider.SAPAICORE
        case "claude-code":
            return ProtoApiProvider.CLAUDE_CODE
        case "huawei-cloud-maas":
            return ProtoApiProvider.HUAWEI_CLOUD_MAAS
        case "vercel-ai-gateway":
            return ProtoApiProvider.VERCEL_AI_GATEWAY
        case "zai":
            return ProtoApiProvider.ZAI
        case "dify":
            return ProtoApiProvider.DIFY
        case "oca":
            return ProtoApiProvider.OCA
        case "aihubmix":
            return ProtoApiProvider.AIHUBMIX
        case "minimax":
            return ProtoApiProvider.MINIMAX
        case "hicap":
            return ProtoApiProvider.HICAP
        case "nousResearch":
            return ProtoApiProvider.NOUSRESEARCH
        case "openai-codex":
            return ProtoApiProvider.OPENAI_CODEX
        default:
            return ProtoApiProvider.ANTHROPIC
    }
}

// Convert proto ApiProvider to application ApiProvider
export function convertProtoToApiProvider(provider: ProtoApiProvider): ApiProvider {
    switch (provider) {
        case ProtoApiProvider.ANTHROPIC:
            return "anthropic"
        case ProtoApiProvider.OPENROUTER:
            return "openrouter"
        case ProtoApiProvider.BEDROCK:
            return "bedrock"
        case ProtoApiProvider.VERTEX:
            return "vertex"
        case ProtoApiProvider.OPENAI:
            return "openai"
        case ProtoApiProvider.OLLAMA:
            return "ollama"
        case ProtoApiProvider.LMSTUDIO:
            return "lmstudio"
        case ProtoApiProvider.GEMINI:
            return "gemini"
        case ProtoApiProvider.OPENAI_NATIVE:
            // The retired OpenAI Native provider is normalized onto the unified OpenAI API-key provider.
            return "openai"
        case ProtoApiProvider.REQUESTY:
            return "requesty"
        case ProtoApiProvider.TOGETHER:
            return "together"
        case ProtoApiProvider.DEEPSEEK:
            return "deepseek"
        case ProtoApiProvider.QWEN:
            return "qwen"
        case ProtoApiProvider.QWEN_CODE:
            return "qwen-code"
        case ProtoApiProvider.DOUBAO:
            return "doubao"
        case ProtoApiProvider.MISTRAL:
            return "mistral"
        case ProtoApiProvider.VSCODE_LM:
            return "vscode-lm"
        case ProtoApiProvider.CLINE:
            return "cline"
        case ProtoApiProvider.LITELLM:
            return "litellm"
        case ProtoApiProvider.MOONSHOT:
            return "moonshot"
        case ProtoApiProvider.HUGGINGFACE:
            return "huggingface"
        case ProtoApiProvider.NEBIUS:
            return "nebius"
        case ProtoApiProvider.WANDB:
            return "wandb"
        case ProtoApiProvider.FIREWORKS:
            return "fireworks"
        case ProtoApiProvider.ASKSAGE:
            return "asksage"
        case ProtoApiProvider.XAI:
            return "xai"
        case ProtoApiProvider.SAMBANOVA:
            return "sambanova"
        case ProtoApiProvider.CEREBRAS:
            return "cerebras"
        case ProtoApiProvider.GROQ:
            return "groq"
        case ProtoApiProvider.BASETEN:
            return "baseten"
        case ProtoApiProvider.SAPAICORE:
            return "sapaicore"
        case ProtoApiProvider.CLAUDE_CODE:
            return "claude-code"
        case ProtoApiProvider.HUAWEI_CLOUD_MAAS:
            return "huawei-cloud-maas"
        case ProtoApiProvider.VERCEL_AI_GATEWAY:
            return "vercel-ai-gateway"
        case ProtoApiProvider.ZAI:
            return "zai"
        case ProtoApiProvider.HICAP:
            return "hicap"
        case ProtoApiProvider.DIFY:
            return "dify"
        case ProtoApiProvider.OCA:
            return "oca"
        case ProtoApiProvider.AIHUBMIX:
            return "aihubmix"
        case ProtoApiProvider.MINIMAX:
            return "minimax"
        case ProtoApiProvider.NOUSRESEARCH:
            return "nousResearch"
        case ProtoApiProvider.OPENAI_CODEX:
            return "openai-codex"
        default:
            return "anthropic"
    }
}

// Converts application ApiConfiguration to proto ApiConfiguration.
// With the profile-driven architecture, only the 6 core fields are forwarded.
// All provider-specific fields are sourced from ApiProfile + ModelRegistry at runtime.
export function convertApiConfigurationToProto(config: ApiConfiguration): ProtoApiConfiguration {
    return {
        ulid: config.ulid,
        requestTimeoutMs: config.requestTimeoutMs,
        openAiHeaders: {},
        // NOTE: planModeProfile / actModeProfile / enableParallelToolCalling
        // are stored as Settings and forwarded via state proto, not apiConfiguration proto.
    }
}

// Converts proto ApiConfiguration to application ApiConfiguration.
// With the profile-driven architecture, only the 6 core fields are returned.
// Provider-specific fields are sourced from ApiProfile + ModelRegistry at runtime.
export function convertProtoToApiConfiguration(protoConfig: ProtoApiConfiguration): ApiConfiguration {
    return {
        ulid: protoConfig.ulid,
        requestTimeoutMs: protoConfig.requestTimeoutMs,
        // NOTE: planModeProfile / actModeProfile / enableParallelToolCalling
        // are stored as Settings and forwarded via state proto, not apiConfiguration proto.
    }
}
