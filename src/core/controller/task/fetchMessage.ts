import { FetchMessageRequest, FetchMessageResponse } from "@shared/proto/dline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Controller } from "../index"

/**
 * Fetch messages by absolute index and count.
 * Includes all messages including the initial task message so the frontend
 * can confirm it has scrolled to the absolute top (index 0).
 */
export async function fetchMessage(controller: Controller, request: FetchMessageRequest): Promise<FetchMessageResponse> {
	const page = await controller.fetchCurrentTaskMessages(Number(request.referenceIndex), Number(request.count))
	return {
		messages: page.messages.map(convertClineMessageToProto),
		totalCount: page.totalCount,
		startIndex: page.startIndex,
	}
}
