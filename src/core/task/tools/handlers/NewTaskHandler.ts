import type { ToolUse } from "@core/assistant-message"
import { encodeNewTaskAsk } from "@shared/new-task-ask"
import { DlineDefaultTool } from "@/shared/tools"
import { declinedNewTaskDenialResponse, newTaskCreatedResponse, successorDirective } from "../../new-task/new-task-answer"
import type { ToolDenial, ToolHandlerResult } from "../ToolExecutionResult"
import type { IDenialDescribingToolHandler, IPartialBlockHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class NewTaskHandler implements IDenialDescribingToolHandler, IPartialBlockHandler {
    readonly name = DlineDefaultTool.NEW_TASK

    getDescription(block: ToolUse): string {
        return `[${block.name} for creating a new task]`
    }

    /**
     * Handle partial block streaming for new_task
     */
    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const presentation = encodeNewTaskAsk({
            task: uiHelpers.removeClosingTag(block, "task", block.params.task),
            context: uiHelpers.removeClosingTag(block, "context", block.params.context),
        })
        await uiHelpers.ask(this.name, presentation, true, { existingTs: block.ts }).catch(() => {})
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        const task: string | undefined = block.params.task
        const context: string | undefined = block.params.context

        // The successor opens like a spawned task, so it needs both halves.
        if (!task) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(block.name, "task", undefined, block.ts)
        }
        if (!context) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(block.name, "context", undefined, block.ts)
        }

        config.taskState.consecutiveMistakeCount = 0
        return {
            response: newTaskCreatedResponse(),
            postCommit: successorDirective({ task, context, functionId: block.function_id, dlineTid: block.dline_tid }),
        }
    }

    /**
     * Declining a New Task is the user's answer, not a failed call: the feedback
     * result must read as an ordinary result so the next round may propose the
     * handoff again (see `deriveNewTaskFeedbackContinuation`).
     */
    async describeDenial(_config: TaskConfig, _block: ToolUse): Promise<ToolDenial> {
        return { text: declinedNewTaskDenialResponse(), isError: false }
    }
}
