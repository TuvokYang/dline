import type { Command, IntakeEntry, IntakeSlice, TaskEvent } from "../types"

export interface IntakeReduction {
	readonly state: IntakeSlice
	readonly commands: readonly Command[]
}

function append(entries: readonly IntakeEntry[], entry: IntakeEntry): readonly IntakeEntry[] {
	return entries.some((current) => current.entryId === entry.entryId) ? entries : [...entries, entry]
}

export function reduceIntake(state: IntakeSlice, event: TaskEvent): IntakeReduction {
	if (event.type === "user.submit") {
		return {
			state: {
				...state,
				queued: append(state.queued, { entryId: event.entryId, payloadRef: event.payloadRef, state: "accepted" }),
			},
			commands: [],
		}
	}
	if (event.type === "background.ready") {
		return {
			state: {
				...state,
				background: append(state.background, { entryId: event.entryId, payloadRef: event.payloadRef, state: "accepted" }),
			},
			commands: [],
		}
	}
	if (event.type === "cotask.received") {
		return {
			state: {
				...state,
				coTask: append(state.coTask, { entryId: event.entryId, payloadRef: event.payloadRef, state: "accepted" }),
			},
			commands: [],
		}
	}
	return { state, commands: [] }
}
