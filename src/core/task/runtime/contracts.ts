import type { Command, Diagnostic, TaskEvent, TaskState, TransitionResult } from "../kernel"

export interface CommitReceipt {
	readonly revision: number
	readonly durable: Promise<void>
}

export type ExecutorDomain = "provider" | "tool" | "dialog" | "compose" | "compaction" | "policy" | "halt"

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

/**
 * A refusal decided by the runtime before the kernel sees the event.
 *
 * `read_only`: this window does not own the task, so committing the event would
 * write the stores the owning window is writing.
 */
export interface RuntimeRejection {
	readonly kind: "rejected"
	readonly state: TaskState
	readonly reason: "read_only"
	readonly diagnostic: Diagnostic
}

export type EventSubmissionResult =
	| {
			readonly kind: "accepted"
			readonly state: TaskState
			readonly commands: readonly Command[]
			readonly receipt: CommitReceipt
	  }
	| Extract<TransitionResult, { kind: "rejected" }>
	| RuntimeRejection

export interface RuntimeFacade {
	getState(): Readonly<TaskState>
	submit(event: TaskEvent): Promise<EventSubmissionResult>
	projectTransient(projection: Readonly<Record<string, unknown>>): void
	waitForDurable(revision: number): Promise<void>
	waitForDomainCompletion(revision: number): Promise<void>
	waitForQuiescence(): Promise<void>
	/** Make this runtime the task's writer, so it admits events. Idempotent. */
	grantWriteOwnership(): void
	/** Whether events are admitted; false until a read-only runtime is granted ownership. */
	isWritable(): boolean
	/**
	 * Dispatch recovered commands held at construction. A no-op when nothing is
	 * held or the runtime is still read-only, since dispatching writes the task.
	 */
	releaseRestoredCommands(): void
}
