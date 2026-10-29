import type { ToolUse } from "@core/assistant-message"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { findLast } from "@shared/array"
import { DlineDefaultTool } from "@shared/tools"
import { Logger } from "@/shared/services/Logger"
import type { ToolHandlerResult } from "../../../tools/ToolExecutionResult"
import type { TaskConfig } from "../../../tools/types/TaskConfig"

/**
 * Resolve blanket interaction policy before a conversational handler opens its dialog.
 *
 * Handlers own validation and interaction mechanics; this boundary alone decides
 * whether YOLO may replace an interaction with an automatic outcome.
 */
export async function resolveToolInteractionPolicy(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult | undefined> {
    if (!config.yoloModeToggled) return undefined

    if (block.name === DlineDefaultTool.ASK) {
        const question = block.params.question
        if (!question) return undefined
        const truncatedQuestion = `${question.substring(0, 100)}${question.length > 100 ? "..." : ""}`
        await config.callbacks.say("info", renderPrompt("toolHandlers", "yoloAutoRespond", { QUESTION: truncatedQuestion }))
        return formatResponse.toolResult(renderPrompt("toolHandlers", "yoloToolResult", { QUESTION: question }))
    }

    if (block.name !== DlineDefaultTool.MAKE_PLAN || config.mode !== "plan") return undefined
    const response = block.params.response
    const needsMoreExploration = block.params.needs_more_exploration === "true"
    if (!response || needsMoreExploration) return undefined

    const switchSuccessful = await config.callbacks.switchToActMode()
    if (!switchSuccessful) {
        Logger.warn(getPrompt("toolHandlers", "planYoloSwitchFailed"))
        return undefined
    }

    const lastPlanMessage = findLast(config.messageState.clineMessages, (message) => message.ask === "make_plan")
    if (lastPlanMessage) {
        lastPlanMessage.text = JSON.stringify({ response })
        lastPlanMessage.partial = false
        await config.messageState.updateTaskHistory()
    }
    return formatResponse.toolResult(getPrompt("toolHandlers", "planYoloSwitchToAct"))
}
