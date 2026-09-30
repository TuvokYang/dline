import { FetchMessageRequest, FetchMessageResponse } from "@shared/proto/dline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Controller } from "../index"

/**
 * Fetch messages by absolute index and count.
 * Includes all messages including the initial task message so the frontend
 * can confirm it has scrolled to the absolute top (index 0).
 */
export async function fetchMessage(controller: Controller, request: FetchMessageRequest): Promise<FetchMessageResponse> {
	const owner = controller.task
	if (!owner || owner.taskId !== request.taskId || !request.taskInstanceId || owner.taskInstanceId !== request.taskInstanceId) {
		throw new Error("Message query requires the matching opened Task instance")
	}
	const page = await owner.fetchDisplayMessages(Number(request.referenceIndex), Number(request.count))
	if (controller.task !== owner) throw new Error("Message query Task instance was closed")
	return {
		messages: page.messages.map(convertClineMessageToProto),
		totalCount: page.totalCount,
		startIndex: page.startIndex,
		taskId: owner.taskId,
		taskInstanceId: owner.taskInstanceId,
	}
}
