import type { Command, TaskEvent, TaskState, TransitionResult } from "../kernel"

export interface CommitReceipt {
	readonly revision: number
	readonly durable: Promise<void>
}

export type ExecutorDomain = "provider" | "tool" | "dialog" | "compose" | "compaction" | "policy" | "halt" | "spawn"

export interface CommandExecutor {
	readonly domain: ExecutorDomain
	execute(command: Command): Promise<void>
}

/**
 * Whether an entry reports something that went wrong.
 *
 * An observation describes a decision the runtime made normally. Reporting one
 * at failure severity makes healthy runs look broken, so the distinction
 * belongs to the entry rather than to whichever sink consumes it.
 */
export type RuntimeDiagnosticSeverity = "failure" | "observation"

export interface RuntimeDiagnostic {
	/**
	 * `hydrate` reports what recovery decided before any event is submitted,
	 * and `dialog` reports an answer that reached no receiver and no
	 * continuation; the other sources report failures that occur behind the
	 * event loop.
	 */
	readonly source: "commit" | "router" | "outbox" | "hydrate" | "dialog"
	readonly code: string
	readonly message: string
	/** Defaults to `failure`, which is what every reported fault is. */
	readonly severity?: RuntimeDiagnosticSeverity
	readonly revision?: number
	readonly commandId?: string
}

export interface RuntimeDiagnosticSink {
	record(diagnostic: RuntimeDiagnostic): void
}

export interface CommandDispatch {
	readonly command: Command
	readonly domain: ExecutorDomain
	readonly completion: Promise<void>
}

export type EventSubmissionResult =
	| {
			readonly kind: "accepted"
			readonly state: TaskState
			readonly commands: readonly Command[]
			readonly receipt: CommitReceipt
	  }
	| Extract<TransitionResult, { kind: "rejected" }>

export interface RuntimeFacade {
	getState(): Readonly<TaskState>
	submit(event: TaskEvent): Promise<EventSubmissionResult>
	projectTransient(projection: Readonly<Record<string, unknown>>): void
	waitForDurable(revision: number): Promise<void>
	waitForDomainCompletion(revision: number): Promise<void>
	waitForQuiescence(): Promise<void>
	/** Dispatch recovered commands held at construction; a no-op when nothing is held. */
	releaseRestoredCommands(): void
}
