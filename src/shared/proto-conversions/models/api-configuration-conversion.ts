import { ModelsApiConfiguration as ProtoApiConfiguration, ApiProvider as ProtoApiProvider } from "@shared/proto/dline/models"
import { ApiConfiguration, ApiProvider } from "../../api"

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
        case ProtoApiProvider.OPENCODE:
            return "opencode"
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
