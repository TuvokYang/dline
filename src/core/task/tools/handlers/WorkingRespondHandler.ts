import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DlineDefaultTool } from "@shared/tools"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

/**
 * Persisted chat-row key of working_respond messages.
 *
 * Rows written under the former act_mode_respond name carry this value, so new and recorded
 * messages keep sharing one renderer only while the key stays unchanged.
 */
const WORKING_RESPOND_ROW_KEY = "actModeRespond"

/**
 * Replies to the user while work continues, in Plan and Act modes alike.
 *
 * It states the purpose of the next tool calls or answers a message the user sent during the
 * work. The call never ends the turn: its result steers the model back to a working tool.
 */
export class WorkingRespondHandler implements IToolHandler, IPartialBlockHandler {
    readonly name = DlineDefaultTool.WORKING_RESPOND

    getDescription(block: ToolUse): string {
        return `[${block.name}]`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const message = uiHelpers.removeClosingTag(block, "response", block.params.response)

        // Keep the same renderer from the first partial through the final row.
        const toolMsg = JSON.stringify({ tool: WORKING_RESPOND_ROW_KEY, content: message })
        await uiHelpers.say("tool", toolMsg, undefined, undefined, true, block.ts).catch(() => {})
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
        const response: string | undefined = block.params.response

        // Two replies with nothing between them are narration, not alignment. User input or a
        // refused call clears lastToolName, so a reply to either is never blocked. The mistake
        // counter is left alone; the model is only steered back to real work.
        if (isWorkingRespond(config.taskState.lastToolName)) {
            return formatResponse.toolResult(
                `[BLOCKED] You cannot call working_respond consecutively. ` +
                    `Your next action MUST be a different tool that performs actual work: ` +
                    `read_file, replace_in_file, write_to_file, execute_command, list_files, search_files, etc. ` +
                    `Stop explaining and start doing.`,
            )
        }

        if (!response) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(block.name, "response", undefined, block.ts)
        }

        config.taskState.consecutiveMistakeCount = 0

        const toolMsg = JSON.stringify({ tool: WORKING_RESPOND_ROW_KEY, content: response })
        await config.callbacks.say("tool", toolMsg, undefined, undefined, false, block.ts)

        // task_progress and lastToolName are handled centrally by the tool execution service.
        // The result tells the model to continue with a different tool, which keeps the turn open.
        return formatResponse.toolResult(
            `[Message displayed. Now proceed with your next tool call - ` +
                `it must be a different tool (read_file, replace_in_file, execute_command, etc.), ` +
                `not working_respond again.]`,
        )
    }
}

function isWorkingRespond(toolName: string | undefined): boolean {
    return toolName === DlineDefaultTool.WORKING_RESPOND || toolName === DlineDefaultTool.LEGACY_ACT_MODE_RESPOND
}
