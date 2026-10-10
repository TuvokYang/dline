import type { EntryId } from "../../kernel"
import type { TaskEventSink } from "../contracts"
import { InboundEventSource } from "../shared/InboundEventSource"

export interface CoTaskArrival {
    readonly entryId: EntryId
    readonly payloadRef: string
    readonly sequence?: number
}

export class CoTaskIngressExecutor extends InboundEventSource<CoTaskArrival> {
    constructor(generation: () => number, events: TaskEventSink) {
        super(
            "cotask",
            generation,
            (input, currentGeneration) => ({
                type: "cotask.received",
                generation: currentGeneration,
                entryId: input.entryId,
                payloadRef: input.payloadRef,
                sequence: input.sequence,
            }),
            events,
        )
    }
}
