import { AsyncLocalStorage } from "node:async_hooks"
import type { SignalSpanHandle } from "./pipeline-port"

// Owned by Dline only; do not replace VS Code's process-global OTel context manager.
const activeSpan = new AsyncLocalStorage<SignalSpanHandle>()

export function currentSignalSpan(): SignalSpanHandle | undefined {
	const span = activeSpan.getStore()
	return span?.active ? span : undefined
}

export function runInSpanScope<T>(span: SignalSpanHandle, action: () => T): T {
	return activeSpan.run(span, action)
}

/** Capture before any queue/await, not inside the later exporter drain. */
export function captureSpanLogProperties(): Record<string, string | number> {
	const span = currentSignalSpan()
	const identity = span?.spanContext
	return {
		...(span?.taskId ? { taskId: span.taskId } : {}),
		...(identity
			? {
					runtime_trace_id: identity.traceId,
					runtime_span_id: identity.spanId,
					runtime_trace_flags: identity.traceFlags,
				}
			: {}),
	}
}
