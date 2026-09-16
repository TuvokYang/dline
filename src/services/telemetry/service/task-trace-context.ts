import type { ObservabilityAttributes, SignalSpanHandle } from "./pipeline-port"

/** Read-only bridge to a live Task's authoritative state/usage owners, not another state store. */
export interface TaskTraceSource {
	currentSpan(): SignalSpanHandle | undefined
	attributes(): ObservabilityAttributes
	event(name: string, attributes?: ObservabilityAttributes): void
	failure(error: unknown, attributes?: ObservabilityAttributes, expectedSpan?: SignalSpanHandle): void
}

const sources = new Map<string, TaskTraceSource>()

/** Registration lifetime belongs to the Task; cleanup cannot evict a newer owner of the same identity. */
export function registerTaskTraceSource(taskId: string, source: TaskTraceSource): () => void {
	sources.set(taskId, source)
	return () => {
		if (sources.get(taskId) === source) sources.delete(taskId)
	}
}

export function taskTraceSource(taskId: string | undefined): TaskTraceSource | undefined {
	return taskId ? sources.get(taskId) : undefined
}
