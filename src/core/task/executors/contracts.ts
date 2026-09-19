import type { HaltStopCommand, ParticipantId, TaskEvent } from "../kernel"

export type TaskEventSubmission = { readonly kind: "accepted" } | { readonly kind: "rejected" }

export interface TaskEventSink {
	submit(event: TaskEvent): Promise<TaskEventSubmission>
}

export interface HaltOrder {
	readonly haltId: string
	readonly generation: number
	readonly reason: HaltStopCommand["reason"]
}

export interface HaltParticipant {
	readonly id: ParticipantId
	/** Establish an admission and callback fence synchronously, before any stop awaits. */
	fence(order: HaltOrder): void
	/** Request cancellation or resource shutdown. */
	stop(order: HaltOrder): void | Promise<void>
	/** Resolve only after participant-owned work and callbacks can no longer publish. */
	drain(order: HaltOrder): Promise<void>
	/** Retire only the named halt generation; older re-arms cannot clear a newer fence. */
	rearm?(haltId: string): void
}

export function isExecutionAbort(_error: unknown, signal: AbortSignal): boolean {
	return signal.aborted
}

export function executorFailure(domain: string, error: unknown): string {
	const candidate = error instanceof Error ? error.name : "unknown"
	const safeKind = /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : "unknown"
	return `${domain} execution failed (${safeKind})`
}
