import { LITE_PROMPT_CONTEXT_WINDOW_LIMIT } from "@shared/prompt-profile-constants"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"

export interface ModelCompatibilityNotice {
    variant: "info"
    reason: "lite_prompt" | "unknown_metadata"
    title: string
    message: string
}

export interface ModelCompatibilityNoticeInput {
    capabilities?: ModelCapabilities
    requireCompleteMetadata?: boolean
}

/** Describes prompt-profile or metadata guidance without treating model choice as an error. */
export function getModelCompatibilityNotice({
    capabilities,
    requireCompleteMetadata = true,
}: ModelCompatibilityNoticeInput): ModelCompatibilityNotice | undefined {
    const contextWindow = capabilities?.contextWindow
    const hasKnownContextWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0

    if (hasKnownContextWindow && contextWindow < LITE_PROMPT_CONTEXT_WINDOW_LIMIT) {
        return {
            variant: "info",
            reason: "lite_prompt",
            title: "Lite prompt profile",
            message: "This model uses the Lite prompt profile because its context window is below 64K tokens.",
        }
    }

    const hasKnownToolSupport = typeof capabilities?.supportsTools === "boolean"
    if (requireCompleteMetadata && (!hasKnownContextWindow || !hasKnownToolSupport)) {
        return {
            variant: "info",
            reason: "unknown_metadata",
            title: "Model metadata incomplete",
            message:
                "Confirm the context window and native tool support for this model to improve prompt selection and feature availability.",
        }
    }

    return undefined
}
