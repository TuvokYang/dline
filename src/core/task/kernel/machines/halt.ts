import type { Command, HaltSlice, ParticipantId, TaskEvent } from "../types"

export interface HaltReduction {
	readonly state: HaltSlice
	readonly commands: readonly Command[]
}
export const ALL_HALT_PARTICIPANTS: readonly ParticipantId[] = [
	"provider",
	"tool",
	"dialog",
	"compose",
	"compaction",
	"policy",
	"background",
	"cotask",
	"spawn",
]

export function reduceHalt(state: HaltSlice, event: TaskEvent): HaltReduction {
	if (event.type === "user.cancel" || event.type === "user.terminate") {
		if (state.status === "stopping" && state.haltId === event.haltId) return { state, commands: [] }
		return {
			state: {
				status: "stopping",
				generation: state.generation + 1,
				haltId: event.haltId,
				target: event.type === "user.terminate" ? "terminated" : "paused",
				pending: ALL_HALT_PARTICIPANTS,
				halted: [],
				failed: [],
				timedOut: [],
			},
			commands: [],
		}
	}
	if (state.status !== "stopping") return { state, commands: [] }
	if (
		(event.type === "halt.halted" || event.type === "halt.failed") &&
		event.haltId === state.haltId &&
		state.pending.includes(event.participantId)
	) {
		const pending = state.pending.filter((id) => id !== event.participantId)
		return {
			state: {
				...state,
				pending,
				halted: event.type === "halt.halted" ? [...state.halted, event.participantId] : state.halted,
				failed: event.type === "halt.failed" ? [...state.failed, event.participantId] : state.failed,
			},
			commands: [],
		}
	}
	if (event.type === "lifecycle.halt_timeout" && event.haltId === state.haltId)
		return { state: { ...state, timedOut: state.pending }, commands: [] }
	return { state, commands: [] }
}
