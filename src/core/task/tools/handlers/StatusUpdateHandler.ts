import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { ClineDefaultTool } from "@shared/tools"
import type { ToolResponse } from "../../index"
import { statusFeedbackText } from "../../interaction/InteractionContinuation"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { attachToolFeedbackFiles } from "../utils/UserFeedbackUtils"

export class StatusUpdateHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.STATUS_UPDATE

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const response = (block.params as Record<string, string>).response
		const message = uiHelpers.removeClosingTag(block, "response", response)
		await uiHelpers.say("text", message, undefined, undefined, true, block.ts).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const response: string | undefined = (block.params as Record<string, string>).response
		const requiresAck: boolean = (block.params as Record<string, string>).requires_acknowledgment === "true"

		// Block consecutive status_update calls to prevent narration loops
		if (config.taskState.lastToolName === ClineDefaultTool.STATUS_UPDATE) {
			return formatResponse.toolResult(
				`[BLOCKED] You cannot call status_update consecutively. ` +
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
			// Attached images and files reach the model as their own blocks, never as data URLs in the text.
			const feedback = statusFeedbackText(outcome.draft?.text)
			const fileContent = await attachToolFeedbackFiles(config.taskState.userMessageContent, outcome.draft?.files)
			const message =
				outcome.actionId === "stop"
					? `[STATUS_UPDATE] User chose to stop.${feedback} Wait for further instructions.`
					: `[STATUS_UPDATE] User acknowledged.${feedback} Continue with your next tool call.`
			return formatResponse.toolResult(message, outcome.draft?.images, fileContent)
		}

		const toolMsg = JSON.stringify({ tool: "statusUpdate", content: response })
		await config.interactions.say({ taskSay: "tool", presentation: toolMsg, existingTs: block.ts })

		return formatResponse.toolResult(
			`[Message displayed. Now proceed with your next tool call - ` +
				`it must be a different tool (read_file, replace_in_file, execute_command, etc.), ` +
				`not status_update again.]`,
		)
	}
}
