import {
	emitSignal,
	isSignalRecordingEnabled,
	type ObservabilityAttributes,
	recordDurationHistogram,
	runWithSignalSpan,
	type SignalSpanHandle,
	startSignalSpan,
} from "@/services/telemetry/service/pipeline-port"
import { type TaskTraceSource, taskTraceSource } from "@/services/telemetry/service/task-trace-context"
import { Logger } from "@/shared/services/Logger"
import type { ApiProviderStreamChunk, ApiStream } from "../transform/stream"
import { ApiRequestProgress } from "./api-request-snapshot"

type RequestOutcome = "completed" | "failed" | "cancelled"

/** Observes one adapter invocation, not a logical request or each SDK retry. */
export class ApiRequestObservation {
	private readonly startedAt = performance.now()
	private readonly progress = new ApiRequestProgress(this.startedAt)
	private span: SignalSpanHandle | undefined
	private terminal = false
	private abortRequested = false
	private task: TaskTraceSource | undefined
	private parent: SignalSpanHandle | undefined
	private receivedChunk = false

	constructor(
		private readonly metadata: ObservabilityAttributes,
		private readonly taskId: string | undefined,
		private readonly onTerminal: () => void,
	) {
		this.safely(() => {
			this.task = taskTraceSource(taskId)
			this.task?.event("task.api.started", metadata)
			this.parent = this.task?.currentSpan()
			const attributes = { ...metadata, ...this.taskAttributes() }
			this.span = startSignalSpan({
				name: "api.request",
				parent: this.parent,
				attributes: { ...attributes, ...(taskId ? { task_id: taskId } : {}) },
			})
			this.span.addEvent?.("api.request.started", attributes)
			this.run(() => emitSignal({ name: "api.request.started", level: "info", attributes }))
		})
	}

	/** Bind every lazy iterator operation; setting a scope around generator creation is insufficient. */
	wrap(send: () => ApiStream): ApiStream {
		let source: ApiStream | undefined
		let closing = false
		const invoke = (
			action: (iterator: ApiStream) => Promise<IteratorResult<ApiProviderStreamChunk>>,
		): Promise<IteratorResult<ApiProviderStreamChunk>> =>
			this.run(async () => {
				try {
					source ??= send()
					const result = await action(source)
					if (result.done) this.finish(this.abortRequested || closing ? "cancelled" : "completed")
					else
						this.safely(() => {
							this.progress.observe(result.value, performance.now())
							if (!this.receivedChunk) {
								this.receivedChunk = true
								this.span?.addEvent?.("api.first_chunk", this.progress.attributes(performance.now()))
							}
							if (result.value.type === "usage")
								this.span?.addEvent?.("api.usage.received", this.progress.attributes(performance.now()))
						})
					return result
				} catch (error: unknown) {
					this.finish(this.abortRequested || isAbortError(error) ? "cancelled" : "failed", error)
					throw error
				}
			})
		return {
			next: (...args: [] | [unknown]) => invoke((iterator) => iterator.next(...args)),
			return: (value: unknown) => {
				closing = true
				return invoke((iterator) => iterator.return(value))
			},
			throw: (error: unknown) => invoke((iterator) => iterator.throw(error)),
			async [Symbol.asyncDispose]() {
				closing = true
				await invoke((iterator) => iterator.return(undefined))
			},
			[Symbol.asyncIterator]() {
				return this
			},
		}
	}

	cancel(): void {
		this.abortRequested = true
		this.finish("cancelled")
	}

	private finish(outcome: RequestOutcome, error?: unknown): void {
		if (this.terminal) return
		this.terminal = true
		this.onTerminal()
		const duration = Math.max(0, performance.now() - this.startedAt)
		this.safely(() => {
			if (!isSignalRecordingEnabled()) return
			const attributes = {
				...this.metadata,
				...this.taskAttributes(),
				...this.progress.attributes(performance.now()),
				outcome,
			}
			this.run(() => {
				if (outcome === "failed") this.safely(() => this.span?.recordException(error))
				for (const [key, value] of Object.entries(attributes)) this.safely(() => this.span?.setAttribute(key, value))
				this.span?.addEvent?.(`api.request.${outcome}`, attributes)
				emitSignal({
					name: `api.request.${outcome}`,
					level: outcome === "failed" ? "error" : "info",
					attributes,
					...(outcome === "failed" ? { error } : {}),
					...(this.taskId ? { context: { taskId: this.taskId } } : {}),
				})
			})
		})
		this.safely(() => {
			if (!isSignalRecordingEnabled()) return
			recordDurationHistogram(duration, {
				operation: "api.request",
				provider: this.metadata.provider,
				model: this.metadata.model,
				api_format: this.metadata.api_format,
				outcome,
			})
		})
		this.safely(() => this.span?.end(outcome === "completed" ? "success" : outcome === "failed" ? "failure" : "cancelled"))
		this.safely(() => {
			const fields = { ...this.metadata, ...this.progress.attributes(performance.now()), outcome }
			if (outcome === "failed") this.task?.failure(error, fields, this.parent)
			else this.task?.event(`task.api.${outcome}`, fields)
		})
	}

	private taskAttributes(): ObservabilityAttributes {
		try {
			return this.task?.attributes() ?? { task_state_available: false, task_usage_available: false }
		} catch {
			return { task_state_available: false, task_usage_available: false }
		}
	}

	private run<T>(action: () => T): T {
		return this.span ? runWithSignalSpan(this.span, action) : action()
	}

	private safely(action: () => void): void {
		try {
			action()
		} catch {
			// Never let diagnostics replace the provider's result or leak its thrown value.
			Logger.debug("[ApiRequestObservation] Unable to record request diagnostics")
		}
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError")
}
