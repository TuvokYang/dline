import type { TaskEvent, TaskState } from "../kernel"
import type { CommandPublicationStore, DurableTaskSnapshot, StateVault, TaskViewPort } from "../stores/contracts"
import { CommandRouter } from "./CommandRouter"
import { CommitPipeline } from "./CommitPipeline"
import type { CommandExecutor, EventSubmissionResult, RuntimeDiagnosticSink, RuntimeFacade, RuntimeRejection } from "./contracts"
import { DurableCommandOutbox } from "./DurableCommandOutbox"
import { EventLoop } from "./EventLoop"

export interface TaskRuntimeOptions {
	readonly initialState: TaskState
	readonly vault: StateVault
	readonly taskView: TaskViewPort
	readonly publications: CommandPublicationStore
	readonly executors: readonly CommandExecutor[]
	readonly diagnostics?: RuntimeDiagnosticSink
	readonly restoredOutbox?: DurableTaskSnapshot["outbox"]
	/**
	 * Open read-only until `grantWriteOwnership()`: hold restored commands and refuse every
	 * event. A window that opens a task without owning its lock must neither dispatch
	 * recovered work nor commit events, because both write the task databases the lock
	 * owner is writing, and any entry it journals would also cancel the pending import of
	 * the conversation an earlier version left behind.
	 */
	readonly deferRestoredCommands?: boolean
}

interface HeldRestoredCommands {
	readonly commands: NonNullable<TaskRuntimeOptions["restoredOutbox"]>
	readonly generation: number
}

export class TaskRuntime implements RuntimeFacade {
	private readonly router: CommandRouter
	private readonly commits: CommitPipeline
	private readonly outbox: DurableCommandOutbox
	private readonly events: EventLoop
	private readonly taskView: TaskViewPort
	private held?: HeldRestoredCommands
	private writable: boolean

	constructor(options: TaskRuntimeOptions) {
		this.taskView = options.taskView
		this.router = new CommandRouter(options.executors, options.diagnostics)
		this.commits = new CommitPipeline(options.vault, options.taskView, options.diagnostics)
		this.outbox = new DurableCommandOutbox(this.router, options.publications, options.diagnostics)
		this.events = new EventLoop(options.initialState, this.commits, this.outbox)
		this.writable = options.deferRestoredCommands !== true
		if (options.restoredOutbox) {
			this.held = { commands: options.restoredOutbox, generation: options.initialState.generation }
			this.releaseRestoredCommands()
		}
	}

	grantWriteOwnership(): void {
		this.writable = true
	}

	releaseRestoredCommands(): void {
		const held = this.held
		if (!held || !this.writable) return
		this.held = undefined
		this.outbox.restore(held.commands, held.generation)
	}

	isWritable(): boolean {
		return this.writable
	}

	getState(): Readonly<TaskState> {
		return this.events.getState()
	}

	submit(event: TaskEvent): Promise<EventSubmissionResult> {
		if (!this.writable) return Promise.resolve(readOnlyRejection(this.getState(), event))
		return this.events.submit(event)
	}

	projectTransient(projection: Readonly<Record<string, unknown>>): void {
		this.taskView.notifyTransient(this.getState().taskId, projection)
	}

	waitForDurable(revision: number): Promise<void> {
		return this.commits.flushThrough(revision)
	}

	async waitForDomainCompletion(revision: number): Promise<void> {
		await this.commits.flushThrough(revision)
		await this.outbox.whenAdmitted(revision)
		await this.router.waitForRevision(revision)
	}

	async waitForQuiescence(): Promise<void> {
		await this.commits.flushAll()
		await this.outbox.whenIdle()
		await this.router.waitForQuiescence()
	}
}

function readOnlyRejection(state: TaskState, event: TaskEvent): RuntimeRejection {
	return {
		kind: "rejected",
		state,
		reason: "read_only",
		diagnostic: {
			code: "task_read_only",
			message: `Refused ${event.type}: another window owns task ${state.taskId}`,
		},
	}
}
