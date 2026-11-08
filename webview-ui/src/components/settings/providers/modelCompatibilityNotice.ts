import { LITE_PROMPT_CONTEXT_WINDOW_LIMIT } from "@shared/prompt-profile-constants"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { UiTranslator } from "@/i18n/messages"

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
export function getModelCompatibilityNotice(
    { capabilities, requireCompleteMetadata = true }: ModelCompatibilityNoticeInput,
    t: UiTranslator,
): ModelCompatibilityNotice | undefined {
    const contextWindow = capabilities?.contextWindow
    const hasKnownContextWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0

    if (hasKnownContextWindow && contextWindow < LITE_PROMPT_CONTEXT_WINDOW_LIMIT) {
        return {
            variant: "info",
            reason: "lite_prompt",
            title: t("settings.ui.compatibility.lite"),
            message: t("settings.ui.compatibility.liteHelp"),
        }
    }

    const hasKnownToolSupport = typeof capabilities?.supportsTools === "boolean"
    if (requireCompleteMetadata && (!hasKnownContextWindow || !hasKnownToolSupport)) {
        return {
            variant: "info",
            reason: "unknown_metadata",
            title: t("settings.ui.compatibility.incomplete"),
            message: t("settings.ui.compatibility.incompleteHelp"),
        }
    }

    return undefined
}
