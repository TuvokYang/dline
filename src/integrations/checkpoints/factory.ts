import type { ContextManager } from "@core/context/context-management/ContextManager"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { MessageStateHandler } from "@core/task/message-state"
import type { TaskState } from "@core/task/TaskState"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { createTaskCheckpointManager } from "@integrations/checkpoints"
import { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
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
	taskState: TaskState
	taskFileTracker: TaskFileTracker
	// multi-root deps
	workspaceManager?: WorkspaceRootManager

	// callbacks for single-root TaskCheckpointManager
	updateTaskHistory: (historyItem: any) => Promise<any[]>
	say: (...args: any[]) => Promise<number | undefined>
	cancelTask: () => Promise<void>
	restoreChatRuntime: (input: { apiIndex: number; editedText?: string }) => Promise<void>
	postStateToWebview: () => Promise<void>

	// initial state for single-root
	initialConversationHistoryDeletedRange?: [number, number]
	initialCheckpointManagerErrorMessage?: string

	stateManager: StateManager
}

/**
 * Build the single checkpoint owner. TaskCheckpointManager delegates file
 * operations to a root coordinator when multiple workspace roots are present.
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
		updateTaskHistory,
		say,
		cancelTask,
		restoreChatRuntime,
		postStateToWebview,
		initialConversationHistoryDeletedRange,
		initialCheckpointManagerErrorMessage,
		stateManager,
	} = args

	const enableCheckpoints = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")

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
		},
		{
			updateTaskHistory,
			say,
			cancelTask,
			restoreChatRuntime,
			postStateToWebview,
		},
		{
			conversationHistoryDeletedRange: initialConversationHistoryDeletedRange,
			checkpointManagerErrorMessage: initialCheckpointManagerErrorMessage,
		},
	)
}
