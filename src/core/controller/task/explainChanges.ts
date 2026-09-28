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

		const checkpointManager = controller.task.checkpointManager
		if (!checkpointManager) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Checkpoints not enabled",
			})
			relinquishButton()
			return Empty.create({})
		}

		const messageStateHandler = controller.task.messageStateHandler
		let changedFiles
		try {
			changedFiles = await checkpointManager.getTaskChangesForCheckpoint(request.messageTs)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unable to load checkpoint changes"
			Logger.error(`[explainChanges] Failed to load checkpoint changes:`, errorMessage)
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
			relinquishButton()
			return Empty.create({})
		}
		if (!changedFiles.length) {
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

		// Get conversation summary for context
		const apiConversationHistory = messageStateHandler.apiConversationHistory
		const conversationSummary = stringifyConversationHistory(apiConversationHistory)

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

		// Capture reference to the task for abort checking
		const task = controller.task

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
			() => task?.taskState?.abort === true,
		)

		// Check if we were aborted during streaming
		if (task?.taskState?.abort) {
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
