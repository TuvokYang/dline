import type { Command, FlowState, TaskEvent } from "../types"

export interface FlowReduction {
	readonly state: FlowState
	readonly commands: readonly Command[]
}

export function reduceFlow(state: FlowState, event: TaskEvent): FlowReduction {
	switch (event.type) {
		case "lifecycle.open":
			return { state: state.phase === "idle" ? { phase: "initializing" } : state, commands: [] }
		case "provider.turn_ready":
			return { state: { phase: "running" }, commands: [] }
		case "provider.failed":
		case "compose.failed":
		case "compaction.failed":
		case "approval.failed":
		case "lifecycle.spawn_failed":
			return { state: { phase: "error", error: event.message ?? event.type }, commands: [] }
		case "lifecycle.close":
			return { state: { phase: "completed", completionId: state.completionId }, commands: [] }
		default:
			return { state, commands: [] }
	}
}
