import type { CompactionConversationPort, ContextTruncationPort } from "../compaction/JournalCompactionConversation"
import type { ToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
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
	readonly assembly: TaskExecutorAssembly
	readonly payloads: TaskPayloadStore
	readonly inputs: TaskInputMaterializer
	readonly inputQueue: InputQueueApplicationPort
	readonly owners: TaskSessionOwners
	/** Where an approval response records the feedback its tool block must carry. */
	readonly approvalFeedback: ToolApprovalFeedbackLedger
	/** The conversation a compaction reads: exactly what the provider is sent. */
	readonly conversation: CompactionConversationPort
	/** Shrinks that conversation when the provider refuses a request as longer than its window. */
	readonly contextTruncation?: ContextTruncationPort
	readonly releases?: readonly ActiveTaskSessionReleasePort[]
}

/** Owns one task incarnation without expanding the six-use-case Task facade. */
export class ActiveTaskSession {
	readonly taskId: string
	readonly task: Task
	readonly assembly: TaskExecutorAssembly
	readonly payloads: TaskPayloadStore
	readonly inputs: TaskInputMaterializer
	readonly inputQueue: InputQueueApplicationPort
	readonly messages: MessageStateHandler
	readonly owners: TaskSessionOwners
	readonly approvalFeedback: ToolApprovalFeedbackLedger
	readonly conversation: CompactionConversationPort
	readonly contextTruncation: ContextTruncationPort | undefined
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
		this.owners = options.owners
		this.messages = options.owners.messages
		this.approvalFeedback = options.approvalFeedback
		this.conversation = options.conversation
		this.contextTruncation = options.contextTruncation
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
		await this.task.terminate(haltId)
		await releaseSessionResources(this.options.releases ?? [])
	}
}
