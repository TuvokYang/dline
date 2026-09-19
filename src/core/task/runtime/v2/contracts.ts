import type { Command, TaskEvent, TaskState, TransitionResult } from "../../kernel"

export interface CommitReceipt {
	readonly revision: number
	readonly durable: Promise<void>
}

export type ExecutorDomain = "provider" | "tool" | "dialog" | "compose" | "compaction" | "policy" | "halt" | "spawn"

export interface CommandExecutor {
	readonly domain: ExecutorDomain
	execute(command: Command): Promise<void>
}

export interface RuntimeDiagnostic {
	readonly source: "commit" | "router" | "outbox"
	readonly code: string
	readonly message: string
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
}
