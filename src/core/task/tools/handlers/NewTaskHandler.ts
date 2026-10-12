import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { showSystemNotification } from "@integrations/notifications"
import { encodeNewTaskAsk } from "@shared/new-task-ask"
import { DlineDefaultTool } from "@/shared/tools"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "../../new-task/new-task-continuation"
import { type ToolHandlerResult, withToolDocuments } from "../ToolExecutionResult"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { attachToolFeedbackFiles, sayFeedbackOnce } from "../utils/UserFeedbackUtils"

export class NewTaskHandler implements IToolHandler, IPartialBlockHandler {
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

        if (config.autoApprovalSettings.enableNotifications) {
            showSystemNotification({
                subtitle: "Dline wants to start a new task...",
                message: `Dline is suggesting to start a new task with: ${task}`,
            })
        }

        // Handing the conversation to a successor is the user's call even when
        // tools are auto-approved, so the choice is this tool's own interaction.
        const outcome = await config.interactions.open({
            turnId: interactionTurnId(block),
            interactionId: interactionId(block),
            kind: "new_task",
            presentation: encodeNewTaskAsk({ task, context }),
            existingTs: block.ts,
        })
        if (outcome.actionId === "approve") {
            return {
                response: formatResponse.toolResult(getPrompt("toolHandlers", "newTaskCreated")),
                postCommit: {
                    type: "start_successor_task",
                    task,
                    context,
                    functionId: block.function_id,
                    dlineTid: block.dline_tid,
                },
            }
        }
        if (outcome.actionId !== "reject") {
            throw new Error(`Unsupported New Task action: ${outcome.actionId}`)
        }

        // Declining with feedback answers this conversation: the feedback is the
        // tool's result here and never travels to a successor.
        const text = outcome.draft?.text ?? ""
        const images = outcome.draft?.images
        const files = outcome.draft?.files
        const attachments = await attachToolFeedbackFiles(files)

        await sayFeedbackOnce(config, "noButtonClicked", text, images, files, outcome)
        // The marker is what lets the next round call new_task again without the
        // user repeating /newtask; see deriveNewTaskFeedbackContinuation.
        return withToolDocuments(
            formatResponse.toolResult(
                `${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\nThe user provided feedback instead of creating a new task:\n<feedback>\n${text}\n</feedback>`,
                images,
                attachments.text,
            ),
            attachments.documents,
        )
    }
}
