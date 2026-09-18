import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolHandlerResult } from "../ToolExecutionResult"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class NewTaskHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.NEW_TASK

	getDescription(block: ToolUse): string {
		return `[${block.name} for creating a new task]`
	}

	/**
	 * Handle partial block streaming for new_task
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const context = uiHelpers.removeClosingTag(block, "context", block.params.context)
		await uiHelpers.say("tool", context, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
		const context: string | undefined = block.params.context

		// Validate required parameters
		if (!context) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "context", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0
		return {
			response: formatResponse.toolResult(getPrompt("toolHandlers", "newTaskCreated")),
			postCommit: {
				type: "start_successor_task",
				context,
				functionId: block.function_id,
				dlineTid: block.dline_tid,
			},
		}
	}
}
