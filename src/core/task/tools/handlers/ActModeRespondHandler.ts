import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { ClineDefaultTool } from "@shared/tools"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class ActModeRespondHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.ACT_MODE

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Handle partial block streaming for act_mode_respond
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const response = block.params.response

		const message = uiHelpers.removeClosingTag(block, "response", response)

		// Display partial message as "text" type to avoid blocking
		await uiHelpers.say("text", message, undefined, undefined, true, block.ts).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const response: string | undefined = block.params.response

		// Validate we're in ACT mode
		if (config.mode !== "act") {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(
				`The act_mode_respond tool is only available in ACT MODE. You are currently in ${config.mode.toUpperCase()} MODE. Please use the appropriate tool for your current mode.`,
			)
		}

		// Block consecutive act_mode_respond calls to prevent narration loops
		// Note: We intentionally do NOT increment consecutiveMistakeCount here to avoid
		// breaking the conversation flow - we just guide the model to use proper tools
		if (config.taskState.lastToolName === ClineDefaultTool.ACT_MODE) {
			return formatResponse.toolResult(
				`[BLOCKED] You cannot call act_mode_respond consecutively. ` +
					`Your next action MUST be a different tool that performs actual work: ` +
					`read_file, replace_in_file, write_to_file, execute_command, list_files, search_files, etc. ` +
					`Stop explaining and start doing.`,
			)
		}

		// Validate required parameters
		if (!response) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "response", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0

		// Display as tool message with actModeRespond identifier for styled rendering
		const toolMsg = JSON.stringify({ tool: "actModeRespond", content: response })
		await config.callbacks.say("tool", toolMsg, undefined, undefined, false, block.ts)

		// Note: task_progress and lastToolName are handled centrally by ToolExecutor.

		// Return success immediately to allow LLM to continue execution
		// The key difference from make_plan: no blocking for user input
		// NOTE: We explicitly tell the model to use a different tool next to prevent narration loops
		return formatResponse.toolResult(
			`[Message displayed. Now proceed with your next tool call - ` +
				`it must be a different tool (read_file, replace_in_file, execute_command, etc.), ` +
				`not act_mode_respond again.]`,
		)
	}
}
