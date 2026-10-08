import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { ClineDefaultTool } from "@shared/tools"
import { type ToolHandlerResult, withToolDocuments } from "../ToolExecutionResult"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { attachToolFeedbackFiles, sayFeedbackOnce } from "../utils/UserFeedbackUtils"

/** The note typed with Acknowledge or Stop, framed for the tool result; empty when there is none. */
function feedbackNote(text?: string): string {
	const trimmed = text?.trim()
	return trimmed ? `\n<feedback>\n${trimmed}\n</feedback>` : ""
}

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

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
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
					? `[STATUS_UPDATE] User chose to stop.${note} Wait for further instructions.`
					: `[STATUS_UPDATE] User acknowledged.${note} Continue with your next tool call.`
			return withToolDocuments(
				formatResponse.toolResult(message, outcome.draft?.images, attachments.text),
				attachments.documents,
			)
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
