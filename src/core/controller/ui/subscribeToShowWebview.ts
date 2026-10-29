import { EmptyRequest } from "@shared/proto/dline/common"
import { ShowWebviewEvent } from "@shared/proto/dline/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

const subs = new Map<Controller, Set<StreamingResponseHandler<ShowWebviewEvent>>>()

export async function subscribeToShowWebview(
    controller: Controller,
    _request: EmptyRequest,
    responseStream: StreamingResponseHandler<ShowWebviewEvent>,
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
    if (requestId) getRequestRegistry().registerRequest(requestId, cleanup, { type: "show_webview_subscription" }, responseStream)
}

export async function sendShowWebviewEvent(controller: Controller, preserveEditorFocus = false): Promise<void> {
    const set = subs.get(controller)
    if (!set || set.size === 0) return
    const promises = Array.from(set).map(async (rs) => {
        try {
            await rs(ShowWebviewEvent.create({ preserveEditorFocus }), false)
        } catch (e) {
            Logger.error("Error sending show webview event:", e)
            set.delete(rs)
        }
    })
    await Promise.all(promises)
}
