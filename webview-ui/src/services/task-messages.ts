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
	if (!view?.taskId || !view.taskInstanceId) throw new Error("No opened Task instance")
	const request = FetchMessageRequest.create({
		taskId: view.taskId,
		taskInstanceId: view.taskInstanceId,
		referenceIndex,
		count,
	})
	const response = await TaskServiceClient.fetchMessage(request)
	if (response.taskId !== request.taskId || response.taskInstanceId !== request.taskInstanceId) {
		throw new Error("Message response belongs to a different Task opening")
	}
	return response
}
