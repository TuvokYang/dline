import { normalizeRuntimeError } from "@/services/telemetry/runtime/error-normalizer"
import { exceptionAttributes } from "@/services/telemetry/runtime/exception-attributes"
import {
	emitSignal,
	isSignalRecordingEnabled,
	type ObservabilityAttributes,
	runWithSignalSpan,
	type SignalSpanHandle,
	startSignalSpan,
} from "@/services/telemetry/service/pipeline-port"
import { registerTaskTraceSource, type TaskTraceSource } from "@/services/telemetry/service/task-trace-context"
import type { ApiRateSnapshot } from "../performance/api-rate-tracker"
import type { TaskRuntimeState } from "../runtime/TaskRuntimeState"
import type { TaskSnapshot } from "../TaskSnapshot"

const SEGMENT_EVENT_LIMIT = 96

/** Task-owned observation only: state and usage are read from their existing authorities. */
export class TaskTurnTelemetry implements TaskTraceSource {
	private span: SignalSpanHandle | undefined
	private turnKey: string | undefined
	private segment = 0
	private sequence = 0
	private segmentEvents = 0
	private disposed = false
	private durableRevision: number | undefined
	private durableTimestamp: number | undefined
	private readonly spanTurnKeys = new WeakMap<SignalSpanHandle, string | undefined>()
	private readonly unregister: (() => void)[] = []

	constructor(
		private readonly taskId: string,
		private readonly readState: () => Readonly<TaskRuntimeState>,
		private readonly readUsage: () => ApiRateSnapshot,
	) {
		this.registerAlias(taskId)
	}

	registerAlias(identity: string): void {
		this.unregister.push(registerTaskTraceSource(identity, this))
	}

	currentSpan(): SignalSpanHandle | undefined {
		return this.span?.active ? this.span : undefined
	}

	attributes(): ObservabilityAttributes {
		const state = this.readState()
		const result: Record<string, string | number | boolean> = {
			task_state_available: true,
			task_phase: state.phase,
			task_revision: state.revision,
			task_api_index: state.anchor.apiIndex,
			task_turn_available: Boolean(state.turn?.turnId ?? state.anchor.turnId),
			task_turn_segment: this.segment,
			task_block_count: state.turn?.blocks.length ?? 0,
			task_interaction_kind: state.interaction?.kind ?? "none",
			task_interaction_status: state.interaction?.status ?? "none",
			task_cancellation_source: state.cancellation?.source ?? "none",
			task_effect_error: state.error?.effectType ?? "none",
			task_snapshot_durable_available: this.durableRevision !== undefined,
			task_usage_available: false,
		}
		if (this.durableRevision !== undefined) result.task_snapshot_durable_revision = this.durableRevision
		if (this.durableTimestamp !== undefined) result.task_snapshot_durable_timestamp = this.durableTimestamp
		try {
			const usage = this.readUsage()
			result.task_usage_available = usage.totalTokensIn !== undefined
			for (const key of [
				"totalTokensIn",
				"totalTokensOut",
				"totalCacheWrites",
				"totalCacheReads",
				"totalCost",
				"providerRoundCount",
				"executionCount",
				"tokensPerMinute",
				"requestsPerMinute",
			] as const) {
				const value = usage[key]
				if (typeof value === "number" && Number.isFinite(value)) result[`task_usage_${key}`] = value
			}
			result.task_usage_cache_available = usage.cacheUsageAvailable === true
		} catch {
			// During construction/recovery usage owners may not be ready. Missing is not zero.
		}
		return result
	}

	/** Called synchronously at state commit, before effects or persistence can delay the observation. */
	committed(event: string, state: Readonly<TaskRuntimeState>): void {
		this.safely(() => {
			if (!this.enabled()) return
			const key = state.turn?.turnId ?? state.anchor.turnId ?? `pre-turn:${state.anchor.apiIndex}`
			if (key !== this.turnKey) {
				this.span?.end("success")
				this.turnKey = key
				this.segment = 0
				this.start("turn_changed")
			}
			this.event("task.state.committed", { task_event: event })
			if (event === "EFFECT_FAILED") this.failure(undefined, { task_event: event })
			if (["completed", "aborted", "paused"].includes(state.phase)) {
				this.span?.end(state.phase === "aborted" ? "cancelled" : "success")
			}
		})
	}

	snapshot(stage: "scheduled" | "persisted" | "failed", snapshot: TaskSnapshot, error?: unknown): void {
		this.safely(() => {
			if (stage === "persisted") {
				this.durableRevision = snapshot.revision
				this.durableTimestamp = snapshot.timestamp
			}
			const attributes = {
				snapshot_phase: snapshot.phase,
				snapshot_revision: snapshot.revision ?? -1,
				snapshot_timestamp: snapshot.timestamp,
			}
			this.event(`task.snapshot.${stage}`, attributes)
			if (stage === "failed") this.failure(error, attributes)
			if (stage === "persisted" && ["completed", "aborted", "paused"].includes(this.readState().phase))
				this.span?.end("success")
		})
	}

	event(name: string, attributes: ObservabilityAttributes = {}): void {
		this.safely(() => {
			if (!this.enabled()) return
			if (!this.span?.active) this.start("continued", this.span)
			if (this.segmentEvents >= SEGMENT_EVENT_LIMIT) this.rotate("event_limit")
			this.record(name, attributes)
		})
	}

	failure(error: unknown, attributes: ObservabilityAttributes = {}, expectedSpan?: SignalSpanHandle): void {
		this.safely(() => {
			if (!this.enabled()) return
			// Segments created by event limits and errors remain in the same real turn.
			// Reject only a parent captured from an older turn, not an older segment.
			if (expectedSpan && this.spanTurnKeys.get(expectedSpan) !== this.turnKey) return
			if (!this.span?.active) this.start("error")
			const fields =
				error === undefined ? attributes : { ...attributes, ...exceptionAttributes(normalizeRuntimeError(error)) }
			this.record("task.error", fields, error)
			if (error !== undefined) this.span?.recordException(error)
			this.rotate("error", "failure")
		})
	}

	dispose(): void {
		this.safely(() => this.span?.end("cancelled"))
		this.disposed = true
		for (const release of this.unregister.splice(0)) release()
		this.span = undefined
	}

	private record(name: string, attributes: ObservabilityAttributes, error?: unknown): void {
		const span = this.span
		if (!span) return
		const timestamp = Date.now()
		const fields = { ...this.attributes(), ...attributes, task_timeline_sequence: ++this.sequence }
		this.segmentEvents += 1
		span.addEvent?.(name, fields, timestamp)
		runWithSignalSpan(span, () =>
			emitSignal({
				name,
				level: name === "task.error" ? "error" : "info",
				timestamp,
				attributes: fields,
				error,
				context: { taskId: this.taskId },
			}),
		)
	}

	private rotate(reason: string, outcome: "success" | "failure" = "success"): void {
		const previous = this.span
		previous?.setAttribute("task_segment_end_reason", reason)
		previous?.end(outcome)
		this.segment += 1
		this.start(reason, previous)
	}

	private start(reason: string, parent?: SignalSpanHandle): void {
		this.segmentEvents = 0
		const span = startSignalSpan({
			name: "task.turn",
			parent,
			root: !parent,
			attributes: { task_id: this.taskId, ...this.attributes(), task_segment_start_reason: reason },
		})
		this.span = span
		this.spanTurnKeys.set(span, this.turnKey)
	}

	private enabled(): boolean {
		return !this.disposed && isSignalRecordingEnabled()
	}

	private safely(action: () => void): void {
		try {
			action()
		} catch {
			/* Observability must never affect committed Task behavior. */
		}
	}
}
