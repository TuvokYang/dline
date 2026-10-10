import { Empty, EmptyRequest } from "@shared/proto/dline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Per-controller subscriptions to isolate events between independent webviews.
const subs = new Map<Controller, Set<StreamingResponseHandler<Empty>>>()

/**
 * Subscribe to chatButtonClicked events for a specific controller.
 */
export async function subscribeToChatButtonClicked(
    controller: Controller,
    _request: EmptyRequest,
    responseStream: StreamingResponseHandler<Empty>,
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
        getRequestRegistry().registerRequest(requestId, cleanup, { type: "chatButtonClicked_subscription" }, responseStream)
    }
}

/**
 * Send a chatButtonClicked event to a specific controller's subscribers.
 * @param controller The controller whose subscribers should receive the event
 */
export async function sendChatButtonClickedEvent(controller: Controller): Promise<void> {
    const set = subs.get(controller)
    if (!set || set.size === 0) return

    const promises = Array.from(set).map(async (responseStream) => {
        try {
            const event = Empty.create({})
            await responseStream(event, false)
        } catch (error) {
            Logger.error("Error sending chatButtonClicked event:", error)
            set.delete(responseStream)
        }
    })

    await Promise.all(promises)
}
