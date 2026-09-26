import type CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { resolveCompletionDiffBaseHash } from "@integrations/checkpoints/completion-diff"
import { Empty } from "@shared/proto/dline/common"
import { ExplainChangesRequest } from "@shared/proto/dline/task"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { sendRelinquishControlEvent } from "../ui/subscribeToRelinquishControl"
import {
	buildDiffContent,
	openDiffView,
	setupCommentController,
	streamAIExplanationComments,
	stringifyConversationHistory,
} from "./explainChangesShared"

/**
 * Explains the changes made by the AI and adds inline comments explaining them.
 *
 * This handler streams comments in real-time:
 * 1. Gets the diff from the checkpoint tracker
 * 2. Opens the diff view IMMEDIATELY so user sees progress
 * 3. Streams the AI response and adds comments as they're generated
 * 4. Each comment appears in the diff view as soon as it's parsed
 */
export async function explainChanges(controller: Controller, request: ExplainChangesRequest): Promise<Empty> {
	const relinquishButton = () => {
		sendRelinquishControlEvent(controller)
	}

	try {
		// Validate we have an active task with checkpoint manager
		if (!controller.task) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No active task",
			})
			relinquishButton()
			return Empty.create({})
		}

		const checkpointManager = controller.task.owners.checkpoints
		if (!checkpointManager) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Checkpoints not enabled",
			})
			relinquishButton()
			return Empty.create({})
		}

		// Checkpoints can be disabled per task; the owner then has no tracker to diff against.
		if (!controller.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Checkpoints are disabled in settings. Cannot review changes.",
			})
			relinquishButton()
			return Empty.create({})
		}

		const messageStateHandler = controller.task.owners.messages

		// Find the message
		const clineMessages = messageStateHandler.clineMessages
		const messageIndex = clineMessages.findIndex((m) => m.ts === request.messageTs)
		const message = clineMessages[messageIndex]

		if (!message) {
			Logger.error(`[explainChanges] Message not found for timestamp ${request.messageTs}`)
			relinquishButton()
			return Empty.create({})
		}

		const hash = message.lastCheckpointHash
		if (!hash) {
			Logger.error(`[explainChanges] No checkpoint hash found for message ${request.messageTs}`)
			relinquishButton()
			return Empty.create({})
		}

		// The owner performs single-flight tracker initialization; a failure is
		// already reported to the user through the checkpoint error message.
		const checkpointTracker: CheckpointTracker | undefined = await checkpointManager.checkpointTrackerCheckAndInit?.()
		if (!checkpointTracker) {
			Logger.error(`[explainChanges] Checkpoint tracker not available`)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Checkpoint tracker not available",
			})
			relinquishButton()
			return Empty.create({})
		}

		const previousCheckpointHash = resolveCompletionDiffBaseHash(clineMessages, messageIndex)

		if (!previousCheckpointHash) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Unexpected error: No checkpoint hash found",
			})
			relinquishButton()
			return Empty.create({})
		}

		const changedFiles = await checkpointTracker.getTaskDiffSet(previousCheckpointHash, hash)
		if (!changedFiles?.length) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No changes found to review",
			})
			relinquishButton()
			return Empty.create({})
		}

		// Get API configuration
		const apiConfiguration = controller.stateManager.getApiConfiguration()
		if (!apiConfiguration) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "API configuration not available",
			})
			relinquishButton()
			return Empty.create({})
		}

		// The conversation the model was actually sent, so the explanation shares its context.
		const conversationSummary = stringifyConversationHistory(await messageStateHandler.readConversationHistory())

		// Set up the comment controller with reply handler
		const commentController = await setupCommentController(apiConfiguration, changedFiles, conversationSummary)

		// Build the diff content for the AI
		const diffContent = buildDiffContent(changedFiles)

		// For 3+ files, cycle through each file showing comments as they stream
		// For 2 or fewer files, just open the multi-diff view directly
		const shouldRevealComments = changedFiles.length >= 3

		// If 2 or fewer files, open the diff view first so user sees it immediately
		if (!shouldRevealComments) {
			await openDiffView("Explain Changes", changedFiles)
		}

		// Capture the session so streaming stops when this task incarnation halts.
		const session = controller.task
		const isHalted = () => {
			const phase = session.state().flow.phase
			return phase === "terminated" || phase === "error" || phase === "completed" || phase === "paused"
		}

		// Stream AI explanation comments and add them as they arrive
		// Each comment will open its virtual doc and scroll to show the comment (if 3+ files)
		await streamAIExplanationComments(
			apiConfiguration,
			diffContent,
			conversationSummary,
			changedFiles,
			// onCommentStart: Create the comment UI immediately when we know the location
			(filePath, startLine, endLine) => {
				const matchingFile = changedFiles.find((f) => f.absolutePath === filePath || f.relativePath === filePath)
				commentController.startStreamingComment(
					filePath,
					startLine,
					endLine,
					matchingFile?.relativePath,
					matchingFile?.after,
					shouldRevealComments, // Only cycle through files if 3+ files
				)
			},
			// onCommentChunk: Append text as it streams in
			(chunk) => {
				commentController.appendToStreamingComment(chunk)
			},
			// onCommentEnd: Finalize the comment
			() => {
				commentController.endStreamingComment()
			},
			// shouldAbort: Check if task was cancelled
			isHalted,
		)

		// Check if we were aborted during streaming
		if (isHalted()) {
			// Close diff views and clear comments when cancelled
			commentController.clearAllComments()
			await commentController.closeDiffViews()
			relinquishButton()
			return Empty.create({})
		}

		// After all comments are done, open the multi-diff view to show everything together (if 3+ files)
		if (shouldRevealComments) {
			await openDiffView("Explain Changes", changedFiles)
		}

		// Relinquish button after comments are done
		relinquishButton()
		return Empty.create({})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error"
		Logger.error("Error in explainChanges:", errorMessage)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Failed to explain changes: ${errorMessage}`,
		})
		sendRelinquishControlEvent(controller)
		return Empty.create({})
	}
}
