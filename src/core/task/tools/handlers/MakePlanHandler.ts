import type { ToolUse } from "@core/assistant-message"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { findLast } from "@shared/array"
import { telemetryService } from "@/services/telemetry"
import type { ClineMakePlanResponse } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { InteractionOutcome } from "../../interaction/InteractionCoordinator"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { getTaskCompletionTelemetry } from "../utils"
import { attachToolFeedbackFiles, sayFeedbackOnce } from "../utils/UserFeedbackUtils"

const MAKE_PLAN_ASK = "make_plan" as const

export class MakePlanHandler implements IToolHandler, IPartialBlockHandler {
	public readonly name = ClineDefaultTool.MAKE_PLAN

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Stream make_plan through its UI contract.
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const response = block.params.response

		const sharedMessage = {
			response: uiHelpers.removeClosingTag(block, "response", response),
		} satisfies ClineMakePlanResponse

		await uiHelpers.ask(MAKE_PLAN_ASK, JSON.stringify(sharedMessage), true, { existingTs: block.ts }).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const response: string | undefined = block.params.response
		const needsMoreExploration: boolean = block.params.needs_more_exploration === "true"

		// Validate required parameters
		if (!response) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "response", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0

		// If the model discovers missing context while drafting a plan, let it return to exploration without opening the interaction.
		if (needsMoreExploration) {
			return formatResponse.toolResult(getPrompt("toolHandlers", "planNeedsMoreExploration"))
		}

		const sharedMessage = { response } satisfies ClineMakePlanResponse

		// Auto-switch to Act mode while in yolo mode
		if (config.mode === "plan" && config.yoloModeToggled) {
			// Trigger automatic mode switch
			const switchSuccessful = await config.callbacks.switchToActMode()

			if (switchSuccessful) {
				// Complete the plan mode response tool call (this is a unique case where we auto-respond to the user with an ask response)
				const lastPlanMessage = findLast(config.messageState.clineMessages, (message) => message.ask === MAKE_PLAN_ASK)
				if (lastPlanMessage) {
					lastPlanMessage.text = JSON.stringify(sharedMessage)
					lastPlanMessage.partial = false
					await config.messageState.updateTaskHistory()
				}

				// No user response content is needed after the automatic mode switch.
				return formatResponse.toolResult(getPrompt("toolHandlers", "planYoloSwitchToAct"))
			}
			Logger.warn(getPrompt("toolHandlers", "planYoloSwitchFailed"))
		}

		// Set awaiting plan response state
		config.taskState.isAwaitingPlanResponse = true

		const outcome = await config.interactions.open({
			turnId: interactionTurnId(block),
			interactionId: interactionId(block),
			kind: "make_plan",
			presentation: JSON.stringify(sharedMessage),
			existingTs: block.ts,
		})
		return this.continueInteraction(config, block, outcome)
	}

	/** Consume a make_plan response without replaying presentation or mode-switch setup. */
	async continueInteraction(config: TaskConfig, _block: ToolUse, outcome: InteractionOutcome): Promise<ToolResponse> {
		const text = outcome.draft?.text
		const images = outcome.draft?.images
		const responseFiles = outcome.draft?.files

		config.taskState.isAwaitingPlanResponse = false

		if (text || (images && images.length > 0) || (responseFiles && responseFiles.length > 0)) {
			await sayFeedbackOnce(config, "messageResponse", text, images, responseFiles)
		}

		const fileContentString = await attachToolFeedbackFiles(config.taskState.userMessageContent, responseFiles)

		telemetryService.captureTaskCompleted(config.ulid ?? "", getTaskCompletionTelemetry(config))

		// Handle mode switching response
		if (config.taskState.didRespondToPlanAskBySwitchingMode) {
			const switchMsg = text
				? renderPrompt("toolHandlers", "planSwitchToActWithMessage", { TEXT: text })
				: getPrompt("toolHandlers", "planSwitchToAct")
			const result = formatResponse.toolResult(switchMsg, images, fileContentString)
			// Reset the flag after using it to prevent it from persisting
			config.taskState.didRespondToPlanAskBySwitchingMode = false
			return result
		}
		// if we didn't switch to ACT MODE, then we can just send the user_feedback message
		return formatResponse.toolResult(`<feedback>\n${text}\n</feedback>`, images, fileContentString)
	}
}
