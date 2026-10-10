import { PromptProfile } from "@core/prompts/profiles/types"
import { DEFAULT_PROMPT_CONTEXT_WINDOW, LITE_PROMPT_CONTEXT_WINDOW_LIMIT } from "./prompt-profile-constants"

export { DEFAULT_PROMPT_CONTEXT_WINDOW, LITE_PROMPT_CONTEXT_WINDOW_LIMIT } from "./prompt-profile-constants"

export interface ResolvePromptProfileInput {
    readonly explicitProfile?: PromptProfile
    readonly contextWindow?: number
    readonly modelId?: string
}

/** Reports whether a provider-qualified model id identifies the o1 family. */
export function isO1Model(modelId: string | undefined): boolean {
    return modelId?.split("/").some((segment) => /^o1(?:-|$)/i.test(segment)) ?? false
}

/** Resolve one final profile before entering the Prompt domain. */
export function resolvePromptProfile({ explicitProfile, contextWindow, modelId }: ResolvePromptProfileInput): PromptProfile {
    if (explicitProfile !== undefined) {
        if (explicitProfile !== PromptProfile.Standard && explicitProfile !== PromptProfile.Lite) {
            throw new Error("Invalid explicit PromptProfile")
        }
        return explicitProfile
    }

    if (isO1Model(modelId)) {
        return PromptProfile.Lite
    }

    const effectiveContextWindow =
        typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
            ? contextWindow
            : DEFAULT_PROMPT_CONTEXT_WINDOW

    return effectiveContextWindow < LITE_PROMPT_CONTEXT_WINDOW_LIMIT ? PromptProfile.Lite : PromptProfile.Standard
}
