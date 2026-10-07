import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { showSystemNotification } from "@integrations/notifications"
import { findLastIndex, parsePartialArrayString } from "@shared/array"
import { ClineAsk, ClineAskQuestion } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import { telemetryService } from "@/services/telemetry"
import { ToolUse } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import type { InteractionOutcome } from "../../interaction/InteractionCoordinator"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { attachToolFeedbackFiles, sayFeedbackOnce } from "../utils/UserFeedbackUtils"

export class AskFollowupQuestionToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.ASK

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.question}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const question = block.params.question || ""
		const optionsRaw = block.params.options || "[]"
		const sharedMessage = {
			question: uiHelpers.removeClosingTag(block, "question", question),
			options: parsePartialArrayString(uiHelpers.removeClosingTag(block, "options", optionsRaw)),
		} satisfies ClineAskQuestion

		await uiHelpers.ask("followup" as ClineAsk, JSON.stringify(sharedMessage), true, { existingTs: block.ts }).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const question: string | undefined = block.params.question
		const optionsRaw: string | undefined = block.params.options

		// Validate required parameter
		if (!question) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "question", undefined, block.ts)
		}
		config.taskState.consecutiveMistakeCount = 0

		// In yolo mode, don't wait for user input - instruct AI to use tools instead
		if (config.yoloModeToggled) {
			// Log the question that was asked but auto-respond
			const truncatedQuestion = `${question.substring(0, 100)}${question.length > 100 ? "..." : ""}`
			await config.callbacks.say("info", renderPrompt("toolHandlers", "yoloAutoRespond", { QUESTION: truncatedQuestion }))

			return formatResponse.toolResult(renderPrompt("toolHandlers", "yoloToolResult", { QUESTION: question }))
		}

		// Show notification if enabled
		if (config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: getPrompt("toolHandlers", "askFollowupNotificationSubtitle"),
				message: question.replace(/\n/g, " "),
			})
		}

		const sharedMessage = {
			question: question,
			options: parsePartialArrayString(optionsRaw || "[]"),
		} satisfies ClineAskQuestion

		const options = parsePartialArrayString(optionsRaw || "[]")

		const outcome = await config.interactions.open({
			turnId: interactionTurnId(block),
			interactionId: interactionId(block),
			kind: "followup",
			presentation: JSON.stringify(sharedMessage),
			existingTs: block.ts,
		})
		return this.continueInteraction(config, block, outcome)
	}

	/** Consume a follow-up response without replaying notification or presentation setup. */
	async continueInteraction(config: TaskConfig, block: ToolUse, outcome: InteractionOutcome): Promise<ToolResponse> {
		const optionsRaw: string | undefined = block.params.options
		const options = parsePartialArrayString(optionsRaw || "[]")
		const sharedMessage = { question: block.params.question || "", options } satisfies ClineAskQuestion
		const text = outcome.draft?.text
		const images = outcome.draft?.images
		const followupFiles = outcome.draft?.files
		const selectedOption =
			options.find((option) => text === option) ??
			options.filter((option) => text?.startsWith(`${option}: `)).sort((left, right) => right.length - left.length)[0]

		// Check if options contains the text response
		if (optionsRaw && selectedOption) {
			telemetryService.captureOptionSelected(config.ulid ?? "", options.length, "act")

			// Valid option selected, update last followup message with selected option
			const clineMessages = config.messageState.clineMessages
			const lastFollowupMessageIndex = findLastIndex(clineMessages, (message) => message.ask === "followup")
			if (lastFollowupMessageIndex !== -1) {
				const updatedText = JSON.stringify({
					...sharedMessage,
					selected: selectedOption,
				} satisfies ClineAskQuestion)
				await config.callbacks.updateClineMessage(lastFollowupMessageIndex, { text: updatedText })
				await config.messageState.flushMessageUpdate(lastFollowupMessageIndex)
			}
		} else {
			telemetryService.captureOptionsIgnored(config.ulid ?? "", options.length, "act")
		}
		await sayFeedbackOnce(config, "messageResponse", text, images, followupFiles)

		const fileContentString = await attachToolFeedbackFiles(config.taskState.userMessageContent, followupFiles)
		return formatResponse.toolResult(`<feedback>\n${text}\n</feedback>`, images, fileContentString)
	}
}
