import { ContextManager } from "@core/context/context-management/ContextManager"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { Controller } from "@core/controller/index"
import { sendRelinquishControlEvent } from "@core/controller/ui/subscribeToRelinquishControl"
import { ensureTaskDirectoryExists } from "@core/storage/disk"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { findLast, findLastIndex } from "@shared/array"
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { ClineApiReqInfo, ClineMessage, ClineSay } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { HistoryItem } from "@shared/HistoryItem"
import { ClineCheckpointRestore } from "@shared/WebviewMessage"
import pTimeout from "p-timeout"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { retryWithBackoff } from "@/utils/retry"
import { MessageStateHandler } from "../../core/task/message-state"
import { TaskState } from "../../core/task/TaskState"
import type { ClineContent } from "../../shared/messages/content"
import { type ChatRestoreBoundary, resolveChatRestoreBoundary } from "./chat-restore-boundary"
import { resolveCompletionDiffBaseHash } from "./completion-diff"
import { CHECKPOINT_TRACKER_ATTEMPT_TIMEOUT_MS } from "./initializer"
import { ICheckpointManager } from "./types"

/**
 * Consecutive staging failures tolerated before the user is told that
 * checkpoints stopped recording. One failure can be a transient lock or a
 * file removed mid-flight; a run of them means no restore point is produced.
 */
const CHECKPOINT_STAGING_FAILURE_ALERT_THRESHOLD = 3

/** Prefix identifying the message this manager raises for staging failures. */
const STAGING_FAILURE_MESSAGE_PREFIX = "Checkpoints could not record"

// Type definitions for better code organization
type SayFunction = (
	type: ClineSay,
	text?: string,
	images?: string[],
	files?: string[],
	partial?: boolean,
) => Promise<number | undefined>
type UpdateTaskHistoryFunction = (historyItem: HistoryItem) => Promise<HistoryItem[]>

interface CheckpointManagerTask {
	readonly taskId: string
	readonly controller: Controller
}
interface CheckpointManagerConfig {
	readonly enableCheckpoints: boolean
	readonly createCheckpointTracker?: (
		taskId: string,
		enableCheckpoints: boolean,
		workspacePath: string,
	) => Promise<CheckpointTracker | undefined>
}
interface CheckpointManagerServices {
	readonly fileContextTracker: FileContextTracker
	readonly contextManager: ContextManager
	readonly diffViewProvider: DiffViewProvider
	readonly messageStateHandler: MessageStateHandler
	readonly taskState: TaskState
	readonly taskFileTracker?: import("./TaskFileTracker").TaskFileTracker
	readonly workspaceManager?: WorkspaceRootManager
}
interface CheckpointManagerCallbacks {
	readonly updateTaskHistory: UpdateTaskHistoryFunction
	readonly cancelTask: () => Promise<void>
	readonly restoreChatRuntime: (input: { apiIndex: number; editedText?: string }) => Promise<void>
	readonly say: SayFunction
	readonly postStateToWebview: () => Promise<void>
}
interface CheckpointManagerInternalState {
	conversationHistoryDeletedRange?: [number, number]
	checkpointTracker?: CheckpointTracker
	checkpointManagerErrorMessage?: string
	checkpointTrackerInitPromise?: Promise<CheckpointTracker | undefined>
}

interface CheckpointRestoreStateUpdate {
	conversationHistoryDeletedRange?: [number, number]
	checkpointManagerErrorMessage?: string
}

type WorkspaceRestoreResult =
	| { readonly status: "restored"; readonly checkpointHash: string }
	| { readonly status: "failed"; readonly error: string }

/**
 * TaskCheckpointManager
 *
 * A dedicated service for managing all checkpoint-related operations within a task.
 * Provides a clean separation of concerns from the main Task class while maintaining
 * full access to necessary dependencies and state.
 *
 * Public API:
 * - saveCheckpoint: Creates a new checkpoint of the current workspace state
 * - restoreCheckpoint: Restores the task to a previous checkpoint
 * - presentMultifileDiff: Displays a multi-file diff view between checkpoints
 * - doesLatestTaskCompletionHaveNewChanges: Checks if the latest task completion has new changes, used by the "See New Changes" button
 *
 * This class is designed as the main interface between the task and the checkpoint system. It is responsible for:
 * - Task-specific checkpoint operations (save/restore/diff)
 * - State management and coordination with other Task components
 * - Interaction with message state, file context tracking etc.
 * - User interaction (error messages, notifications)
 *
 * For checkpoint operations, the CheckpointTracker class is used to interact with the underlying git logic.
 */
export class TaskCheckpointManager implements ICheckpointManager {
	private readonly task: CheckpointManagerTask
	private readonly config: CheckpointManagerConfig
	private readonly services: CheckpointManagerServices
	private readonly callbacks: CheckpointManagerCallbacks
	private readonly taskState: TaskState

	private state: CheckpointManagerInternalState

	constructor(
		task: CheckpointManagerTask,
		config: CheckpointManagerConfig,
		services: CheckpointManagerServices,
		callbacks: CheckpointManagerCallbacks,
		initialState: CheckpointManagerInternalState,
	) {
		this.task = Object.freeze(task)
		this.config = config
		this.services = services
		this.callbacks = Object.freeze(callbacks)
		this.taskState = services.taskState
		this.state = { ...initialState }
	}

	private async persistCheckpointHash(messageIndex: number, commitHash: string): Promise<void> {
		await this.services.messageStateHandler.updateClineMessage(messageIndex, {
			lastCheckpointHash: commitHash,
		})
		await this.services.messageStateHandler.flushMessageUpdate(messageIndex)
		await this.callbacks.postStateToWebview()
	}

	// ============================================================================
	// Public API - Core checkpoints operations
	// ============================================================================

	/**
	 * Creates a checkpoint of the current workspace state
	 * @param isAttemptCompletionMessage - Whether this checkpoint is for an attempt completion message
	 * @param completionMessageTs - Optional timestamp of the completion message to update with checkpoint hash
	 */
	async saveCheckpoint(isAttemptCompletionMessage = false, completionMessageTs?: number): Promise<void> {
		try {
			if (!this.config.enableCheckpoints) {
				return
			}

			const clineMessages = this.services.messageStateHandler.clineMessages
			clineMessages.forEach((message) => {
				if (message.say === "checkpoint_created") {
					message.isCheckpointCheckedOut = false
				}
			})

			let checkpointMessageIndex: number | undefined
			if (!isAttemptCompletionMessage) {
				if (clineMessages.at(-1)?.say === "checkpoint_created") {
					return
				}

				const messageTs = await this.callbacks.say("checkpoint_created")
				if (messageTs !== undefined) {
					const targetMessageIndex = this.services.messageStateHandler.clineMessages.findIndex(
						(m) => m.ts === messageTs,
					)
					if (targetMessageIndex !== -1) {
						checkpointMessageIndex = targetMessageIndex
					}
				}
			}

			if (!this.state.checkpointTracker && !this.state.checkpointManagerErrorMessage) {
				await this.checkpointTrackerCheckAndInit()
			}

			if (!this.state.checkpointTracker) {
				Logger.debug(
					`[TaskCheckpointManager] File checkpoint unavailable for task ${this.task.taskId}; keeping chat checkpoint only`,
				)
				return
			}

			if (!isAttemptCompletionMessage) {
				if (checkpointMessageIndex === undefined) {
					return
				}

				try {
					const commitHash = await this.state.checkpointTracker.commit()
					if (commitHash) {
						await this.persistCheckpointHash(checkpointMessageIndex, commitHash)
					}
					await this.reportStagingHealth()
				} catch (error) {
					Logger.error(
						`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.task.taskId}:`,
						error,
					)
					await this.reportStagingHealth()
				}
				return
			}

			const recentMessages = this.services.messageStateHandler.clineMessages.slice(-3)
			const lastCompletionResultMessage = findLast(recentMessages, (m) => m.say === "completion_result")
			if (lastCompletionResultMessage?.lastCheckpointHash) {
				Logger.log("Completion checkpoint already exists, skipping duplicate checkpoint creation")
				return
			}

			const commitHash = await this.state.checkpointTracker.commit()
			await this.reportStagingHealth()
			if (!commitHash) {
				Logger.debug(
					`[TaskCheckpointManager] No file checkpoint hash for completion message in task ${this.task.taskId}; using chat checkpoint only`,
				)
				return
			}

			if (completionMessageTs !== undefined) {
				const targetMessageIndex = this.services.messageStateHandler.clineMessages.findIndex(
					(m) => m.ts === completionMessageTs,
				)
				if (targetMessageIndex !== -1) {
					await this.persistCheckpointHash(targetMessageIndex, commitHash)
				}
			} else if (lastCompletionResultMessage) {
				const targetMessageIndex = this.services.messageStateHandler.clineMessages.indexOf(lastCompletionResultMessage)
				if (targetMessageIndex !== -1) {
					await this.persistCheckpointHash(targetMessageIndex, commitHash)
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[TaskCheckpointManager] Failed to save checkpoint for task ${this.task.taskId}:`, errorMessage)
		}
	}

	/**
	 * Surface repeated staging failures that happen after initialization.
	 *
	 * Initialization failures already reach the user, but a tracker that
	 * initializes and then fails to stage produces no restore points at all
	 * while the UI still looks healthy. Only sustained failure is reported so a
	 * single transient error does not raise a false alarm.
	 */
	private async reportStagingHealth(): Promise<void> {
		const tracker = this.state.checkpointTracker
		if (!tracker) {
			return
		}
		try {
			const failures = tracker.getConsecutiveStagingFailures()
			if (failures >= CHECKPOINT_STAGING_FAILURE_ALERT_THRESHOLD) {
				await this.setcheckpointManagerErrorMessage(
					`${STAGING_FAILURE_MESSAGE_PREFIX} the last ${failures} change sets. ` +
						`Files inside nested repositories are not covered by checkpoints; ` +
						`other paths may be unreadable or locked.`,
				)
				return
			}
			// A later success clears only the message this method raised.
			if (failures === 0 && this.state.checkpointManagerErrorMessage?.startsWith(STAGING_FAILURE_MESSAGE_PREFIX)) {
				await this.setcheckpointManagerErrorMessage(undefined)
			}
		} catch (error) {
			// Health reporting is diagnostic only. It must never prevent a
			// successful checkpoint hash from being bound to its message.
			Logger.debug(`[TaskCheckpointManager] Skipped staging health report for task ${this.task.taskId}:`, error)
		}
	}

	/**
	 * Restores a checkpoint by message timestamp
	 * @param messageTs - Timestamp of the message to restore to
	 * @param restoreType - Type of restoration (task, workspace, or both)
	 * @param offset - Optional offset for the message index
	 * @returns checkpointManagerStateUpdate with any state changes that need to be applied
	 */
	async restoreCheckpoint(
		messageTs: number,
		restoreType: ClineCheckpointRestore,
		offset?: number,
		editedText?: string,
	): Promise<CheckpointRestoreStateUpdate> {
		try {
			// Restore rewinds durable conversation state only. Presentation overlays that
			// never reached a durable commit belong to the superseded continuation, so they
			// are dropped before the boundary is resolved. Keeping them made the loaded
			// length disagree with the durable count, which rejected the restore outright
			// and left in-flight compaction cards rendered after the rewind.
			if (restoreType !== "workspace") {
				this.services.messageStateHandler.clearTransientClineMessages()
			}
			const clineMessages =
				restoreType === "workspace"
					? this.services.messageStateHandler.clineMessages
					: this.services.messageStateHandler.durableClineMessages
			const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs) - (offset || 0)
			// Find the last message before messageIndex that has a lastCheckpointHash
			const lastHashIndex = findLastIndex(clineMessages.slice(0, messageIndex), (m) => m.lastCheckpointHash !== undefined)
			const message = clineMessages[messageIndex]
			const lastMessageWithHash = lastHashIndex >= 0 ? clineMessages[lastHashIndex] : undefined

			if (!message) {
				Logger.error(`[TaskCheckpointManager] Message not found for timestamp ${messageTs} in task ${this.task.taskId}`)
				return {}
			}

			const chatRestoreBoundary =
				restoreType === "workspace"
					? undefined
					: resolveChatRestoreBoundary({
							messages: clineMessages,
							messageIndex,
							apiCount: this.services.messageStateHandler.apiConversation?.count ?? 0,
							uiCount: this.services.messageStateHandler.uiMessage?.count ?? clineMessages.length,
						})
			const workspaceRestoreResult =
				restoreType === "task"
					? undefined
					: await this.restoreWorkspaceCheckpoint(message, lastMessageWithHash, messageTs, offset)
			const workspaceRestoreError = workspaceRestoreResult?.status === "failed" ? workspaceRestoreResult.error : undefined

			const checkpointManagerStateUpdate: CheckpointRestoreStateUpdate = {}

			const successfulRestoreType: ClineCheckpointRestore | undefined =
				restoreType === "taskAndWorkspace"
					? workspaceRestoreError
						? "task"
						: "taskAndWorkspace"
					: restoreType === "workspace" && workspaceRestoreError
						? undefined
						: restoreType

			if (successfulRestoreType) {
				if (successfulRestoreType !== "workspace") {
					await this.restoreChatCheckpoint(
						message,
						messageIndex,
						messageTs,
						editedText,
						successfulRestoreType === "taskAndWorkspace",
						chatRestoreBoundary as ChatRestoreBoundary,
					)
				}
				await this.finalizeSuccessfulRestore(
					successfulRestoreType,
					messageTs,
					editedText,
					workspaceRestoreResult?.status === "restored" ? workspaceRestoreResult.checkpointHash : undefined,
					chatRestoreBoundary,
				)
				if (this.state.conversationHistoryDeletedRange !== undefined) {
					checkpointManagerStateUpdate.conversationHistoryDeletedRange = this.state.conversationHistoryDeletedRange
				}
			} else {
				sendRelinquishControlEvent(this.task.controller)
			}

			if (workspaceRestoreError) {
				checkpointManagerStateUpdate.checkpointManagerErrorMessage = workspaceRestoreError
			} else if (this.state.checkpointManagerErrorMessage !== undefined) {
				checkpointManagerStateUpdate.checkpointManagerErrorMessage = this.state.checkpointManagerErrorMessage
			}

			return checkpointManagerStateUpdate
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[TaskCheckpointManager] Failed to restore checkpoint for task ${this.task.taskId}:`, errorMessage)
			sendRelinquishControlEvent(this.task.controller)
			return {
				checkpointManagerErrorMessage: errorMessage,
			}
		}
	}

	/**
	 * Presents a multi-file diff view between checkpoints
	 * @param messageTs - Timestamp of the message to show diff for
	 * @param seeNewChangesSinceLastTaskCompletion - Whether to show changes since last completion
	 */
	async presentMultifileDiff(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void> {
		const relinquishButton = () => {
			sendRelinquishControlEvent(this.task.controller)
		}

		try {
			if (!this.config.enableCheckpoints) {
				const errorMessage = "Checkpoints are disabled in settings. Cannot show diff."
				Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: errorMessage,
				})
				relinquishButton()
				return
			}

			Logger.log(`[TaskCheckpointManager] presentMultifileDiff for task ${this.task.taskId}, messageTs: ${messageTs}`)
			const clineMessages = this.services.messageStateHandler.clineMessages
			const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs)
			const message = clineMessages[messageIndex]
			if (!message) {
				Logger.error(`[TaskCheckpointManager] Message not found for timestamp ${messageTs} in task ${this.task.taskId}`)
				relinquishButton()
				return
			}
			const hash = message.lastCheckpointHash
			if (!hash) {
				Logger.error(
					`[TaskCheckpointManager] No checkpoint hash found for message ${messageTs} in task ${this.task.taskId}`,
				)
				relinquishButton()
				return
			}

			// Initialize checkpoint tracker if needed.
			if (!this.state.checkpointTracker && this.config.enableCheckpoints) {
				this.state.checkpointTracker = await this.checkpointTrackerCheckAndInit()
			}

			if (!this.state.checkpointTracker) {
				Logger.error(`[TaskCheckpointManager] Checkpoint tracker not available for task ${this.task.taskId}`)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Checkpoint tracker not available",
				})
				relinquishButton()
				return
			}

			let changedFiles:
				| {
						relativePath: string
						absolutePath: string
						before: string
						after: string
				  }[]
				| undefined

			if (seeNewChangesSinceLastTaskCompletion) {
				const previousCheckpointHash = resolveCompletionDiffBaseHash(
					this.services.messageStateHandler.clineMessages,
					messageIndex,
				)

				if (!previousCheckpointHash) {
					const errorMessage = "Unexpected error: No checkpoint hash found"
					Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: errorMessage,
					})
					relinquishButton()
					return
				}

				changedFiles = await this.state.checkpointTracker.getTaskDiffSet(previousCheckpointHash, hash)
				if (!changedFiles?.length) {
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: "No changes found",
					})
					relinquishButton()
					return
				}
			} else {
				// Get changed files between current state and commit
				changedFiles = await this.state.checkpointTracker.getDiffSet(hash)
				if (!changedFiles?.length) {
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: "No changes found",
					})
					relinquishButton()
					return
				}
			}

			// Open multi-diff editor
			const title = seeNewChangesSinceLastTaskCompletion ? "New changes" : "Changes since snapshot"
			const diffs = changedFiles.map((file) => ({
				filePath: file.absolutePath,
				leftContent: file.before,
				rightContent: file.after,
			}))
			await HostProvider.diff.openMultiFileDiff({ title, diffs })

			relinquishButton()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[TaskCheckpointManager] Failed to present multifile diff for task ${this.task.taskId}:`, errorMessage)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to retrieve diff set: ${errorMessage}`,
			})
			relinquishButton()
		}
	}

	/**
	 * Creates a checkpoint commit in the underlying tracker
	 * @returns Promise<string | undefined> The created commit hash, or undefined if failed
	 */
	async commit(): Promise<string | undefined> {
		try {
			if (!this.config.enableCheckpoints) {
				return undefined
			}

			if (!this.state.checkpointTracker) {
				await this.checkpointTrackerCheckAndInit()
			}

			if (!this.state.checkpointTracker) {
				Logger.error(`[TaskCheckpointManager] Checkpoint tracker not available for commit in task ${this.task.taskId}`)
				return undefined
			}

			return await this.state.checkpointTracker.commit()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.task.taskId}:`, errorMessage)
			return undefined
		}
	}

	/**
	 * Checks if the latest task completion has new changes
	 * @returns Promise<boolean> - True if there are new changes since last completion
	 */
	async doesLatestTaskCompletionHaveNewChanges(): Promise<boolean> {
		try {
			if (!this.config.enableCheckpoints) {
				return false
			}

			const clineMessages = this.services.messageStateHandler.clineMessages
			const messageIndex = findLastIndex(clineMessages, (m) => m.say === "completion_result")
			const message = clineMessages[messageIndex]
			if (!message) {
				Logger.error(`[TaskCheckpointManager] Completion message not found for task ${this.task.taskId}`)
				return false
			}
			const hash = message.lastCheckpointHash
			if (!hash) {
				Logger.debug(
					`[TaskCheckpointManager] No file checkpoint hash found for completion message in task ${this.task.taskId}; treating as chat-only checkpoint`,
				)
				return false
			}

			if (this.config.enableCheckpoints && !this.state.checkpointTracker) {
				this.state.checkpointTracker = await this.checkpointTrackerCheckAndInit()
			}

			if (!this.state.checkpointTracker) {
				Logger.error(`[TaskCheckpointManager] Checkpoint tracker not available for task ${this.task.taskId}`)
				return false
			}

			const previousCheckpointHash = resolveCompletionDiffBaseHash(clineMessages, messageIndex)

			if (!previousCheckpointHash) {
				// A task closed before its baseline commit landed has no file
				// checkpoint to diff against. That is a chat-only history, the same
				// case the completion message handles above, not a failure.
				Logger.debug(
					`[TaskCheckpointManager] No file checkpoint baseline for task ${this.task.taskId}; treating as chat-only history`,
				)
				return false
			}

			const changedFilesCount = (await this.state.checkpointTracker.getTaskDiffCount(previousCheckpointHash, hash)) || 0
			return changedFilesCount > 0
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[TaskCheckpointManager] Failed to check for new changes in task ${this.task.taskId}:`, errorMessage)
			return false
		}
	}

	private async restoreWorkspaceCheckpoint(
		message: ClineMessage,
		lastMessageWithHash: ClineMessage | undefined,
		messageTs: number,
		offset?: number,
	): Promise<WorkspaceRestoreResult> {
		if (!this.config.enableCheckpoints) {
			const errorMessage = "Checkpoints are disabled in settings."
			Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
			return { status: "failed", error: errorMessage }
		}

		if (!this.state.checkpointTracker) {
			this.state.checkpointTracker = await this.checkpointTrackerCheckAndInit()
		}

		const checkpointHash = message.lastCheckpointHash ?? lastMessageWithHash?.lastCheckpointHash
		if (!checkpointHash || !this.state.checkpointTracker) {
			const errorMessage = "Failed to restore checkpoint: No valid checkpoint hash found"
			Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
			return { status: "failed", error: errorMessage }
		}

		const usesFallback = message.lastCheckpointHash === undefined
		if (usesFallback && !offset) {
			Logger.warn(
				`[TaskCheckpointManager] Message ${messageTs} has no checkpoint hash, falling back to previous checkpoint for task ${this.task.taskId}`,
			)
		}

		try {
			const taskFiles = this.services.taskFileTracker?.getAllModifiedFiles() ?? []
			if (taskFiles.length > 0) {
				Logger.debug(
					`[TaskCheckpointManager] Restoring ${taskFiles.length} task-owned file(s) for task ${this.task.taskId}`,
				)
				await this.state.checkpointTracker.restoreFiles(checkpointHash, taskFiles)
			} else {
				await this.state.checkpointTracker.resetHead(checkpointHash)
			}
			return { status: "restored", checkpointHash }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			const isOffsetFallback = usesFallback && Boolean(offset)
			const diagnosticPrefix = isOffsetFallback ? "Failed to restore offset checkpoint" : "Failed to restore checkpoint"
			Logger.error(`[TaskCheckpointManager] ${diagnosticPrefix} for task ${this.task.taskId}:`, errorMessage)
			const restoreError = `${diagnosticPrefix}: ${errorMessage}`
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: restoreError })
			return { status: "failed", error: restoreError }
		}
	}

	/**
	 * Synchronously abort all active operations and reset runtime state.
	 *
	 * Called at the start of every restore so that stale asks (e.g.
	 * qna_respond waiting in idle state) are terminated before we mutate
	 * the conversation.  Uses askResponse="no" to wake pWaitFor without
	 * producing an error say, and abort=true for streaming / tool-exec
	 * safety.  This is independent of Controller.cancelTask — restore
	 * owns its own cleanup lifecycle.
	 */
	private abortAndClearState(): void {
		this.taskState.userMessageContent = []
		this.taskState.assistantMessageContent = []
		this.taskState.userMessageContentReady = false
		this.taskState.resetMistakeLimitState()
		this.taskState.lastMessageTs = undefined
		this.taskState.askResponseText = undefined
		this.taskState.askResponseImages = undefined
		this.taskState.askResponseFiles = undefined
		this.taskState.isAwaitingPlanResponse = false
		this.taskState.didRespondToPlanAskBySwitchingMode = false
	}

	private async restoreChatCheckpoint(
		message: ClineMessage,
		messageIndex: number,
		messageTs: number,
		editedText: string | undefined,
		workspaceRestored: boolean,
		boundary: ChatRestoreBoundary,
	): Promise<void> {
		if (message.compactionConversationRange && editedText !== undefined) {
			throw new Error("Editing input is unavailable when restoring a compaction card")
		}
		// The boundary indexes the durable sequence, so the deleted slice must read it too.
		const deletedMessages = this.services.messageStateHandler.durableClineMessages.slice(boundary.uiKeepCount)
		this.abortAndClearState()
		this.state.conversationHistoryDeletedRange = boundary.conversationHistoryDeletedRange
		this.taskState.conversationHistoryDeletedRange = boundary.conversationHistoryDeletedRange

		const apiConversation = this.services.messageStateHandler.apiConversation
		const userMsgIdx = boundary.apiKeepCount - 1
		await apiConversation?.truncateByLineNum(boundary.apiKeepCount)

		// Modify the user message text in-place when editing input,
		// preserving tool_result blocks so the preceding assistant's
		// tool_use stays paired.
		if (editedText !== undefined && userMsgIdx >= 0 && apiConversation && userMsgIdx < apiConversation.count) {
			const userMsg = apiConversation.getAt(userMsgIdx)
			if (userMsg && userMsg.role === "user" && Array.isArray(userMsg.content)) {
				const replaceInBlocks = (blocks: ClineContent[]): void => {
					for (const block of blocks) {
						if (block.type === "text") {
							block.text = block.text.replace(
								/<user_message>\n[\s\S]*?\n<\/user_message>/,
								`<user_message>\n${editedText}\n</user_message>`,
							)
						}
						if (block.type === "tool_result" && Array.isArray(block.content)) {
							replaceInBlocks(block.content)
						}
					}
				}
				replaceInBlocks(userMsg.content)
			}
		}

		await this.services.messageStateHandler.uiMessage?.truncateByLineNum(boundary.uiKeepCount)
		// Truncating writes the durable store directly, so aggregates computed
		// from the discarded messages have to be dropped with them. Called
		// optionally: this collaborator is supplied by the task runtime, and a
		// restore must not fail because a caller provided a narrower one.
		this.services.messageStateHandler.invalidateDerivedAggregates?.()

		await this.services.contextManager.truncateContextHistory(
			boundary.contextAnchorTs,
			await ensureTaskDirectoryExists(this.task.taskId),
		)
		const deletedApiReqsMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(deletedMessages)))

		if (!workspaceRestored) {
			const filesEditedAfterMessage = await this.services.fileContextTracker.detectFilesEditedAfterMessage(
				messageTs,
				deletedMessages,
			)
			if (filesEditedAfterMessage.length > 0) {
				await this.services.fileContextTracker.storePendingFileContextWarning(filesEditedAfterMessage)
			}
		}

		await this.callbacks.say(
			"deleted_api_reqs",
			JSON.stringify({
				tokensIn: deletedApiReqsMetrics.totalTokensIn,
				tokensOut: deletedApiReqsMetrics.totalTokensOut,
				cacheWrites: deletedApiReqsMetrics.totalCacheWrites,
				cacheReads: deletedApiReqsMetrics.totalCacheReads,
				cost: deletedApiReqsMetrics.totalCost,
			} satisfies ClineApiReqInfo),
		)

		if (editedText !== undefined) {
			await this.callbacks.say("user_feedback", editedText)
		}
	}

	private async finalizeSuccessfulRestore(
		restoreType: ClineCheckpointRestore,
		messageTs: number,
		editedText: string | undefined,
		workspaceCheckpointHash: string | undefined,
		chatRestoreBoundary: ChatRestoreBoundary | undefined,
	): Promise<void> {
		switch (restoreType) {
			case "task":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Task messages have been restored to the checkpoint",
				})
				break
			case "workspace":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Workspace files have been restored to the checkpoint",
				})
				break
			case "taskAndWorkspace":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Task and workspace have been restored to the checkpoint",
				})
				break
		}

		if (workspaceCheckpointHash !== undefined) {
			const checkpointMessages = this.services.messageStateHandler.clineMessages.filter(
				(m) => m.say === "checkpoint_created",
			)
			checkpointMessages.forEach((checkpointMessage) => {
				checkpointMessage.isCheckpointCheckedOut = checkpointMessage.lastCheckpointHash === workspaceCheckpointHash
			})
		}

		await this.services.messageStateHandler.updateTaskHistory()

		if (restoreType !== "workspace") {
			if (!chatRestoreBoundary) throw new Error("Chat Restore completed without a validated boundary")
			await this.callbacks.restoreChatRuntime({
				apiIndex: chatRestoreBoundary.runtimeApiIndex,
				...(editedText === undefined ? {} : { editedText }),
			})
		}

		await this.callbacks.postStateToWebview()
	}

	// ============================================================================
	// State management - interfaces for updating internal state
	// ============================================================================

	/**
	 * Checks for an active checkpoint tracker instance, creates if needed
	 * Uses promise-based synchronization to prevent race conditions when called concurrently
	 */
	async retryCheckpointInitialization(): Promise<boolean> {
		if (!this.config.enableCheckpoints) {
			await this.setcheckpointManagerErrorMessage("Checkpoints are disabled in settings.")
			return false
		}

		this.state.checkpointTracker = undefined
		this.services.messageStateHandler.setCheckpointTracker(undefined)
		const tracker = await this.checkpointTrackerCheckAndInit(true)
		return tracker !== undefined
	}

	async checkpointTrackerCheckAndInit(forceRetry = false): Promise<CheckpointTracker | undefined> {
		// If tracker already exists or there was an error, return immediately
		if (this.state.checkpointTracker) {
			return this.state.checkpointTracker
		}
		if (forceRetry) {
			await this.setcheckpointManagerErrorMessage(undefined)
		} else if (this.state.checkpointManagerErrorMessage) {
			return undefined
		}

		// If initialization is already in progress, wait for it to complete
		if (this.state.checkpointTrackerInitPromise) {
			return await this.state.checkpointTrackerInitPromise
		}

		// Start initialization and store the promise to prevent concurrent attempts
		this.state.checkpointTrackerInitPromise = this.initializeCheckpointTracker()

		try {
			const tracker = await this.state.checkpointTrackerInitPromise
			return tracker
		} finally {
			// Clear the promise once initialization is complete (success or failure)
			this.state.checkpointTrackerInitPromise = undefined
		}
	}

	/**
	 * Internal method to actually create the checkpoint tracker
	 */
	private async initializeCheckpointTracker(): Promise<CheckpointTracker | undefined> {
		// Warning Timer - If checkpoints take a while to initialize, show a warning message
		let checkpointsWarningTimer: NodeJS.Timeout | null = null
		let checkpointsWarningShown = false

		try {
			checkpointsWarningTimer = setTimeout(async () => {
				if (!checkpointsWarningShown) {
					checkpointsWarningShown = true
					await this.setcheckpointManagerErrorMessage(
						"Checkpoints are taking longer than expected to initialize. Working in a large repository? Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
					)
				}
			}, 15_000)

			// Timeout - If checkpoints take too long to initialize, warn user and disable checkpoints for the task
			const workspacePath = await this.getWorkspacePath()
			const createTracker = this.config.createCheckpointTracker ?? CheckpointTracker.create

			// Single-flight across retry attempts: pTimeout only stops waiting, it
			// cannot cancel the underlying Git work. Starting a second tracker
			// after a timeout made both attempts fight for the same shadow-repo
			// mutex and repeat the whole topology/baseline scan. A timed-out
			// attempt therefore stays in flight and the retry waits on the same
			// promise; only a real rejection clears it so the retry can start
			// a fresh attempt.
			let inFlightCreate: Promise<CheckpointTracker | undefined> | undefined
			const startOrReuseCreate = (): Promise<CheckpointTracker | undefined> => {
				if (!inFlightCreate) {
					const attempt = createTracker(this.task.taskId, this.config.enableCheckpoints, workspacePath)
					inFlightCreate = attempt
					attempt.catch(() => {
						if (inFlightCreate === attempt) inFlightCreate = undefined
					})
				}
				return inFlightCreate
			}

			const tracker = await retryWithBackoff(
				() =>
					pTimeout(startOrReuseCreate(), {
						milliseconds: CHECKPOINT_TRACKER_ATTEMPT_TIMEOUT_MS,
						message:
							"Checkpoints taking too long to initialize. Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
					}),
				{
					operationName: "Checkpoint shadow initialization",
					maxAttempts: 2,
					baseDelayMs: 50,
					shouldRetry: (error) => !this.isPermanentCheckpointCapabilityError(error),
					onRetry: (error, attempt, maxAttempts, delayMs) => {
						Logger.warn(
							`Checkpoint shadow initialization failed on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms:`,
							error,
						)
					},
				},
			)

			// Inject the per-task file tracker so that subsequent checkpoint
			// commits stage only files modified by tool handlers (incremental
			// git add), avoiding expensive full-workspace scans.
			if (tracker && this.services.taskFileTracker) {
				tracker.setTaskFileTracker(this.services.taskFileTracker)
			}

			// Update the state with the created tracker
			this.state.checkpointTracker = tracker
			this.services.messageStateHandler.setCheckpointTracker(tracker)
			await this.setcheckpointManagerErrorMessage(undefined)
			return tracker
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error("Failed to initialize checkpoint tracker:", errorMessage)

			// If the error was a timeout, we disable all checkpoint operations for the rest of the task
			if (errorMessage.includes("Checkpoints taking too long to initialize")) {
				await this.setcheckpointManagerErrorMessage(
					"Checkpoints initialization timed out. Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
				)
			} else {
				await this.setcheckpointManagerErrorMessage(errorMessage)
			}
			return undefined
		} finally {
			// Always clean up the timer to prevent memory leaks
			if (checkpointsWarningTimer) {
				clearTimeout(checkpointsWarningTimer)
				checkpointsWarningTimer = null
			}
		}
	}

	private isPermanentCheckpointCapabilityError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error)
		return (
			message.includes("Git must be installed to use checkpoints") ||
			message.includes("Cannot access workspace directory") ||
			message.includes("Cannot use checkpoints in") ||
			message.includes("No workspace detected") ||
			message.includes("Checkpoints are disabled in settings")
		)
	}

	/**
	 * Updates the checkpoint tracker instance
	 */
	setCheckpointTracker(checkpointTracker: CheckpointTracker | undefined): void {
		this.state.checkpointTracker = checkpointTracker
	}

	/**
	 * Updates the checkpoint tracker error message and posts to webview
	 */
	async setcheckpointManagerErrorMessage(errorMessage: string | undefined): Promise<void> {
		this.state.checkpointManagerErrorMessage = errorMessage
		this.taskState.checkpointManagerErrorMessage = errorMessage
		// Post state to webview so users can see the error message immediately
		try {
			await this.callbacks.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to post state to webview after checkpoint error:", error)
		}
		// TODO - Future telemetry event capture here
	}

	/**
	 * Updates the conversation history deleted range
	 */
	updateConversationHistoryDeletedRange(range: [number, number] | undefined): void {
		this.state.conversationHistoryDeletedRange = range
		// TODO - Future telemetry event capture here
	}

	// ============================================================================
	// Internal utilities - Private helpers for checkpoint operations
	// ============================================================================

	/**
	 * Gets the workspace path from WorkspaceRootManager when available, otherwise falls back to CheckpointUtils
	 * @returns Promise<string> The workspace path to use for checkpoint operations
	 */
	private async getWorkspacePath(): Promise<string> {
		// Try to use the centralized WorkspaceRootManager first
		if (this.services.workspaceManager) {
			try {
				const primaryRoot = this.services.workspaceManager.getPrimaryRoot()
				if (primaryRoot) {
					return primaryRoot.path
				}
				Logger.warn(`[TaskCheckpointManager] WorkspaceRootManager returned no primary root for task ${this.task.taskId}`)
			} catch (error) {
				Logger.warn(
					`[TaskCheckpointManager] Failed to get workspace path from WorkspaceRootManager for task ${this.task.taskId}:`,
					error,
				)
			}
		}

		// Fallback to the legacy CheckpointUtils implementation
		const { getWorkingDirectory: getWorkingDirectoryImpl } = await import("./CheckpointUtils")
		return getWorkingDirectoryImpl()
	}

	/**
	 * Provides read-only access to current state for internal operations
	 */
	//private get currentState(): Readonly<CheckpointManagerInternalState> {
	//	return Object.freeze({ ...this.state })
	//}

	/**
	 * Provides public read-only access to current state
	 */
	public getCurrentState(): Readonly<CheckpointManagerInternalState> {
		return Object.freeze({ ...this.state })
	}

	/**
	 * Provides read-only access to dependencies for internal operations
	 */
	//private get deps(): Readonly<CheckpointManagerDependencies> {
	//	return this.dependencies
	//}
}

// ============================================================================
// Factory function for clean instantiation
// ============================================================================

/**
 * Creates a new TaskCheckpointManager instance
 */
export function createTaskCheckpointManager(
	task: CheckpointManagerTask,
	config: CheckpointManagerConfig,
	services: CheckpointManagerServices,
	callbacks: CheckpointManagerCallbacks,
	initialState: CheckpointManagerInternalState,
): TaskCheckpointManager {
	return new TaskCheckpointManager(task, config, services, callbacks, initialState)
}
