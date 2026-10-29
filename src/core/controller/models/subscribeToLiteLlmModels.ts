import { EmptyRequest } from "@shared/proto/dline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Per-controller subscription sets to isolate model updates between
// independent webviews. When a controller is disposed its subscribers
// are removed so dead streams don't accumulate in the global set.
const controllerSubscriptions = new Map<Controller, Set<StreamingResponseHandler<OpenRouterCompatibleModelInfo>>>()

/**
 * Subscribe to LiteLLM models events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToLiteLlmModels(
    _controller: Controller,
    _request: EmptyRequest,
    responseStream: StreamingResponseHandler<OpenRouterCompatibleModelInfo>,
    requestId?: string,
): Promise<void> {
    // Add this subscription under the owning controller
    let subs = controllerSubscriptions.get(_controller)
    if (!subs) {
        subs = new Set()
        controllerSubscriptions.set(_controller, subs)
    }
    subs.add(responseStream)

    // Register cleanup when the connection is closed
    const cleanup = () => {
        const set = controllerSubscriptions.get(_controller)
        if (set) {
            set.delete(responseStream)
            if (set.size === 0) {
                controllerSubscriptions.delete(_controller)
            }
        }
    }

    // Register the cleanup function with the request registry if we have a requestId
    if (requestId) {
        getRequestRegistry().registerRequest(requestId, cleanup, { type: "liteLlmModels_subscription" }, responseStream)
    }
}

/**
 * Send a LiteLLM models event to all active subscribers
 * @param models The LiteLLM models to send
 */
export async function sendLiteLlmModelsEvent(models: OpenRouterCompatibleModelInfo): Promise<void> {
    // Send the event to all active subscribers across every controller
    const promises: Promise<void>[] = []
    for (const [, subs] of controllerSubscriptions) {
        for (const responseStream of subs) {
            promises.push(
                responseStream(models, false).catch((error) => {
                    Logger.error("Error sending LiteLLM models event:", error)
                    // Remove the dead stream from whichever controller owns it
                    for (const [ctrl, set] of controllerSubscriptions) {
                        if (set.delete(responseStream)) {
                            if (set.size === 0) controllerSubscriptions.delete(ctrl)
                            break
                        }
                    }
                }),
            )
        }
    }
    await Promise.all(promises)
}

/**
 * Remove all subscriptions belonging to a specific controller.
 * Called from Controller.dispose() to prevent dead streams from
 * accumulating in the global subscription set.
 */
export function cleanupLiteLlmSubscriptions(controller: Controller): void {
    controllerSubscriptions.delete(controller)
}
