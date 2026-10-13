import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DlineDefaultTool } from "@shared/tools"
import type { ToolHandlerResult } from "../ToolExecutionResult"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

/**
 * Persisted chat-row key of phase_report messages.
 *
 * Rows written under the former status_update name carry this value, so new and recorded
 * reports keep sharing one renderer only while the key stays unchanged.
 */
const PHASE_REPORT_ROW_KEY = "statusUpdate"

/**
 * Reports a completed phase to the user, in Plan and Act modes alike.
 *
 * The report never ends the turn and never waits for the user. Calls recorded by earlier
 * versions may still carry requires_acknowledgment; the parameter is ignored. An
 * acknowledgment such a version left open is answered through the restored-dialog path,
 * not through this handler.
 */
export class PhaseReportHandler implements IToolHandler, IPartialBlockHandler {
    readonly name = DlineDefaultTool.PHASE_REPORT

    getDescription(block: ToolUse): string {
        return `[${block.name}]`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const params = block.params as Record<string, string>
        const message = uiHelpers.removeClosingTag(block, "response", params.response)
        const toolMsg = JSON.stringify({ tool: PHASE_REPORT_ROW_KEY, content: message })
        await uiHelpers.say("tool", toolMsg, undefined, undefined, true, block.ts).catch(() => {})
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        const response: string | undefined = (block.params as Record<string, string>).response

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
