import type {
	TaskCollaborationLease,
	TaskCollaborationRegistrationInput,
	TaskCollaborationRuntime,
} from "../collaboration/TaskCollaborationRuntime"
import type { TaskState } from "../kernel"

export interface TaskCollaborationSessionOwnerOptions extends TaskCollaborationRegistrationInput {
	readonly runtime: TaskCollaborationRuntime
}

/** Owns one writable session's process-local directory route. */
export class TaskCollaborationSessionOwner {
	private lease: TaskCollaborationLease | undefined
	private closing = false

	constructor(private readonly options: TaskCollaborationSessionOwnerOptions) {}

	activate(): void {
		if (this.lease) return
		this.lease = this.options.runtime.register(this.options)
		if (this.closing) this.lease.beginClose()
	}

	committed(state: Readonly<TaskState>): void {
		this.lease?.publishCommitted(state)
	}

	beginClose(): void {
		this.closing = true
		this.lease?.beginClose()
	}

	async release(): Promise<void> {
		this.beginClose()
		const lease = this.lease
		this.lease = undefined
		await lease?.release()
	}
}
