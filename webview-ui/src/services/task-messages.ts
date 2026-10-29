import type { TaskViewState } from "@shared/ExtensionMessage"
import { FetchMessageRequest, type FetchMessageResponse } from "@shared/proto/dline/task"
import { TaskServiceClient } from "./grpc-client"

/** The canonical Task plus this opening, independent of title, HistoryItem and working phase. */
export function getTaskViewKey(view?: Partial<Pick<TaskViewState, "taskId" | "taskInstanceId">>): string | undefined {
    return view?.taskId && view.taskInstanceId ? JSON.stringify([view.taskId, view.taskInstanceId]) : undefined
}

export async function fetchTaskMessages(
    view: Pick<TaskViewState, "taskId" | "taskInstanceId"> | undefined,
    referenceIndex: number,
    count: number,
): Promise<FetchMessageResponse> {
    return requestTaskMessages(view, { referenceIndex, count })
}

/**
 * Fetch a page of `count` messages centred on the message with `anchorTs`.
 *
 * The extension locates the anchor in the sequence it pages, so the page holds
 * the anchor whenever `anchorFound` is true; otherwise the page is empty.
 */
export async function fetchAnchoredTaskMessages(
    view: Pick<TaskViewState, "taskId" | "taskInstanceId"> | undefined,
    anchorTs: number,
    count: number,
): Promise<FetchMessageResponse> {
    return requestTaskMessages(view, { referenceIndex: 0, count, anchorTs })
}

async function requestTaskMessages(
    view: Pick<TaskViewState, "taskId" | "taskInstanceId"> | undefined,
    page: { referenceIndex: number; count: number; anchorTs?: number },
): Promise<FetchMessageResponse> {
    if (!view?.taskId || !view.taskInstanceId) throw new Error("No opened Task instance")
    const request = FetchMessageRequest.create({
        taskId: view.taskId,
        taskInstanceId: view.taskInstanceId,
        ...page,
    })
    const response = await TaskServiceClient.fetchMessage(request)
    if (response.taskId !== request.taskId || response.taskInstanceId !== request.taskInstanceId) {
        throw new Error("Message response belongs to a different Task opening")
    }
    return response
}
