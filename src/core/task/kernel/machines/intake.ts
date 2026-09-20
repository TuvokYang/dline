import type { Command, EntryId, IntakeEntry, IntakeSlice, JournalWatermark, TaskEvent } from "../types"

export const INTAKE_BOX_LIMIT = 32

export interface IntakeReductionContext {
	readonly admittedEntryIds?: readonly EntryId[]
	readonly journalWatermark?: JournalWatermark
}

export interface IntakeReduction {
	readonly state: IntakeSlice
	readonly commands: readonly Command[]
}

function activeCount(entries: readonly IntakeEntry[]): number {
	return entries.filter((entry) => entry.state !== "consumed" && entry.state !== "released").length
}

function nextSequence(entries: readonly IntakeEntry[], requested?: number): number {
	return requested ?? Math.max(0, ...entries.map((entry) => entry.sequence)) + 1
}

function append(entries: readonly IntakeEntry[], entry: IntakeEntry): readonly IntakeEntry[] {
	return entries.some((current) => current.entryId === entry.entryId) ? entries : [...entries, entry]
}

function updateEntries(
	entries: readonly IntakeEntry[],
	entryIds: ReadonlySet<EntryId>,
	update: (entry: IntakeEntry) => IntakeEntry,
): readonly IntakeEntry[] {
	return entries.map((entry) => (entryIds.has(entry.entryId) ? update(entry) : entry))
}

function updateAllBoxes(
	state: IntakeSlice,
	entryIds: readonly EntryId[],
	update: (entry: IntakeEntry) => IntakeEntry,
): IntakeSlice {
	const selected = new Set(entryIds)
	return {
		queued: updateEntries(state.queued, selected, update),
		background: updateEntries(state.background, selected, update),
		coTask: updateEntries(state.coTask, selected, update),
	}
}

export function reserveIntakeEntries(state: IntakeSlice, entryIds: readonly EntryId[]): IntakeSlice {
	return updateAllBoxes(state, entryIds, (entry) => (entry.state === "accepted" ? { ...entry, state: "reserved" } : entry))
}

export function reduceIntake(state: IntakeSlice, event: TaskEvent, context: IntakeReductionContext = {}): IntakeReduction {
	if (event.type === "user.submit") {
		return {
			state: {
				...state,
				queued: append(state.queued, {
					entryId: event.entryId,
					payloadRef: event.payloadRef,
					source: "user",
					mode: event.mode ?? "queued",
					sequence: nextSequence(state.queued, event.sequence),
					state: "accepted",
				}),
			},
			commands: [],
		}
	}
	if (event.type === "background.ready") {
		return {
			state: {
				...state,
				background: append(state.background, {
					entryId: event.entryId,
					payloadRef: event.payloadRef,
					source: "background",
					mode: "queued",
					sequence: nextSequence(state.background, event.sequence),
					state: "accepted",
				}),
			},
			commands: [],
		}
	}
	if (event.type === "cotask.received") {
		return {
			state: {
				...state,
				coTask: append(state.coTask, {
					entryId: event.entryId,
					payloadRef: event.payloadRef,
					source: "cotask",
					mode: "queued",
					sequence: nextSequence(state.coTask, event.sequence),
					state: "accepted",
				}),
			},
			commands: [],
		}
	}
	if (event.type === "compose.completed") {
		return {
			state: updateAllBoxes(state, context.admittedEntryIds ?? [], (entry) =>
				entry.state === "reserved" ? { ...entry, state: "included" } : entry,
			),
			commands: [],
		}
	}
	if (event.type === "compose.failed" || event.type === "user.cancel" || event.type === "user.terminate") {
		const admitted = context.admittedEntryIds ?? [
			...state.queued
				.filter((entry) => entry.state === "reserved" || entry.state === "included")
				.map((entry) => entry.entryId),
			...state.background
				.filter((entry) => entry.state === "reserved" || entry.state === "included")
				.map((entry) => entry.entryId),
			...state.coTask
				.filter((entry) => entry.state === "reserved" || entry.state === "included")
				.map((entry) => entry.entryId),
		]
		return {
			state: updateAllBoxes(state, admitted, (entry) =>
				entry.state === "reserved" || entry.state === "included" ? { ...entry, state: "released" } : entry,
			),
			commands: [],
		}
	}
	if (event.type === "provider.turn_ready") {
		return {
			state: {
				queued: state.queued.map((entry) =>
					entry.state === "included"
						? { ...entry, state: "consumed", journalWatermark: event.journalWatermark }
						: entry,
				),
				background: state.background.map((entry) =>
					entry.state === "included"
						? { ...entry, state: "consumed", journalWatermark: event.journalWatermark }
						: entry,
				),
				coTask: state.coTask.map((entry) =>
					entry.state === "included"
						? { ...entry, state: "consumed", journalWatermark: event.journalWatermark }
						: entry,
				),
			},
			commands: [],
		}
	}
	return { state, commands: [] }
}

export function intakeHasCapacity(entries: readonly IntakeEntry[]): boolean {
	return activeCount(entries) < INTAKE_BOX_LIMIT
}
