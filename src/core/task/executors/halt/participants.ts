import type { ParticipantId } from "../../kernel"
import { ALL_HALT_PARTICIPANTS } from "../../kernel/machines/halt"
import type { HaltOrder, HaltParticipant } from "../contracts"

export interface CallbackHaltParticipantOptions {
	readonly id: ParticipantId
	readonly fence: (order: HaltOrder) => void
	readonly stop?: (order: HaltOrder) => void | Promise<void>
	readonly drain?: (order: HaltOrder) => Promise<void>
	readonly rearm?: (haltId: string) => void
}

/** Adapts legacy ingress/resource owners without letting the halt shell fake a receipt. */
export class CallbackHaltParticipant implements HaltParticipant {
	readonly id: ParticipantId

	constructor(private readonly options: CallbackHaltParticipantOptions) {
		this.id = options.id
	}

	fence(order: HaltOrder): void {
		this.options.fence(order)
	}

	stop(order: HaltOrder): void | Promise<void> {
		return this.options.stop?.(order)
	}

	drain(order: HaltOrder): Promise<void> {
		return this.options.drain?.(order) ?? Promise.resolve()
	}

	rearm(haltId: string): void {
		this.options.rearm?.(haltId)
	}
}

export function missingHaltParticipants(participants: readonly HaltParticipant[]): ParticipantId[] {
	const registered = new Set(participants.map((participant) => participant.id))
	return ALL_HALT_PARTICIPANTS.filter((participantId) => !registered.has(participantId))
}

export function assertCompleteHaltParticipants(participants: readonly HaltParticipant[]): void {
	const missing = missingHaltParticipants(participants)
	if (missing.length > 0) throw new Error(`Missing halt participants: ${missing.join(", ")}`)
}
