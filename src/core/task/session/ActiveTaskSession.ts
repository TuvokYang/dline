import type { CompactionConversationPort, ContextTruncationPort } from "../compaction/JournalCompactionConversation"
import type { ToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
import type { DraftAttachmentPort } from "../interaction/DraftAttachments"
import type { TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { Task } from "../shell/Task"
import type { TaskExecutorAssembly } from "../shell/TaskExecutorAssembly"
import type { TaskCheckpointRestoreSuspensionPort } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import type { CanonicalTaskViewProjection } from "../view/canonical/CanonicalTaskViewProjection"
import { projectCanonicalTaskView } from "../view/canonical/projectCanonicalTaskView"
import type { InputQueueApplicationPort } from "./InputQueueApplicationPort"
import { releaseSessionResources, type SessionResourceReleasePort } from "./SessionResourceScope"
import type { TaskBackgroundIngressOwner } from "./TaskBackgroundIngressOwner"
import type { TaskCollaborationSessionOwner } from "./TaskCollaborationSessionOwner"
import type { TaskInputMaterializer } from "./TaskInputMaterializer"
import type { TaskSessionOwners } from "./TaskSessionOwners"

export type ActiveTaskSessionReleasePort = SessionResourceReleasePort

const checkpointRestoreFenceOwner = Symbol("checkpointRestoreFenceOwner")

/** Capability proving this exact task incarnation is quiescent and remains fenced. */
export interface CheckpointRestoreFence {
    readonly taskId: string
    readonly taskIncarnationId: string
    readonly haltId: string
    readonly [checkpointRestoreFenceOwner]: ActiveTaskSession
}

export interface ActiveTaskSessionOptions {
    readonly task: Task
    readonly checkpointRestore: TaskCheckpointRestoreSuspensionPort
    readonly readState: () => Readonly<TaskState>
    /** Whether this window owns the task; see {@link ActiveTaskSession.writable}. */
    readonly isWritable?: () => boolean
    readonly assembly: TaskExecutorAssembly
    readonly payloads: TaskPayloadStore
    readonly inputs: TaskInputMaterializer
    readonly inputQueue: InputQueueApplicationPort
    /** Resolves a draft's persisted resource parts when a receiver that reads flat attachments consumes it. */
    readonly draftAttachments?: DraftAttachmentPort
    readonly owners: TaskSessionOwners
    /** Where an approval response records the feedback its tool block must carry. */
    readonly approvalFeedback: ToolApprovalFeedbackLedger
    /** The conversation a compaction reads: exactly what the provider is sent. */
    readonly conversation: CompactionConversationPort
    /** Shrinks that conversation when the provider refuses a request as longer than its window. */
    readonly contextTruncation?: ContextTruncationPort
    readonly releases?: readonly ActiveTaskSessionReleasePort[]
    readonly upgradeImportPending?: boolean
}

/** Owns one task incarnation without expanding the six-use-case Task facade. */
export class ActiveTaskSession {
    readonly taskId: string
    readonly task: Task
    readonly assembly: TaskExecutorAssembly
    readonly payloads: TaskPayloadStore
    readonly inputs: TaskInputMaterializer
    readonly inputQueue: InputQueueApplicationPort
    readonly draftAttachments: DraftAttachmentPort | undefined
    readonly messages: MessageStateHandler
    readonly owners: TaskSessionOwners
    readonly approvalFeedback: ToolApprovalFeedbackLedger
    readonly conversation: CompactionConversationPort
    readonly contextTruncation: ContextTruncationPort | undefined
    /**
     * Opened without the task lock while data from an earlier version still
     * waited to be migrated.
     *
     * Such a session hydrated without that history and may not write it, so
     * opening it in place once the window owns the task would lose the history
     * for good. The owner reopens it instead, which runs the migration first.
     */
    readonly upgradeImportPending: boolean
    private disposePromise: Promise<void> | undefined
    private disposeMode: "ordinary" | "checkpoint_restore" | undefined
    private checkpointRestoreFencePromise: Promise<CheckpointRestoreFence> | undefined
    private checkpointRestoreFence: CheckpointRestoreFence | undefined
    private collaboration: TaskCollaborationSessionOwner | undefined
    private backgroundIngress: TaskBackgroundIngressOwner | undefined

    constructor(private readonly options: ActiveTaskSessionOptions) {
        this.task = options.task
        this.taskId = options.task.taskId
        this.assembly = options.assembly
        this.payloads = options.payloads
        this.inputs = options.inputs
        this.inputQueue = options.inputQueue
        this.draftAttachments = options.draftAttachments
        this.owners = options.owners
        this.messages = options.owners.messages
        this.approvalFeedback = options.approvalFeedback
        this.conversation = options.conversation
        this.contextTruncation = options.contextTruncation
        this.upgradeImportPending = options.upgradeImportPending === true
    }

    /**
     * The opening the Webview echoes as `task_instance_id`.
     *
     * Every opening composes a new incarnation, so a request from a surface that
     * opened an earlier incarnation of the same task is recognised as stale.
     */
    get taskInstanceId(): string {
        return this.owners.identity.taskIncarnationId
    }

    /**
     * Whether this window may write the task.
     *
     * False while another window owns the task lock, until this window takes the
     * task over and opens it. The runtime refuses every event meanwhile; callers
     * that write payloads or other stores before submitting check this first, so
     * a refused request leaves nothing behind.
     */
    get writable(): boolean {
        return this.options.isWritable?.() ?? true
    }

    state(): Readonly<TaskState> {
        return this.options.readState()
    }

    projectView(): CanonicalTaskViewProjection {
        return projectCanonicalTaskView(this.state())
    }

    bindCollaboration(owner: TaskCollaborationSessionOwner): void {
        if (this.collaboration) throw new Error("TaskCollaborationAlreadyBound")
        this.collaboration = owner
    }

    activateCollaboration(): void {
        this.collaboration?.activate()
    }

    bindBackgroundIngress(owner: TaskBackgroundIngressOwner): void {
        if (this.backgroundIngress) throw new Error("TaskBackgroundIngressAlreadyBound")
        this.backgroundIngress = owner
    }

    activateBackgroundIngress(): Promise<void> {
        return this.backgroundIngress?.activate() ?? Promise.resolve()
    }

    beginClose(): void {
        this.collaboration?.beginClose()
    }

    stopForCheckpointRestore(haltId: string): Promise<CheckpointRestoreFence> {
        if (this.disposeMode) return Promise.reject(new Error("TaskSessionAlreadyDisposing"))
        this.checkpointRestoreFencePromise ??= this.stopAndFenceForCheckpointRestore(haltId)
        return this.checkpointRestoreFencePromise
    }

    dispose(haltId: string): Promise<void> {
        if (this.disposeMode === "checkpoint_restore") return Promise.reject(new Error("TaskSessionCheckpointRestoreDisposal"))
        this.disposeMode ??= "ordinary"
        this.disposePromise ??= this.disposeOwnedResources(haltId)
        return this.disposePromise
    }

    disposeAfterCheckpointRestore(fence: CheckpointRestoreFence): Promise<void> {
        if (fence !== this.checkpointRestoreFence || fence[checkpointRestoreFenceOwner] !== this) {
            return Promise.reject(new Error("InvalidCheckpointRestoreFence"))
        }
        if (this.disposeMode === "ordinary") return Promise.reject(new Error("TaskSessionAlreadyDisposing"))
        this.disposeMode ??= "checkpoint_restore"
        this.disposePromise ??= releaseSessionResources(this.options.releases ?? [])
        return this.disposePromise
    }

    private async stopAndFenceForCheckpointRestore(haltId: string): Promise<CheckpointRestoreFence> {
        this.beginClose()
        const result = await this.options.checkpointRestore.stopAndFence(haltId)
        if (result.kind === "rejected") throw new Error(`CheckpointRestoreStopRejected:${result.diagnostic.code}`)
        const fence: CheckpointRestoreFence = {
            taskId: this.taskId,
            taskIncarnationId: this.owners.identity.taskIncarnationId,
            haltId,
            [checkpointRestoreFenceOwner]: this,
        }
        this.checkpointRestoreFence = fence
        return fence
    }

    private async disposeOwnedResources(haltId: string): Promise<void> {
        this.beginClose()
        // A session that never owned the task has nothing of its own to stop or keep,
        // and writing here would land in the stores the owning window is writing.
        if (this.writable) {
            await this.task.terminate(haltId)
            // Written before the stores close, so the completion a terminate kept is answerable on reopen.
            await this.owners.interactions.anchorStagedCompletion()
        }
        await releaseSessionResources(this.options.releases ?? [])
    }
}
