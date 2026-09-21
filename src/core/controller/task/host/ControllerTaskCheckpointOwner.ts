import type { ContextManager } from "@core/context/context-management/ContextManager"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { Controller } from "@core/controller"
import type { StateManager } from "@core/storage/StateManager"
import type { MessageStateHandler } from "@core/task/message-state"
import type { DefaultToolHandlerState } from "@core/task/tools/state/ToolHandlerState"
import type { TaskCallbacks } from "@core/task/tools/types/TaskConfig"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { buildCheckpointManager } from "@integrations/checkpoints/factory"
import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { Logger } from "@shared/services/Logger"

export interface ControllerTaskCheckpointOwnerOptions {
	readonly controller: Controller
	readonly taskId: string
	readonly stateManager: StateManager
	readonly messages: MessageStateHandler
	readonly toolState: DefaultToolHandlerState
	readonly contextManager: ContextManager
	readonly fileContextTracker: FileContextTracker
	readonly taskFileTracker: TaskFileTracker
	readonly diffViewProvider: DiffViewProvider
	readonly say: TaskCallbacks["say"]
	readonly workspaceManager?: WorkspaceRootManager
}

/**
 * Owns the checkpoint manager for one task incarnation and the canonical
 * continuation that follows a chat rewind.
 *
 * A chat restore rewinds durable conversation state behind the running task, so
 * the surviving control state no longer describes the stored conversation.
 * Rather than patching the live aggregate, this owner reopens the task through
 * the ordinary hydrate path, which is the single control-state entry point for
 * resume, crash recovery and checkpoint restore.
 */
export class ControllerTaskCheckpointOwner {
	readonly manager: ICheckpointManager

	constructor(private readonly options: ControllerTaskCheckpointOwnerOptions) {
		this.manager = buildCheckpointManager({
			taskId: options.taskId,
			controller: options.controller,
			messageStateHandler: options.messages,
			fileContextTracker: options.fileContextTracker,
			contextManager: options.contextManager,
			diffViewProvider: options.diffViewProvider,
			taskState: options.toolState,
			taskFileTracker: options.taskFileTracker,
			workspaceManager: options.workspaceManager,
			updateTaskHistory: (historyItem) => options.controller.updateTaskHistory(historyItem),
			say: (...args) => options.say(...(args as Parameters<TaskCallbacks["say"]>)),
			cancelTask: () => options.controller.cancelTask(),
			restoreChatRuntime: (input) => this.reopenAfterChatRestore(input),
			postStateToWebview: () => options.controller.postStateToWebview(),
			initialConversationHistoryDeletedRange: options.toolState.conversationHistoryDeletedRange,
			initialCheckpointManagerErrorMessage: options.toolState.checkpointManagerErrorMessage,
			stateManager: options.stateManager,
		})
	}

	/**
	 * Rebuild control state from the rewound conversation and continue edited input once.
	 *
	 * `apiIndex` identifies the durable boundary the manager just committed; the
	 * reopened task derives its own anchor from that stored conversation, so the
	 * index is retained for diagnostics instead of being replayed as state.
	 */
	private async reopenAfterChatRestore(input: { apiIndex: number; editedText?: string }): Promise<void> {
		Logger.debug(`[Task ${this.options.taskId}] Reopening after checkpoint chat restore at apiIndex=${input.apiIndex}`)
		await this.options.controller.reinitExistingTaskFromId(this.options.taskId)
		const session = this.options.controller.task
		if (!session || session.taskId !== this.options.taskId) {
			throw new Error(`Checkpoint chat restore could not reopen task ${this.options.taskId}`)
		}
		if (input.editedText === undefined) return
		const continuation = await session.inputs.materialize({ text: input.editedText })
		await session.task.submitInput(continuation)
	}
}
