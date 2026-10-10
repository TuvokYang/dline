import type { ApiProviderInfo } from "@/core/api"
import { getDeepPlanningPrompt } from "./commands/deep-planning"
import { summarizeTask } from "./contextManagement"
import { CommandPromptGenerator } from "./generators/CommandPromptGenerator"
import { englishTemplateStore } from "./i18n/en"
import type { PromptProfile } from "./profiles/types"
import type { PromptEnv } from "./template/types"

const commandGenerator = new CommandPromptGenerator(englishTemplateStore)

/**
 * Generates one exact command prompt and returns its text.
 *
 * @param templateId Stable command template identifier.
 * @param env Declared runtime prompt values.
 * @returns Rendered command prompt text.
 */
function generateCommand(templateId: string, env: PromptEnv = {}): string {
    return commandGenerator.generate(templateId, env).text
}

export const newTaskToolResponse = () => {
    return `${generateCommand("commands.newTaskMain", {
        TOOL_CALL_FORMAT: generateCommand("commands.newTaskXmlToolCallFormat"),
    })}\n`
}

/** Generate the shared summarize_task instruction for explicit manual compaction. */
export const condenseToolResponse = (focusChainSettings?: { enabled: boolean }) => summarizeTask(focusChainSettings)

export const newRuleToolResponse = () =>
    `${generateCommand("commands.newRuleToolResponse", {
        TOOL_CALL_FORMAT: generateCommand("commands.newRuleXmlToolCallFormat"),
    })}\n`

export const reportBugToolResponse = () =>
    `${generateCommand("commands.reportBugToolResponse", {
        TOOL_CALL_FORMAT: generateCommand("commands.reportBugXmlToolCallFormat"),
    })}\n`

export const explainChangesToolResponse = () =>
    `${generateCommand("commands.explainChangesToolResponse", {
        TOOL_CALL_FORMAT: generateCommand("commands.explainChangesXmlToolCallFormat"),
    })}\n`

/**
 * Generates the provider-independent deep-planning slash command response.
 * @param promptProfile Final typed prompt profile resolved by the caller.
 * @param focusChainSettings Optional focus chain settings to include in the prompt
 * @param providerInfo Retained API provider input; prompt content does not branch on it.
 * @param enableNativeToolCalls Optional flag to determine if native tool calling is enabled
 * @returns The deep-planning prompt string with explicit runtime settings applied.
 */
export const deepPlanningToolResponse = (
    promptProfile: PromptProfile,
    focusChainSettings?: { enabled: boolean },
    providerInfo?: ApiProviderInfo,
    enableNativeToolCalls?: boolean,
) => {
    return getDeepPlanningPrompt(promptProfile, focusChainSettings, providerInfo, enableNativeToolCalls)
}
