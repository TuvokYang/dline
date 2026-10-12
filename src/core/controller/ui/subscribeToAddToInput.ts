import type { EmptyRequest } from "@shared/proto/dline/common"
import { AddToInputEvent } from "@shared/proto/dline/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Per-controller subscriptions to isolate events between independent webviews.
const subs = new Map<Controller, Set<StreamingResponseHandler<AddToInputEvent>>>()

/** An editor selection: the file it came from and the fenced code, kept apart so neither is retyped. */
export interface EditorSelectionInput {
    /** The complete content as plain text, for a composer that cannot take the structure. */
    readonly text: string
    /** Workspace mention reference of the selection's file, without the leading "@". */
    readonly mentionReference?: string
    /** The fenced selection plus any notebook context or problems. */
    readonly selection: string
}

/**
 * Subscribe to addToInput events for a specific controller.
 * Only events from this controller's task will be sent to the responseStream.
 */
export async function subscribeToAddToInput(
    controller: Controller,
    _request: EmptyRequest,
    responseStream: StreamingResponseHandler<AddToInputEvent>,
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
 * @param content Plain text the composer inserts as typed, or an editor selection
 */
export async function sendAddToInputEvent(controller: Controller, content: string | EditorSelectionInput): Promise<void> {
    const set = subs.get(controller)
    if (!set || set.size === 0) return

    const event = AddToInputEvent.create(
        typeof content === "string"
            ? { text: content }
            : { text: content.text, mentionReference: content.mentionReference ?? "", selection: content.selection },
    )
    const promises = Array.from(set).map(async (responseStream) => {
        try {
            await responseStream(event, false)
        } catch (error) {
            Logger.error("Error sending addToInput event:", error)
            set.delete(responseStream)
        }
    })

    await Promise.all(promises)
}
