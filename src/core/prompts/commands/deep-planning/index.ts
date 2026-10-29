import { getShell } from "@utils/shell"
import type { ApiProviderInfo } from "@/core/api"
import { CommandPromptGenerator } from "../../generators/CommandPromptGenerator"
import { englishTemplateStore } from "../../i18n/en"
import { PromptProfile, requirePromptProfile } from "../../profiles/types"
import { withoutPromptFragments } from "../../system-prompt/variants/conditional-content"
import { DEEP_PLANNING_VARIANTS } from "./variants"

const commandGenerator = new CommandPromptGenerator(englishTemplateStore)
const LITE_TASK_PROGRESS_FRAGMENTS = [
    commandGenerator.generate("deepPlanningGeneric.liteTaskProgressTaskLine", {}).text,
    commandGenerator.generate("deepPlanningGeneric.liteTaskProgressHeading", {}).text,
    commandGenerator.generate("deepPlanningGeneric.liteTaskProgressContext", {}).text,
] as const

/**
 * Generates a provider-independent deep-planning slash command response.
 * @param promptProfile Final typed prompt profile resolved by the caller.
 * @param focusChainSettings Optional focus chain settings to include in the prompt
 * @param _providerInfo Retained provider input; content generation does not branch on it.
 * @param enableNativeToolCalls Optional flag to determine if native tool calling is enabled
 * @returns The deep-planning prompt with shell, focus-chain, and transport values applied.
 */
export function getDeepPlanningPrompt(
    promptProfile: PromptProfile,
    focusChainSettings?: { enabled: boolean },
    _providerInfo?: ApiProviderInfo,
    _enableNativeToolCalls?: boolean,
): string {
    const requiredProfile = requirePromptProfile(promptProfile)
    const variant = DEEP_PLANNING_VARIANTS.find((candidate) => candidate.id === requiredProfile)
    if (!variant) {
        throw new Error(`Missing deep-planning variant for profile '${requiredProfile}'`)
    }
    const isPowerShell = detectPowerShell(getShell())
    if (variant.id === PromptProfile.Standard) {
        return commandGenerator.generate("deepPlanning5Step.main", {
            FOCUS_CHAIN_NOTE: focusChainSettings?.enabled
                ? commandGenerator.generate("deepPlanning5Step.focusChainNote", {}).text
                : "",
            SHELL_COMMANDS: commandGenerator.generate(
                isPowerShell ? "deepPlanning5Step.powershellCommands" : "deepPlanning5Step.bashCommands",
                {},
            ).text,
            FOCUS_CHAIN_TASK_PROGRESS_LINE: focusChainSettings?.enabled
                ? commandGenerator.generate("deepPlanning5Step.focusChainTaskProgressLine", {}).text
                : "",
            FOCUS_CHAIN_TASK_NOTE: focusChainSettings?.enabled
                ? commandGenerator.generate("deepPlanning5Step.focusChainTaskNote", {}).text
                : "",
            FOCUS_CHAIN_TASK_PROGRESS: focusChainSettings?.enabled
                ? commandGenerator.generate("deepPlanning5Step.focusChainTaskProgress", {}).text
                : "",
            TOOL_DEFINITION: commandGenerator.generate("deepPlanning5Step.xmlToolDef", {}).text,
        }).text
    }

    const shellCommands = commandGenerator.generate(
        isPowerShell ? "deepPlanningGeneric.powershellCommands" : "deepPlanningGeneric.bashCommands",
        {},
    ).text
    const navCommands = commandGenerator.generate(
        isPowerShell ? "deepPlanningGeneric.powershellNavCommands" : "deepPlanningGeneric.bashNavCommands",
        {},
    ).text

    const rendered = commandGenerator.generate("deepPlanningGeneric.main", {
        SHELL_COMMANDS: shellCommands,
        NAV_COMMANDS: navCommands,
        FOCUS_CHAIN_PARAM: "",
        NEW_TASK_INSTRUCTIONS: commandGenerator.generate("deepPlanningGeneric.xmlNewTaskInstructions", {}).text,
    }).text
    return withoutPromptFragments(rendered, LITE_TASK_PROGRESS_FRAGMENTS)
}

/**
 * Detects whether the current shell uses PowerShell syntax.
 *
 * @param shell Detected shell executable or label.
 * @returns True when PowerShell command examples should be used.
 */
function detectPowerShell(shell: string | undefined): boolean {
    const normalized = shell?.toLowerCase() ?? ""
    return normalized.includes("powershell") || normalized.includes("pwsh")
}
