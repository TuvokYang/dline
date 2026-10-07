import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { ClineDefaultTool } from "@/shared/tools"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "../../new-task/new-task-continuation"
import type { ToolHandlerResult } from "../ToolExecutionResult"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { sayFeedbackOnce } from "../utils/UserFeedbackUtils"

export class NewTaskHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.NEW_TASK

	getDescription(block: ToolUse): string {
		return `[${block.name} for creating a new task]`
	}

	/**
	 * Stream the proposed context into the same new_task ask that execute() later opens.
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const context = uiHelpers.removeClosingTag(block, "context", block.params.context)
		await uiHelpers.ask(this.name, context, true, { existingTs: block.ts }).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
		const context: string | undefined = block.params.context

		// Validate required parameters
		if (!context) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "context", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0

		if (config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Dline wants to start a new task...",
				message: `Dline is suggesting to start a new task with: ${context}`,
			})
		}

		// The user decides between starting the successor task and sending feedback instead.
		const outcome = await config.interactions.open({
			turnId: interactionTurnId(block),
			interactionId: interactionId(block),
			kind: "new_task",
			presentation: context,
			existingTs: block.ts,
		})
		if (outcome.actionId === "approve") {
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
		if (outcome.actionId !== "reject") {
			throw new Error(`Unsupported New Task action: ${outcome.actionId}`)
		}

		const text = outcome.draft?.text ?? ""
		const images = outcome.draft?.images
		const files = outcome.draft?.files
		const fileContent = files && files.length > 0 ? await processFilesIntoText(files) : ""

		await sayFeedbackOnce(config, "noButtonClicked", text, images, files)
		return formatResponse.toolResult(
			`${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\nThe user provided feedback instead of creating a new task:\n<feedback>\n${text}\n</feedback>`,
			images,
			fileContent,
		)
	}
}
