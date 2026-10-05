import type { ToolUse } from "@core/assistant-message"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { ClineDefaultTool } from "@shared/tools"
import type { ToolResponse } from "../../index"
import type { InteractionOutcome } from "../../interaction/InteractionCoordinator"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { attachToolFeedbackFiles, sayFeedbackOnce } from "../utils/UserFeedbackUtils"

export class GenerateReportHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.GENERATE_REPORT

	getDescription(block: ToolUse): string {
		return `[${block.name}] ${(block.params as Record<string, string>).title || ""}`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const content = uiHelpers.removeClosingTag(block, "content", block.params.content)
		if (content) {
			const sharedMessage = JSON.stringify({
				title: block.params.title || "",
				content,
			})
			await uiHelpers.ask("generate_report" as any, sharedMessage, true, { existingTs: block.ts }).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const title: string = (block.params as Record<string, string>).title || ""
		const content: string = (block.params as Record<string, string>).content || ""

		if (!title || !content) {
			config.taskState.consecutiveMistakeCount++
			const missingParam = !title ? "title" : "content"
			return await config.callbacks.sayAndCreateMissingParamError(block.name, missingParam, undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0

		const sharedMessage = JSON.stringify({ title, content })

		config.taskState.isAwaitingPlanResponse = true

		const outcome = await config.interactions.open({
			turnId: interactionTurnId(block),
			interactionId: interactionId(block),
			kind: "generate_report",
			presentation: sharedMessage,
			existingTs: block.ts,
		})
		return this.continueInteraction(config, block, outcome)
	}

	/** Consume a report response without replaying report presentation. */
	async continueInteraction(config: TaskConfig, _block: ToolUse, outcome: InteractionOutcome): Promise<ToolResponse> {
		const text = outcome.draft?.text
		const images = outcome.draft?.images
		const files = outcome.draft?.files

		config.taskState.isAwaitingPlanResponse = false
		const fileContentString = await attachToolFeedbackFiles(config.taskState.userMessageContent, files)

		// Handle mode switching response (same as MakePlanHandler)
		if (config.taskState.didRespondToPlanAskBySwitchingMode) {
			config.taskState.didRespondToPlanAskBySwitchingMode = false
			const switchMsg = text
				? renderPrompt("toolHandlers", "planSwitchToActWithMessage", { TEXT: text })
				: getPrompt("toolHandlers", "planSwitchToAct")
			return formatResponse.toolResult(switchMsg, images, fileContentString)
		}

		if (text || (images && images.length > 0) || fileContentString) {
			await sayFeedbackOnce(config, "messageResponse", text, images, files)
			return formatResponse.toolResult(`<feedback>\n${text}\n</feedback>`, images, fileContentString)
		}

		return formatResponse.toolResult("[GENERATE_REPORT] User reviewed the report and continued.")
	}
}
