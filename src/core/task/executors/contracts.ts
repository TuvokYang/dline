import type { TaskEvent } from "../kernel"

export type TaskEventSubmission = { readonly kind: "accepted" } | { readonly kind: "rejected" }

export interface TaskEventSink {
	submit(event: TaskEvent): Promise<TaskEventSubmission>
}

export function isExecutionAbort(_error: unknown, signal: AbortSignal): boolean {
	return signal.aborted
}

export function executorFailure(domain: string, error: unknown): string {
	const candidate = error instanceof Error ? error.name : "unknown"
	const safeKind = /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : "unknown"
	return `${domain} execution failed (${safeKind})`
}
