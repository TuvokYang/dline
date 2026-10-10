import type { ClineTool } from "../../../shared/tools"
import type { PromptProfile } from "../profiles/types"
import type { EnvTrace, PromptWarning } from "../template/types"

/** Complete output produced by the profile-based system prompt facade. */
export interface GeneratedSystemPrompt {
    readonly systemPrompt: string
    readonly tools?: readonly ClineTool[]
    readonly profile: PromptProfile
    readonly warnings: readonly PromptWarning[]
    readonly trace?: readonly EnvTrace[]
}
