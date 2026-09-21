import { FetchMessageRequest, FetchMessageResponse } from "@shared/proto/dline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Controller } from "../index"

/**
 * Fetch messages by absolute index and count.
 * Includes all messages including the initial task message so the frontend
 * can confirm it has scrolled to the absolute top (index 0).
 */
export async function fetchMessage(controller: Controller, request: FetchMessageRequest): Promise<FetchMessageResponse> {
	const messages = controller.task?.owners.messages.clineMessages || []
	const total = messages.length

	const referenceIndex = Number(request.referenceIndex)
	const count = Number(request.count)

	let result: typeof messages
	let startIndex = -1
	if (referenceIndex === -1) {
		// -1 means fetch the last `count` messages
		startIndex = Math.max(0, total - count)
		result = messages.slice(startIndex)
	} else {
		startIndex = Math.max(0, Math.min(referenceIndex, total))
		const endIndex = Math.min(startIndex + count, total)
		result = messages.slice(startIndex, endIndex)
	}

	return { messages: result.map(convertClineMessageToProto), totalCount: total, startIndex }
}
