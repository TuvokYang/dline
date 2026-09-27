import type { ToolUse } from "@core/assistant-message"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import type { UiQnaResponse } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import type { InteractionOutcome } from "../../interaction/InteractionProtocol"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { sayFeedbackOnce } from "../utils/UserFeedbackUtils"

/**
 * QnaRespondHandler — handles the qna_respond tool.
 *
 * Mirrors MakePlanHandler exactly:
 * handlePartialBlock uses ask() so content streams into the Q&A component,
 * execute uses ask() to finalize content, save checkpoint, and block for user input.
 */
export class QnaRespondHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.QNA_RESPOND

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const response = uiHelpers.removeClosingTag(block, "response", block.params.response)
		if (response) {
			const sharedMessage: UiQnaResponse = { response }
			await uiHelpers.ask(this.name, JSON.stringify(sharedMessage), true, { existingTs: block.ts }).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const response: string | undefined = (block.params as Record<string, string | undefined>).response

		if (!response) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "response", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0

		const sharedMessage: UiQnaResponse = { response }

		config.taskState.isAwaitingPlanResponse = true

		try {
			const outcome = await config.interactions.open({
				turnId: interactionTurnId(block),
				interactionId: interactionId(block),
				kind: "qna_response",
				presentation: JSON.stringify(sharedMessage),
				existingTs: block.ts,
			})
			return await this.continueInteraction(config, block, outcome)
		} finally {
			config.taskState.isAwaitingPlanResponse = false
		}
	}

	/** Consume a Q&A response without replaying presentation or other pre-response work. */
	async continueInteraction(config: TaskConfig, _block: ToolUse, outcome: InteractionOutcome): Promise<ToolResponse> {
		config.taskState.isAwaitingPlanResponse = false
		const text = outcome.draft?.text
		const images = outcome.draft?.images
		const files = outcome.draft?.files

		let fileContentString = ""
		if (files && files.length > 0) {
			const { processFilesIntoText } = await import("@integrations/misc/extract-text")
			fileContentString = await processFilesIntoText(files)
		}

		if (config.taskState.didRespondToPlanAskBySwitchingMode) {
			config.taskState.didRespondToPlanAskBySwitchingMode = false
			if (text || (images && images.length > 0) || fileContentString) {
				await sayFeedbackOnce(config, "messageResponse", text, images, files)
			}
			const switchMessage = text
				? renderPrompt("toolHandlers", "planSwitchToActWithMessage", { TEXT: text })
				: getPrompt("toolHandlers", "planSwitchToAct")
			return formatResponse.toolResult(switchMessage, images, fileContentString)
		}

		if (text || (images && images.length > 0) || fileContentString) {
			await sayFeedbackOnce(config, "messageResponse", text, images, files)
			return formatResponse.toolResult(`<feedback>\n${text}\n</feedback>`, images, fileContentString)
		}

		return formatResponse.toolResult("User continued the conversation.")
	}
}
