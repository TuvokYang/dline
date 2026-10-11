import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DlineDefaultTool } from "@shared/tools"
import { type ToolHandlerResult, withToolDocuments } from "../ToolExecutionResult"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { attachToolFeedbackFiles, sayFeedbackOnce } from "../utils/UserFeedbackUtils"

/**
 * Persisted chat-row key of phase_report messages.
 *
 * Rows written under the former status_update name carry this value, so new and recorded
 * reports keep sharing one renderer only while the key stays unchanged.
 */
const PHASE_REPORT_ROW_KEY = "statusUpdate"

/** The note typed with Acknowledge or Stop, framed for the tool result; empty when there is none. */
function feedbackNote(text?: string): string {
    const trimmed = text?.trim()
    return trimmed ? `\n<feedback>\n${trimmed}\n</feedback>` : ""
}

/**
 * Reports a completed phase to the user, in Plan and Act modes alike.
 *
 * The report never ends the turn. With requires_acknowledgment it waits only until the user
 * has read it, and the Acknowledge or Stop answer becomes the call's result.
 */
export class PhaseReportHandler implements IToolHandler, IPartialBlockHandler {
    readonly name = DlineDefaultTool.PHASE_REPORT

    getDescription(block: ToolUse): string {
        return `[${block.name}]`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const params = block.params as Record<string, string>
        const message = uiHelpers.removeClosingTag(block, "response", params.response)
        if (params.requires_acknowledgment === "true") {
            await uiHelpers.say("text", message, undefined, undefined, true, block.ts).catch(() => {})
            return
        }
        const toolMsg = JSON.stringify({ tool: PHASE_REPORT_ROW_KEY, content: message })
        await uiHelpers.say("tool", toolMsg, undefined, undefined, true, block.ts).catch(() => {})
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        const response: string | undefined = (block.params as Record<string, string>).response
        const requiresAck: boolean = (block.params as Record<string, string>).requires_acknowledgment === "true"

        // Two reports with nothing between them are narration, not progress. User input or a
        // refused call clears lastToolName, so a report after either is never blocked.
        if (isPhaseReport(config.taskState.lastToolName)) {
            return formatResponse.toolResult(
                `[BLOCKED] You cannot call phase_report consecutively. ` +
                    `Your next action MUST be a different tool that performs actual work: ` +
                    `read_file, replace_in_file, write_to_file, execute_command, list_files, search_files, etc. ` +
                    `Stop announcing and start doing.`,
            )
        }

        if (!response) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(block.name, "response", undefined, block.ts)
        }

        config.taskState.consecutiveMistakeCount = 0

        if (requiresAck) {
            const outcome = await config.interactions.open({
                turnId: interactionTurnId(block),
                interactionId: interactionId(block),
                kind: "status_acknowledgment",
                presentation: response,
                existingTs: block.ts,
            })
            // The note typed with Acknowledge or Stop is the user's own message, so it
            // is shown in the chat just as a follow-up reply is.
            if (outcome.draft?.text?.trim() || outcome.draft?.images.length || outcome.draft?.files.length) {
                await sayFeedbackOnce(
                    config,
                    "messageResponse",
                    outcome.draft.text,
                    outcome.draft.images,
                    outcome.draft.files,
                    outcome,
                )
            }
            // Images and files reach the model as content, never as their data URLs or paths in text.
            const attachments = await attachToolFeedbackFiles(outcome.draft?.files)
            const note = feedbackNote(outcome.draft?.text)
            const message =
                outcome.actionId === "stop"
                    ? `[PHASE_REPORT] User chose to stop.${note} Wait for further instructions.`
                    : `[PHASE_REPORT] User acknowledged.${note} Continue with your next tool call.`
            return withToolDocuments(
                formatResponse.toolResult(message, outcome.draft?.images, attachments.text),
                attachments.documents,
            )
        }

        const toolMsg = JSON.stringify({ tool: PHASE_REPORT_ROW_KEY, content: response })
        await config.interactions.say({ taskSay: "tool", presentation: toolMsg, existingTs: block.ts })

        return formatResponse.toolResult(
            `[Message displayed. Now proceed with your next tool call - ` +
                `it must be a different tool (read_file, replace_in_file, execute_command, etc.), ` +
                `not phase_report again.]`,
        )
    }
}

function isPhaseReport(toolName: string | undefined): boolean {
    return toolName === DlineDefaultTool.PHASE_REPORT || toolName === DlineDefaultTool.LEGACY_STATUS_UPDATE
}
