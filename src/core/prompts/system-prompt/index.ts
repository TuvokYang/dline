import { SystemPromptGenerator } from "../generators/SystemPromptGenerator"
import type { SystemPromptContext } from "./context"

export type { SystemPromptContext } from "./context"

/**
 * Get the system prompt by id
 */
export async function getSystemPrompt(context: SystemPromptContext) {
    return new SystemPromptGenerator().generate(context)
}
