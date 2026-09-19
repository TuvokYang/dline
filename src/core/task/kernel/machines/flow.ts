import type { Command, FlowState, TaskEvent } from "../types"

export interface FlowReduction {
	readonly state: FlowState
	readonly commands: readonly Command[]
}

export function reduceFlow(state: FlowState, event: TaskEvent): FlowReduction {
	switch (event.type) {
		case "lifecycle.open":
			return { state: state.phase === "idle" ? { ...state, phase: "initializing" } : state, commands: [] }
		case "provider.turn_ready":
			return {
				state: {
					...state,
					phase: "running",
					error: undefined,
					provider: state.provider && { ...state.provider, status: "completed" },
				},
				commands: [],
			}
		case "provider.failed":
			return {
				state: {
					...state,
					phase: "error",
					error: event.message,
					provider: state.provider && { ...state.provider, status: "failed" },
				},
				commands: [],
			}
		case "compose.completed":
			return { state: { ...state, compose: state.compose && { ...state.compose, status: "completed" } }, commands: [] }
		case "compose.failed":
			return {
				state: {
					...state,
					phase: "error",
					error: event.message,
					compose: state.compose && { ...state.compose, status: "failed" },
				},
				commands: [],
			}
		case "approval.failed":
		case "lifecycle.spawn_failed":
			return { state: { ...state, phase: "error", error: event.message ?? event.type }, commands: [] }
		case "compaction.requested":
			return {
				state: {
					...state,
					compaction: {
						compactionId: event.compactionId,
						attempt: event.attempt,
						contextRef: event.contextRef,
						status: "scheduled",
					},
				},
				commands: [],
			}
		case "compaction.started":
			return {
				state: { ...state, compaction: state.compaction && { ...state.compaction, status: "running" } },
				commands: [],
			}
		case "compaction.completed":
			return {
				state: {
					...state,
					compaction: state.compaction && { ...state.compaction, status: "completed", resultRef: event.resultRef },
				},
				commands: [],
			}
		case "compaction.failed":
			return {
				state: {
					...state,
					compaction: state.compaction && { ...state.compaction, status: "failed", message: event.message },
				},
				commands: [],
			}
		case "compaction.expired":
			return {
				state: {
					...state,
					compaction: state.compaction && { ...state.compaction, status: "expired", message: event.message },
				},
				commands: [],
			}
		case "lifecycle.close":
			return { state: { ...state, phase: "completed", completionId: state.completionId }, commands: [] }
		default:
			return { state, commands: [] }
	}
}
