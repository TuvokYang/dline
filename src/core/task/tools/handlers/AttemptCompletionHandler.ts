import type Anthropic from "@anthropic-ai/sdk"
import type { ToolUse } from "@core/assistant-message"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import * as NotificationHook from "@core/hooks/notification-hook"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@services/telemetry"
import { findLastIndex } from "@shared/array"
import { Logger } from "@shared/services/Logger"
import { ClineDefaultTool } from "@shared/tools"
import { commitCompletion } from "../../completion/CompletionCommit"
import type { ToolResponse } from "../../index"
import type { InteractionOutcome } from "../../interaction/InteractionCoordinator"
import { buildUserFeedbackContent } from "../../utils/buildUserFeedbackContent"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { getTaskCompletionTelemetry } from "../utils"
import { attachToolFeedbackFiles, sayFeedbackOnce } from "../utils/UserFeedbackUtils"

const TASK_PREVIEW_MAX_CHARS = 8000

function getInitialTaskPreview(config: TaskConfig): string | undefined {
	const firstTaskMessage = config.messageState.clineMessages.find((message) => message.say === "task")?.text?.trim()
	if (!firstTaskMessage) {
		return undefined
	}
	if (firstTaskMessage.length <= TASK_PREVIEW_MAX_CHARS) {
		return firstTaskMessage
	}
	return `${firstTaskMessage.slice(0, TASK_PREVIEW_MAX_CHARS)}\n...[truncated]`
}

export class AttemptCompletionHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.ATTEMPT

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Handle partial block streaming for attempt_completion
	 */
	async handlePartialBlock(_block: ToolUse, _uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		// Completion remains provisional until all commit prerequisites succeed.
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const result: string | undefined = block.params.result

		// Validate required parameters
		if (!result) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "result", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0

		// Double-check completion: reject attempt_completion calls that haven't been re-verified
		if (config.doubleCheckCompletionEnabled && !config.taskState.doubleCheckCompletionPending) {
			config.taskState.doubleCheckCompletionPending = true
			// Use block.ts to remove the partial completion_result from handlePartialBlock
			if (block.ts !== undefined) {
				await config.callbacks.say("completion_result", "", undefined, undefined, false, block.ts)
			}

			const taskPreview = getInitialTaskPreview(config)
			const taskSection = taskPreview ? `\n\n<initial_task>\n${taskPreview}\n</initial_task>` : ""

			return formatResponse.toolError(
				renderPrompt("toolHandlers", "doubleCheckVerification", { TASK_SECTION: taskSection }),
			)
		}
		// Reset so the next attempt_completion pair triggers double-check again
		config.taskState.doubleCheckCompletionPending = false

		// Run PreToolUse hook before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		// Show notification if enabled
		if (config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: getPrompt("toolHandlers", "attemptCompletionNotificationSubtitle"),
				message: result.replace(/\n/g, " "),
			})
		}

		return this.commitAndPresentCompletion(config, block)
	}

	private async commitAndPresentCompletion(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const result = block.params.result
		if (!result) throw new Error("Invalid attempt_completion continuation result")

		await commitCompletion({
			publishResult: () => config.callbacks.say("completion_result", result, undefined, undefined, false, block.ts),
			saveCheckpoint: (completionMessageTs) => config.callbacks.saveCheckpoint(true, completionMessageTs),
			markWorkspaceChanges: (completionMessageTs) => this.markCompletionWorkspaceChanges(config, completionMessageTs),
			captureTelemetry: () => telemetryService.captureTaskCompleted(config.ulid ?? "", getTaskCompletionTelemetry(config)),
		})

		// Run TaskComplete hook BEFORE presenting the "Start New Task" button
		// At this point we know: task is complete, checkpoint saved, result shown to user
		await this.runTaskCompleteHook(config, block)
		await NotificationHook.emitTaskCompleteNotification(
			{
				messageStateHandler: config.messageState,
				taskId: config.taskId,
				hooksEnabled: getHooksEnabledSafe(config.services.stateManager.getGlobalSettingsKey("hooksEnabled")),
				model: getHookModelContext(config.api, config.services.stateManager),
			},
			{ message: result },
		)

		const outcome = await config.interactions.complete({
			turnId: interactionTurnId(block),
			interactionId: interactionId(block),
			completionId: interactionId(block),
			presentation: result,
			existingTs: block.ts,
		})
		return this.continueInteraction(config, block, outcome)
	}

	/**
	 * Record whether this completion produced diffable workspace changes.
	 *
	 * The verdict is stored as a field on the completion row instead of a marker
	 * appended to its text: the same row is immediately rewritten as an ask
	 * presentation carrying the model's original result, which would discard any
	 * text marker. The row is located by its timestamp because that rewrite also
	 * clears `say`.
	 */
	private async markCompletionWorkspaceChanges(config: TaskConfig, completionMessageTs: number | undefined): Promise<void> {
		const hasNewChanges = await config.callbacks.doesLatestTaskCompletionHaveNewChanges()
		if (!hasNewChanges) {
			return
		}
		const clineMessages = config.messageState.clineMessages
		const completionIndex =
			completionMessageTs === undefined
				? findLastIndex(clineMessages, (message) => message.say === "completion_result")
				: clineMessages.findIndex((message) => message.ts === completionMessageTs)
		if (completionIndex === -1 || clineMessages[completionIndex]?.completionHasChanges === true) {
			return
		}
		await config.messageState.updateClineMessage(completionIndex, { completionHasChanges: true })
	}

	/** Consume completion feedback without replaying the completion commit. */
	async continueInteraction(config: TaskConfig, _block: ToolUse, outcome: InteractionOutcome): Promise<ToolResponse> {
		const text = outcome.draft?.text
		const images = outcome.draft?.images
		const completionFiles = outcome.draft?.files
		const prefix = "[attempt_completion] Result: Done"
		if (outcome.actionId === "start_new_task") {
			return prefix
		}
		await sayFeedbackOnce(config, "messageResponse", text, images, completionFiles)

		// Run UserPromptSubmit hook when user provides post-completion feedback
		let hookContextModification: string | undefined
		if (text || (images && images.length > 0) || (completionFiles && completionFiles.length > 0)) {
			const userContentForHook = await buildUserFeedbackContent(text, images, completionFiles)

			const hookResult = await config.callbacks.runUserPromptSubmitHook(userContentForHook, "feedback")

			if (hookResult.cancel === true) {
				return formatResponse.toolDenied()
			}

			// Capture hook context modification to add to tool results
			hookContextModification = hookResult.contextModification
		}

		const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []

		if (text) {
			toolResults.push(
				{
					type: "text",
					text: "The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.",
				},
				{
					type: "text",
					text: `<feedback>\n${text}\n</feedback>`,
				},
			)
		}

		// Add hook context modification if provided
		if (hookContextModification) {
			toolResults.push({
				type: "text" as const,
				text: `<hook_context source="UserPromptSubmit">\n${hookContextModification}\n</hook_context>`,
			})
		}

		const fileContentString = await attachToolFeedbackFiles(config.taskState.userMessageContent, completionFiles)
		if (fileContentString) {
			toolResults.push({
				type: "text" as const,
				text: fileContentString,
			})
		}

		if (images && images.length > 0) {
			toolResults.push(...formatResponse.imageBlocks(images))
		}

		// Return the tool results as a complex response
		return [
			{
				type: "text" as const,
				text: prefix,
			},
			...toolResults,
		]
	}

	/**
	 * Runs the TaskComplete hook after user confirms task completion.
	 * This is a non-cancellable, observation-only hook similar to TaskCancel.
	 * Errors are logged but do not affect task completion.
	 */
	private async runTaskCompleteHook(config: TaskConfig, block: ToolUse): Promise<void> {
		const hooksEnabled = getHooksEnabledSafe(config.services.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (!hooksEnabled) {
			return
		}

		try {
			const { executeHook } = await import("@core/hooks/hook-executor")

			await executeHook({
				hookName: "TaskComplete",
				hookInput: {
					taskComplete: {
						taskMetadata: {
							taskId: config.taskId,
							ulid: config.ulid ?? "",
							result: block.params.result || "",
						},
					},
				},
				isCancellable: false, // Non-cancellable - task is already complete
				say: config.callbacks.say,
				setActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				clearActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				messageStateHandler: config.messageState,
				taskId: config.taskId,
				hooksEnabled,
				model: getHookModelContext(config.api, config.services.stateManager),
			})
		} catch (error) {
			// TaskComplete hook failed - non-fatal, just log
			Logger.error("[TaskComplete Hook] Failed (non-fatal):", error)
		}
	}
}
