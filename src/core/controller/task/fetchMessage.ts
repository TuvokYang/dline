import { FetchMessageRequest, FetchMessageResponse } from "@shared/proto/dline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Controller } from "../index"
import { currentOpening } from "./opened-task"

/**
 * Fetch messages by absolute index and count.
 * Includes all messages including the initial task message so the frontend
 * can confirm it has scrolled to the absolute top (index 0).
 */
export async function fetchMessage(controller: Controller, request: FetchMessageRequest): Promise<FetchMessageResponse> {
    const opening = currentOpening(controller, request)
    if (!opening) throw new Error("Message query requires the matching opened Task instance")
    const page = await controller.fetchCurrentTaskMessages(Number(request.referenceIndex), Number(request.count))
    // A page read across a reopen belongs to the surface that is gone.
    if (controller.currentOpening() !== opening) throw new Error("Message query Task instance was closed")
    return {
        messages: page.messages.map(convertClineMessageToProto),
        totalCount: page.totalCount,
        startIndex: page.startIndex,
        taskId: opening.taskId,
        taskInstanceId: opening.taskInstanceId,
    }
}
