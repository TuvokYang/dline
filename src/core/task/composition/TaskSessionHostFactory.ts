import type { ConversationRewindPort, ICheckpointManager } from "@integrations/checkpoints/types"
import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import type { ITerminalManager } from "@integrations/terminal/types"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { TaskActivityStore } from "../activity/TaskActivityStore"
import type { PeerTaskSpawnPort } from "../executors/spawn/PeerTaskSpawnPort"
import type { ToolDomainSurface } from "../executors/tool/ToolDomainSurface"
import type { FocusChainInstructionPort } from "../focus-chain"
import type { TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { ApiRateSnapshot } from "../performance/api-rate-tracker"
import type { ProviderRequestRoundPort } from "../performance/provider-request-round-port"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "../performance/task-rate-metrics-types"
import type { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import type { PromptCacheHealthTracker } from "../prompt-cache/PromptCacheHealthTracker"
import type { CheckpointRestoreFence } from "../session/ActiveTaskSession"
import type { PresentationIdSequence } from "../session/PresentationIdSequence"
import type { TaskApiHandlerOwner } from "../session/TaskApiHandlerOwner"
import type { TaskInteractionOwner } from "../session/TaskInteractionOwner"
import type { CheckpointRestoreMode, CheckpointRestoreResult, WorkspaceRestoreResult } from "../shell/checkpoint-restore"
import type { TaskStateManager } from "../TaskStateManager"
import type { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import type { TaskCallbacks, TaskServices } from "../tools/types/TaskConfig"

export interface TaskSessionCheckpointPort {
    capture(input: {
        readonly messageTs: number
        readonly workspaceRef?: string
        /** The conversation position the row recorded; the current task state is stored with it. */
        readonly boundary?: { readonly seq: number }
        /** A pre-edit row restores the conversation of this round row. */
        readonly anchorTs?: number
    }): Promise<void>
    /** Whether anything other than a checkpoint marker was journaled after `seq`. */
    advancedSince(seq: number): Promise<boolean>
    restore(input: {
        readonly messageTs: number
        readonly mode: CheckpointRestoreMode
        /** Restore to this journal position instead of a checkpoint captured at `messageTs`. */
        readonly journalTarget?: { readonly seq: number }
        /** The row's own position and files, used when no checkpoint was captured for it. */
        readonly fallback?: { readonly journalTarget: { readonly seq: number }; readonly workspaceRef?: string }
        readonly restoreWorkspace: (workspaceRef: string) => Promise<WorkspaceRestoreResult>
    }): Promise<{ readonly result: CheckpointRestoreResult; readonly fence?: CheckpointRestoreFence }>
}

export interface TaskSessionHostContext {
    readonly taskId: string
    readonly taskIncarnationId: string
    readonly cwd: string
    readonly settings: TaskStateManager
    readonly messages: MessageStateHandler
    readonly activities: TaskActivityStore
    readonly api: TaskApiHandlerOwner
    readonly prompt: TaskPromptLifecycle
    readonly promptCache: PromptCacheHealthTracker
    readonly toolState: DefaultToolHandlerState
    readonly interactions: TaskInteractionOwner
    /** The session's chat-row id sequence; a row the host adds draws from it so it cannot land on another row's id. */
    readonly nextPresentationId: PresentationIdSequence
    readonly readState: () => Readonly<TaskState>
    readonly checkpoints: TaskSessionCheckpointPort
    /** Rewinds this task's journal conversation, for a restore from a summary card. */
    readonly conversationRewind?: ConversationRewindPort
}

export interface TaskSessionHostResources {
    readonly services: TaskServices
    readonly callbacks: TaskCallbacks
    readonly focusChain?: FocusChainInstructionPort
    readonly browser: BrowserSession
    readonly commands: CommandExecutor
    /** Terminal registry behind `commands`; the environment lists its active terminals. */
    readonly terminals?: ITerminalManager
    readonly checkpoints?: ICheckpointManager
    readonly surface: ToolDomainSurface
    readonly peerTaskSpawner: PeerTaskSpawnPort
    readonly providerRequestRounds?: ProviderRequestRoundPort
    readonly apiRateSnapshot?: () => ApiRateSnapshot
    readonly queryRateMetrics?: (query: TaskRateMetricsQuery) => Promise<TaskRateMetricsQueryResult>
    readonly releases?: readonly { release(): Promise<void> }[]
}

/** Builds host-owned resources only after canonical task owners exist. */
export interface TaskSessionHostFactory {
    create(context: TaskSessionHostContext): Promise<TaskSessionHostResources>
}
