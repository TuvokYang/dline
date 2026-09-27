import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { ClineDefaultTool } from "@shared/tools"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { sayFeedbackOnce } from "../utils/UserFeedbackUtils"

export class StatusUpdateHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.STATUS_UPDATE

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Format optional acknowledgment feedback for the tool result.
	 * @param text User-entered acknowledgment or stop reason.
	 * @param images Selected image payload identifiers.
	 * @param files Selected file payload identifiers.
	 * @returns Formatted feedback suffix for the next model turn.
	 */
	private formatFeedback(text?: string, images?: string[], files?: string[]): string {
		const parts: string[] = []
		const trimmedText = text?.trim()
		if (trimmedText) {
			parts.push(`<feedback>\n${trimmedText}\n</feedback>`)
		}
		if (images && images.length > 0) {
			parts.push(`Images: ${images.join(", ")}`)
		}
		if (files && files.length > 0) {
			parts.push(`Files: ${files.join(", ")}`)
		}
		return parts.length > 0 ? `\n${parts.join("\n")}` : ""
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
			const feedback = this.formatFeedback(outcome.draft?.text, outcome.draft?.images, outcome.draft?.files)
			// The note typed with Acknowledge or Stop is the user's own message, so it
			// is shown in the chat just as a follow-up reply is.
			if (outcome.draft?.text?.trim() || outcome.draft?.images.length || outcome.draft?.files.length) {
				await sayFeedbackOnce(config, "messageResponse", outcome.draft.text, outcome.draft.images, outcome.draft.files)
			}
			if (outcome.actionId === "stop") {
				return formatResponse.toolResult(`[STATUS_UPDATE] User chose to stop.${feedback} Wait for further instructions.`)
			}
			return formatResponse.toolResult(`[STATUS_UPDATE] User acknowledged.${feedback} Continue with your next tool call.`)
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
