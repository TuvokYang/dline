import type {
	Command,
	EntryId,
	InputQueueDeliveryPoint,
	InputQueueDeliveryReservation,
	IntakeEntry,
	IntakeSlice,
	JournalWatermark,
	TaskEvent,
} from "../types"

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
	return entries.filter((entry) => entry.state !== "consumed").length
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
	return updateAllBoxes(state, entryIds, (entry) =>
		entry.state === "accepted" || entry.state === "released" ? { ...entry, state: "reserved" } : entry,
	)
}

function isMutableRetainedEntry(entry: IntakeEntry): boolean {
	return entry.source === "user" && entry.queue !== undefined && (entry.state === "accepted" || entry.state === "released")
}

function isDeliverableRetainedEntry(entry: IntakeEntry): boolean {
	return isMutableRetainedEntry(entry) && entry.queue?.editing !== true
}

/** Select the canonical retained batch owed to one delivery point. */
export function selectRetainedQueueEntryIds(state: IntakeSlice, point: InputQueueDeliveryPoint): readonly EntryId[] {
	const ordered = state.queued.filter(isDeliverableRetainedEntry).sort((left, right) => left.sequence - right.sequence)
	const steering = ordered.filter((entry) => entry.mode === "steering")
	if (steering.length > 0) return steering.map((entry) => entry.entryId)
	if (point === "tool_round") return []
	const queued = ordered.find((entry) => entry.mode === "queued")
	return queued ? [queued.entryId] : []
}

/** Entries held by one durable retained-input delivery. */
export function retainedQueueDeliveryEntries(state: IntakeSlice, deliveryId: string): readonly IntakeEntry[] {
	return state.queued
		.filter(
			(entry) =>
				entry.queue?.delivery?.deliveryId === deliveryId &&
				(entry.state === "reserved" || entry.state === "included" || entry.state === "uncertain"),
		)
		.sort((left, right) => left.sequence - right.sequence)
}

export function reserveRetainedQueueEntries(
	state: IntakeSlice,
	entryIds: readonly EntryId[],
	reservation: InputQueueDeliveryReservation,
): IntakeSlice {
	const selected = new Set(entryIds)
	return {
		...state,
		queued: state.queued.map((entry) =>
			selected.has(entry.entryId) && isDeliverableRetainedEntry(entry) && entry.queue
				? { ...entry, state: "reserved" as const, queue: { ...entry.queue, delivery: reservation } }
				: entry,
		),
	}
}

function reserveRetainedQueueDelivery(
	state: IntakeSlice,
	point: InputQueueDeliveryPoint,
	reservation: InputQueueDeliveryReservation,
): IntakeSlice {
	return reserveRetainedQueueEntries(state, selectRetainedQueueEntryIds(state, point), reservation)
}

function settleRetainedQueueDelivery(
	state: IntakeSlice,
	deliveryId: string,
	settledState: "released" | "consumed",
	journalWatermark?: JournalWatermark,
): IntakeSlice {
	return {
		...state,
		queued: state.queued.map((entry) => {
			if (entry.queue?.delivery?.deliveryId !== deliveryId || !["reserved", "included", "uncertain"].includes(entry.state))
				return entry
			const { delivery: _delivery, ...queue } = entry.queue
			return {
				...entry,
				state: settledState,
				queue,
				...(settledState === "consumed" && journalWatermark ? { journalWatermark } : {}),
			}
		}),
	}
}

function reorderRetainedEntries(entries: readonly IntakeEntry[], entryId: EntryId, targetIndex: number): readonly IntakeEntry[] {
	const ordered = entries.filter(isMutableRetainedEntry).sort((left, right) => left.sequence - right.sequence)
	const from = ordered.findIndex((entry) => entry.entryId === entryId)
	if (from < 0) return entries
	const [moved] = ordered.splice(from, 1)
	const target = Math.max(0, Math.min(targetIndex, ordered.length))
	ordered.splice(target, 0, moved)
	const sequenceById = new Map(ordered.map((entry, index) => [entry.entryId, index]))
	return entries.map((entry) => {
		const sequence = sequenceById.get(entry.entryId)
		return sequence === undefined ? entry : { ...entry, sequence }
	})
}

export function reduceIntake(state: IntakeSlice, event: TaskEvent, context: IntakeReductionContext = {}): IntakeReduction {
	if (event.type === "input_queue.enqueued") {
		return {
			state: {
				...state,
				queued: append(state.queued, {
					entryId: event.entryId,
					payloadRef: event.payloadRef,
					source: "user",
					mode: "queued",
					sequence: nextSequence(state.queued),
					queue: { editing: false },
					state: "accepted",
				}),
			},
			commands: [],
		}
	}
	if (event.type === "input_queue.mode_toggled") {
		return {
			state: updateAllBoxes(state, [event.entryId], (entry) =>
				isMutableRetainedEntry(entry) ? { ...entry, mode: entry.mode === "queued" ? "steering" : "queued" } : entry,
			),
			commands: [],
		}
	}
	if (event.type === "input_queue.reordered") {
		return {
			state: { ...state, queued: reorderRetainedEntries(state.queued, event.entryId, event.targetIndex) },
			commands: [],
		}
	}
	if (event.type === "input_queue.edit_started") {
		return {
			state: updateAllBoxes(state, [event.entryId], (entry) =>
				isMutableRetainedEntry(entry) ? { ...entry, queue: { editing: true } } : entry,
			),
			commands: [],
		}
	}
	if (event.type === "input_queue.edit_committed") {
		return {
			state: updateAllBoxes(state, [event.entryId], (entry) =>
				isMutableRetainedEntry(entry) ? { ...entry, payloadRef: event.payloadRef, queue: { editing: false } } : entry,
			),
			commands: [],
		}
	}
	if (event.type === "input_queue.edit_cancelled") {
		return {
			state: updateAllBoxes(state, [event.entryId], (entry) =>
				isMutableRetainedEntry(entry) ? { ...entry, queue: { editing: false } } : entry,
			),
			commands: [],
		}
	}
	if (event.type === "input_queue.removed") {
		return { state: { ...state, queued: state.queued.filter((entry) => entry.entryId !== event.entryId) }, commands: [] }
	}
	if (event.type === "input_queue.delivery_reserved") {
		return {
			state: reserveRetainedQueueDelivery(state, event.point, {
				deliveryId: event.deliveryId,
				point: event.point,
				ownerId: event.ownerId,
				generation: event.generation,
			}),
			commands: [],
		}
	}
	if (event.type === "input_queue.delivery_released") {
		return { state: settleRetainedQueueDelivery(state, event.deliveryId, "released"), commands: [] }
	}
	if (event.type === "input_queue.delivery_reconciled") {
		return {
			state: settleRetainedQueueDelivery(state, event.deliveryId, event.outcome, event.journalWatermark),
			commands: [],
		}
	}
	if (event.type === "dialog.responded" && event.queueDeliveryId) {
		return { state: settleRetainedQueueDelivery(state, event.queueDeliveryId, "consumed"), commands: [] }
	}
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
	if (
		event.type === "compose.failed" ||
		event.type === "compose.withdrawn" ||
		event.type === "user.cancel" ||
		event.type === "user.terminate"
	) {
		const admitted = (event.type === "user.cancel" || event.type === "user.terminate"
			? undefined
			: context.admittedEntryIds) ?? [
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
			state: updateAllBoxes(state, admitted, (entry) => {
				if (entry.state !== "reserved" && entry.state !== "included") return entry
				const queueState = entry.queue
				const delivery = queueState?.delivery
				const uncertain =
					delivery?.point === "tool_round" &&
					(((event.type === "compose.failed" || event.type === "compose.withdrawn") &&
						event.queueDisposition === "uncertain") ||
						event.type === "user.cancel" ||
						event.type === "user.terminate")
				if (uncertain) return { ...entry, state: "uncertain" }
				if (!delivery || !queueState) return { ...entry, state: "released" }
				const { delivery: _delivery, ...queue } = queueState
				return { ...entry, state: "released", queue }
			}),
			commands: [],
		}
	}
	if (event.type === "provider.turn_ready") {
		return {
			state: {
				queued: state.queued.map((entry) => {
					if (entry.state !== "included") return entry
					if (!entry.queue?.delivery) return { ...entry, state: "consumed", journalWatermark: event.journalWatermark }
					const { delivery: _delivery, ...queue } = entry.queue
					return { ...entry, state: "consumed", journalWatermark: event.journalWatermark, queue }
				}),
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

/**
 * Entries that are accepted but still waiting for a round to carry them.
 *
 * Arrivals are accepted whenever they happen, including while a round is in
 * flight, but only a round admits them. A released direct input belonged to a
 * round that was explicitly abandoned and must not be admitted again; released
 * retained input is selected separately by its delivery-point policy.
 */
export function pendingIntakeEntryIds(state: IntakeSlice): readonly EntryId[] {
	return [...state.queued, ...state.background, ...state.coTask]
		.filter((entry) => entry.state === "accepted" && entry.queue === undefined)
		.map((entry) => entry.entryId)
}
