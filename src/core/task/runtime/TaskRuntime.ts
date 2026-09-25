import type { TaskEvent, TaskState } from "../kernel"
import type { CommandPublicationStore, DurableTaskSnapshot, StateVault, TaskViewPort } from "../stores/contracts"
import { CommandRouter } from "./CommandRouter"
import { CommitPipeline } from "./CommitPipeline"
import type { CommandExecutor, EventSubmissionResult, RuntimeDiagnosticSink, RuntimeFacade } from "./contracts"
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
	 * Hold restored commands until `releaseRestoredCommands()`. A window that opens a task
	 * without owning its lock must not dispatch recovered work, because dispatch writes the
	 * task databases that the lock owner is writing.
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

	constructor(options: TaskRuntimeOptions) {
		this.taskView = options.taskView
		this.router = new CommandRouter(options.executors, options.diagnostics)
		this.commits = new CommitPipeline(options.vault, options.taskView, options.diagnostics)
		this.outbox = new DurableCommandOutbox(this.router, options.publications, options.diagnostics)
		this.events = new EventLoop(options.initialState, this.commits, this.outbox)
		if (options.restoredOutbox) {
			this.held = { commands: options.restoredOutbox, generation: options.initialState.generation }
			if (!options.deferRestoredCommands) this.releaseRestoredCommands()
		}
	}

	releaseRestoredCommands(): void {
		const held = this.held
		if (!held) return
		this.held = undefined
		this.outbox.restore(held.commands, held.generation)
	}

	getState(): Readonly<TaskState> {
		return this.events.getState()
	}

	submit(event: TaskEvent): Promise<EventSubmissionResult> {
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
		await this.outbox.whenPublishedThrough(revision)
		await this.router.waitForRevision(revision)
	}

	async waitForQuiescence(): Promise<void> {
		await this.commits.flushAll()
		await this.outbox.whenIdle()
		await this.router.waitForQuiescence()
	}
}
