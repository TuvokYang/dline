import type { ContextManager } from "@core/context/context-management/ContextManager"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { MessageStateHandler } from "@core/task/message-state"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { type CheckpointRuntimeState, createTaskCheckpointManager } from "@integrations/checkpoints"
import { MultiRootCheckpointManager } from "@integrations/checkpoints/MultiRootCheckpointManager"
import { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { CanonicalCheckpointPort, ConversationRewindPort, ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { UiMessage } from "@shared/ExtensionMessage"
import { StateManager } from "@/core/storage/StateManager"

/**
 * Simple predicate abstracting our multi-root decision.
 */
export function shouldUseMultiRoot({
	workspaceManager,
	enableCheckpoints,
	stateManager,
	multiRootEnabledOverride,
}: {
	workspaceManager?: WorkspaceRootManager
	enableCheckpoints: boolean
	stateManager: StateManager
	multiRootEnabledOverride?: boolean
}): boolean {
	const multiRootEnabled = multiRootEnabledOverride ?? isMultiRootEnabled(stateManager)
	return Boolean(multiRootEnabled && enableCheckpoints && workspaceManager && workspaceManager.getRoots().length > 1)
}

type BuildArgs = {
	// common
	taskId: string
	controller: any // Controller reference for event routing
	messageStateHandler: MessageStateHandler
	// single-root deps
	fileContextTracker: FileContextTracker
	contextManager: ContextManager
	diffViewProvider: DiffViewProvider
	taskState: CheckpointRuntimeState
	taskFileTracker: TaskFileTracker
	// multi-root deps
	workspaceManager?: WorkspaceRootManager
	/** Rewinds the task's journal conversation when a journal-bounded card is restored. */
	conversationRewind?: ConversationRewindPort
	canonicalCheckpoint?: CanonicalCheckpointPort

	// callbacks for single-root TaskCheckpointManager
	updateTaskHistory: (historyItem: any) => Promise<any[]>
	say: (...args: any[]) => Promise<number | undefined>
	cancelTask: () => Promise<void>
	restoreChatRuntime: (input: { apiIndex: number; editedText?: string }) => Promise<void>
	postStateToWebview: () => Promise<void>
	publishMessage: (message: UiMessage) => Promise<void>

	// initial state for single-root
	initialConversationHistoryDeletedRange?: [number, number]
	initialCheckpointManagerErrorMessage?: string

	stateManager: StateManager
}

/**
 * Central factory for creating the appropriate checkpoint manager.
 * - MultiRootCheckpointManager for multi-root tasks
 * - TaskCheckpointManager for single-root tasks
 */
export function buildCheckpointManager(args: BuildArgs): ICheckpointManager {
	const {
		taskId,
		controller,
		messageStateHandler,
		fileContextTracker,
		contextManager,
		diffViewProvider,
		taskState,
		taskFileTracker,
		workspaceManager,
		conversationRewind,
		canonicalCheckpoint,
		updateTaskHistory,
		say,
		cancelTask,
		restoreChatRuntime,
		postStateToWebview,
		publishMessage,
		initialConversationHistoryDeletedRange,
		initialCheckpointManagerErrorMessage,
		stateManager,
	} = args

	const enableCheckpoints = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")

	if (shouldUseMultiRoot({ workspaceManager, enableCheckpoints, stateManager })) {
		// Multi-root manager (init should be kicked off externally, non-blocking).
		// conversationRewind is deliberately not passed: this manager's restore
		// never rewinds chat, API or context state, so a journal rewind here would
		// shorten the model conversation while every other store stayed put.
		// Whoever implements its chat restore must adopt the same port and the
		// rewind-first ordering used by TaskCheckpointManager.
		return new MultiRootCheckpointManager(workspaceManager!, taskId, enableCheckpoints, messageStateHandler)
	}

	// Single-root manager
	return createTaskCheckpointManager(
		{ taskId, controller },
		{ enableCheckpoints },
		{
			diffViewProvider,
			messageStateHandler,
			fileContextTracker,
			contextManager,
			taskFileTracker,
			taskState,
			workspaceManager,
			conversationRewind,
			canonicalCheckpoint,
		},
		{
			updateTaskHistory,
			say,
			cancelTask,
			restoreChatRuntime,
			postStateToWebview,
			publishMessage,
		},
		{
			conversationHistoryDeletedRange: initialConversationHistoryDeletedRange,
			checkpointManagerErrorMessage: initialCheckpointManagerErrorMessage,
		},
	)
}
