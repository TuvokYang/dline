import type { ParticipantId, TaskEvent } from "../../kernel"
import type { HaltOrder, HaltParticipant, TaskEventSink, TaskEventSubmission } from "../contracts"

export type InboundPublishResult = TaskEventSubmission | { readonly kind: "fenced"; readonly haltId: string }

export class InboundEventSource<TInput> implements HaltParticipant {
	private readonly active = new Set<Promise<InboundPublishResult>>()
	private fencedHaltId: string | undefined

	constructor(
		readonly id: ParticipantId,
		private readonly generation: () => number,
		private readonly event: (input: TInput, generation: number) => TaskEvent,
		private readonly events: TaskEventSink,
	) {}

	publish(input: TInput): Promise<InboundPublishResult> {
		if (this.fencedHaltId) return Promise.resolve({ kind: "fenced", haltId: this.fencedHaltId })
		const submission = this.events.submit(this.event(input, this.generation()))
		this.active.add(submission)
		void submission.finally(() => this.active.delete(submission)).catch(() => undefined)
		return submission
	}

	fence(order: HaltOrder): void {
		this.fencedHaltId = order.haltId
	}

	stop(_order: HaltOrder): void {}

	async drain(_order: HaltOrder): Promise<void> {
		await Promise.allSettled([...this.active])
	}

	rearm(haltId: string): void {
		if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
	}
}
