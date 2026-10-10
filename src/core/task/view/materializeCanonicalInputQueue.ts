import type { QueuedInputEntry } from "@shared/InputQueue"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { TaskState } from "../kernel"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { canonicalInputQueuePayloadRefs, projectCanonicalInputQueue } from "./canonical/materializeCanonicalInputQueue"

/** Reads payloads at the view boundary, then delegates ordering and visibility to the pure canonical projection. */
export async function materializeCanonicalInputQueue(
    state: Readonly<TaskState>,
    payloads: TaskPayloadStore,
    cache: Map<string, UserInputEnvelope> = new Map(),
): Promise<readonly QueuedInputEntry[]> {
    await Promise.all(
        canonicalInputQueuePayloadRefs(state).map(async (payloadRef) => {
            if (cache.has(payloadRef)) return
            const payload = decodeTaskPayload<UserInputEnvelope>(await payloads.read(payloadRef))
            if (payload.kind !== "user_input") throw new Error(`Payload ${payloadRef} is not user input`)
            cache.set(payloadRef, payload)
        }),
    )
    return projectCanonicalInputQueue<SemanticInputDocument>(state, cache)
}
