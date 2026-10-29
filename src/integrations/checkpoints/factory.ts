import type { ContextManager } from "@core/context/context-management/ContextManager"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { MessageStateHandler } from "@core/task/message-state"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import {
    type BegunCheckpointRow,
    type CheckpointRowFields,
    type CheckpointRuntimeState,
    createTaskCheckpointManager,
    type HeldCheckpointRow,
} from "@integrations/checkpoints"
import { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { CanonicalCheckpointPort, ConversationRewindPort, ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { StateManager } from "@/core/storage/StateManager"

type BuildArgs = {
    taskId: string
    controller: any // Controller reference for event routing
    messageStateHandler: MessageStateHandler
    fileContextTracker: FileContextTracker
    contextManager: ContextManager
    diffViewProvider: DiffViewProvider
    taskState: CheckpointRuntimeState
    taskFileTracker: TaskFileTracker
    /** Present when the workspace has more than one root; drives the root coordinator. */
    workspaceManager?: WorkspaceRootManager
    /** Rewinds the task's journal conversation when a journal-bounded card is restored. */
    conversationRewind?: ConversationRewindPort
    canonicalCheckpoint?: CanonicalCheckpointPort

    updateTaskHistory: (historyItem: any) => Promise<any[]>
    say: (...args: any[]) => Promise<number | undefined>
    /** Register one checkpoint row in presentation order; see CheckpointManagerCallbacks.beginRow. */
    beginRow: (fields: CheckpointRowFields) => BegunCheckpointRow
    /** Show a round's row before its restore point exists; see CheckpointManagerCallbacks.holdRow. */
    holdRow: (fields: CheckpointRowFields) => HeldCheckpointRow
    cancelTask: () => Promise<void>
    restoreChatRuntime: (input: { apiIndex: number; editedText?: string }) => Promise<void>
    postStateToWebview: () => Promise<void>
    publishMessage: (message: UiMessage) => Promise<void>

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
        conversationRewind,
        canonicalCheckpoint,
        updateTaskHistory,
        say,
        beginRow,
        holdRow,
        cancelTask,
        restoreChatRuntime,
        postStateToWebview,
        publishMessage,
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
            conversationRewind,
            canonicalCheckpoint,
        },
        {
            updateTaskHistory,
            say,
            beginRow,
            holdRow,
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
