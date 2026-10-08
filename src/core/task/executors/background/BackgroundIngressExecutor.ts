import type { EntryId } from "../../kernel"
import type { TaskEventSink } from "../contracts"
import { InboundEventSource } from "../shared/InboundEventSource"

export interface BackgroundArrival {
	readonly entryId: EntryId
	readonly payloadRef: string
	readonly sequence?: number
}

export class BackgroundIngressExecutor extends InboundEventSource<BackgroundArrival> {
	constructor(generation: () => number, events: TaskEventSink) {
		super(
			"background",
			generation,
			(input, currentGeneration) => ({
				type: "background.ready",
				generation: currentGeneration,
				entryId: input.entryId,
				payloadRef: input.payloadRef,
				sequence: input.sequence,
			}),
			events,
		)
	}
}
