import type { CompactionConversationPort } from "../compaction/JournalCompactionConversation"
import type { ToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
import type { TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { Task } from "../shell/Task"
import type { TaskExecutorAssembly } from "../shell/TaskExecutorAssembly"
import type { TaskPayloadStore } from "../stores"
import type { CanonicalTaskViewProjection } from "../view/canonical/CanonicalTaskViewProjection"
import { projectCanonicalTaskView } from "../view/canonical/projectCanonicalTaskView"
import { releaseSessionResources, type SessionResourceReleasePort } from "./SessionResourceScope"
import type { TaskInputMaterializer } from "./TaskInputMaterializer"
import type { TaskSessionOwners } from "./TaskSessionOwners"

export type ActiveTaskSessionReleasePort = SessionResourceReleasePort

export interface ActiveTaskSessionOptions {
	readonly task: Task
	readonly readState: () => Readonly<TaskState>
	readonly assembly: TaskExecutorAssembly
	readonly payloads: TaskPayloadStore
	readonly inputs: TaskInputMaterializer
	readonly owners: TaskSessionOwners
	/** Where an approval response records the feedback its tool block must carry. */
	readonly approvalFeedback: ToolApprovalFeedbackLedger
	/** The conversation a compaction reads: exactly what the provider is sent. */
	readonly conversation: CompactionConversationPort
	readonly releases?: readonly ActiveTaskSessionReleasePort[]
}

/** Owns one task incarnation without expanding the six-use-case Task facade. */
export class ActiveTaskSession {
	readonly taskId: string
	readonly task: Task
	readonly assembly: TaskExecutorAssembly
	readonly payloads: TaskPayloadStore
	readonly inputs: TaskInputMaterializer
	readonly messages: MessageStateHandler
	readonly owners: TaskSessionOwners
	readonly approvalFeedback: ToolApprovalFeedbackLedger
	readonly conversation: CompactionConversationPort
	private disposePromise: Promise<void> | undefined

	constructor(private readonly options: ActiveTaskSessionOptions) {
		this.task = options.task
		this.taskId = options.task.taskId
		this.assembly = options.assembly
		this.payloads = options.payloads
		this.inputs = options.inputs
		this.owners = options.owners
		this.messages = options.owners.messages
		this.approvalFeedback = options.approvalFeedback
		this.conversation = options.conversation
	}

	state(): Readonly<TaskState> {
		return this.options.readState()
	}

	projectView(): CanonicalTaskViewProjection {
		return projectCanonicalTaskView(this.state())
	}

	dispose(haltId: string): Promise<void> {
		this.disposePromise ??= this.disposeOwnedResources(haltId)
		return this.disposePromise
	}

	private async disposeOwnedResources(haltId: string): Promise<void> {
		await this.task.terminate(haltId)
		await releaseSessionResources(this.options.releases ?? [])
	}
}
