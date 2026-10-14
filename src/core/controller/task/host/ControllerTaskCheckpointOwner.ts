import type { ContextManager } from "@core/context/context-management/ContextManager"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { Controller } from "@core/controller"
import type { StateManager } from "@core/storage/StateManager"
import type { TaskSessionCheckpointPort } from "@core/task/composition/TaskSessionHostFactory"
import type { MessageStateHandler } from "@core/task/message-state"
import type { CheckpointRestoreFence } from "@core/task/session/ActiveTaskSession"
import type { DefaultToolHandlerState } from "@core/task/tools/state/ToolHandlerState"
import type { TaskCallbacks } from "@core/task/tools/types/TaskConfig"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { BegunCheckpointRow, CheckpointRowFields } from "@integrations/checkpoints"
import { buildCheckpointManager } from "@integrations/checkpoints/factory"
import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { ConversationRewindPort, ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Logger } from "@shared/services/Logger"
import { sendPartialMessageEvent } from "../../ui/subscribeToPartialMessage"

export interface ControllerTaskCheckpointOwnerOptions {
    readonly controller: Controller
    readonly taskId: string
    /** The opening this manager serves; rows it publishes are attributed to it. */
    readonly taskInstanceId: string
    readonly stateManager: StateManager
    readonly messages: MessageStateHandler
    readonly toolState: DefaultToolHandlerState
    readonly contextManager: ContextManager
    readonly fileContextTracker: FileContextTracker
    readonly taskFileTracker: TaskFileTracker
    readonly diffViewProvider: DiffViewProvider
    readonly say: TaskCallbacks["say"]
    /** Registers a checkpoint row in presentation order. */
    readonly beginRow: (fields: CheckpointRowFields) => BegunCheckpointRow
    readonly workspaceManager?: WorkspaceRootManager
    readonly conversationRewind?: ConversationRewindPort
    readonly checkpoints: TaskSessionCheckpointPort
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
    private pendingRestoreFence: CheckpointRestoreFence | undefined

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
            conversationRewind: options.conversationRewind,
            canonicalCheckpoint: {
                capture: (input) => options.checkpoints.capture(input),
                advancedSince: (seq) => options.checkpoints.advancedSince(seq),
                restore: async (input) => {
                    const restored = await options.checkpoints.restore(input)
                    if (restored.result.kind === "restored") {
                        if (!restored.fence) throw new Error("Canonical checkpoint restore completed without a session fence")
                        this.pendingRestoreFence = restored.fence
                    }
                    return restored.result
                },
            },
            updateTaskHistory: (historyItem) => options.controller.updateTaskHistory(historyItem),
            say: (...args) => options.say(...(args as Parameters<TaskCallbacks["say"]>)),
            beginRow: (fields) => options.beginRow(fields),
            cancelTask: () => options.controller.cancelTask(),
            restoreChatRuntime: (input) => this.reopenAfterChatRestore(input),
            postStateToWebview: () => options.controller.postStateToWebview(),
            publishMessage: (message) =>
                sendPartialMessageEvent(options.controller, convertClineMessageToProto(message), {
                    taskId: options.taskId,
                    taskInstanceId: options.taskInstanceId,
                }),
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
        // Reopened as an interactive session that knows it was restored: a history
        // display would leave nothing to resume, and an ordinary resume would plan
        // whatever dialog the rewound conversation last ended in.
        const fence = this.pendingRestoreFence
        if (!fence) throw new Error(`Checkpoint chat restore for ${this.options.taskId} has no canonical session fence`)
        if (input.editedText === undefined) {
            await this.options.controller.reopenTaskForCheckpointRestore(this.options.taskId, fence)
        } else {
            await this.options.controller.reopenTaskForCheckpointRestore(this.options.taskId, fence, input.editedText)
        }
        this.pendingRestoreFence = undefined
    }
}
