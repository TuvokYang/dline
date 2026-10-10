import type { EmptyRequest, String as ProtoString } from "@shared/proto/dline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Per-controller subscriptions to isolate events between independent webviews.
const subs = new Map<Controller, Set<StreamingResponseHandler<ProtoString>>>()

/**
 * Subscribe to addToInput events for a specific controller.
 * Only events from this controller's task will be sent to the responseStream.
 */
export async function subscribeToAddToInput(
    controller: Controller,
    _request: EmptyRequest,
    responseStream: StreamingResponseHandler<ProtoString>,
    requestId?: string,
): Promise<void> {
    let set = subs.get(controller)
    if (!set) {
        set = new Set()
        subs.set(controller, set)
    }
    set.add(responseStream)

    const cleanup = () => {
        const s = subs.get(controller)
        if (s) {
            s.delete(responseStream)
            if (s.size === 0) subs.delete(controller)
        }
    }

    if (requestId) {
        getRequestRegistry().registerRequest(requestId, cleanup, { type: "addToInput_subscription" }, responseStream)
    }
}

/**
 * Send an addToInput event to a specific controller's subscribers.
 * @param controller The controller whose subscribers should receive the event
 * @param text The text to add to the input
 */
export async function sendAddToInputEvent(controller: Controller, text: string): Promise<void> {
    const set = subs.get(controller)
    if (!set || set.size === 0) return

    const promises = Array.from(set).map(async (responseStream) => {
        try {
            const event: ProtoString = { value: text }
            await responseStream(event, false)
        } catch (error) {
            Logger.error("Error sending addToInput event:", error)
            set.delete(responseStream)
        }
    })

    await Promise.all(promises)
}
