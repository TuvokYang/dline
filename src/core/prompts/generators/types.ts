import type { ClineTool } from "../../../shared/tools"
import type { PromptProfile } from "../profiles/types"
import type { EnvTrace, PromptWarning } from "../template/types"
import type { SystemPromptComposition } from "./system-prompt-composition"

/** Complete output produced by the profile-based system prompt facade. */
export interface GeneratedSystemPrompt {
    readonly systemPrompt: string
    readonly tools?: readonly ClineTool[]
    readonly profile: PromptProfile
    readonly warnings: readonly PromptWarning[]
    readonly trace?: readonly EnvTrace[]
    /** Byte sizes of the prompt parts the context-window indicator breaks out; absent from substitute builders. */
    readonly composition?: SystemPromptComposition
}
