import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat } from "@shared/proto/dline/models/metadata"

const API_FORMAT_LABELS: Partial<Record<ApiFormat, string>> = {
    [ApiFormat.ANTHROPIC_CHAT]: "Anthropic Messages",
    [ApiFormat.GEMINI_CHAT]: "Gemini Chat",
    [ApiFormat.OPENAI_CHAT]: "OpenAI Chat",
    [ApiFormat.R1_CHAT]: "R1 Chat",
    [ApiFormat.OPENAI_RESPONSES]: "OpenAI Responses",
    [ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE]: "OpenAI Responses WebSocket",
}

/** Return the user-facing label for an API protocol. */
export function getApiFormatLabel(apiFormat: ApiFormat): string {
    return API_FORMAT_LABELS[apiFormat] ?? "Unknown API Format"
}

/** Convert the retired OpenAI endpoint option into the canonical API format. */
export function openAiEndpointToApiFormat(apiEndpoint?: string): ApiFormat | undefined {
    switch (apiEndpoint) {
        case "chat_completions":
            return ApiFormat.OPENAI_CHAT
        case "responses":
            return ApiFormat.OPENAI_RESPONSES
        default:
            return undefined
    }
}

/** Resolve a profile selection against the protocols declared by its model. */
export function resolveApiFormat(
    selected: ApiFormat | undefined,
    modelInfo: Pick<ModelInfo, "apiFormats"> | undefined,
    fallback: ApiFormat,
): ApiFormat {
    const supported = modelInfo?.apiFormats
    if (selected !== undefined && (!supported?.length || supported.includes(selected))) {
        return selected
    }
    return supported?.[0] ?? fallback
}

/** Project the selected protocol first for runtime consumers that read the active format from model info. */
export function prioritizeApiFormat(modelInfo: ModelInfo, selected: ApiFormat): ModelInfo {
    return {
        ...modelInfo,
        apiFormats: [selected, ...(modelInfo.apiFormats ?? []).filter((apiFormat) => apiFormat !== selected)],
    }
}
