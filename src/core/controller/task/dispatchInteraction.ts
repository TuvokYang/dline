import { isInteractionActionType } from "@core/task/interaction/Interaction"
import type { InteractionResponse } from "@core/task/interaction/InteractionResponse"
import { type DispatchInteractionRequest, DispatchInteractionResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."

/** Stable protocol outcomes for expected interaction response races. */
type DispatchInteractionResult =
	| "accepted"
	| "stale_interaction"
	| "invalid_action"
	| "invalid_payload"
	| "duplicate_response"
	| "missing_task"
	| "invalid_runtime_event"

/** Create one protocol response without throwing for expected rejection. */
function response(accepted: boolean, result: DispatchInteractionResult): DispatchInteractionResponse {
	return DispatchInteractionResponse.create({ accepted, result })
}

/** Normalize one internal runtime rejection for the public protocol. */
function normalizeResult(code: string | undefined): DispatchInteractionResult {
	if (code === "invalid_interaction_payload") {
		return "invalid_payload"
	}
	switch (code) {
		case "stale_interaction":
		case "invalid_action":
		case "duplicate_response":
		case "invalid_runtime_event":
			return code
		default:
			return "invalid_runtime_event"
	}
}

/** Dispatch one causally identified Webview interaction response. */
export async function dispatchInteraction(
	controller: Controller,
	request: DispatchInteractionRequest,
): Promise<DispatchInteractionResponse> {
	if (!isInteractionActionType(request.actionId)) {
		return response(false, "invalid_action")
	}
	if (!controller.task) {
		return (await controller.dispatchHistoryDisplayInteraction(request)) ?? response(false, "missing_task")
	}

	const interactionResponse: InteractionResponse = {
		taskId: request.taskId,
		turnId: request.turnId,
		interactionId: request.interactionId,
		actionId: request.actionId,
		stateRevision: request.stateRevision,
		draft: request.draft
			? { text: request.draft.text, images: [...request.draft.images], files: [...request.draft.files] }
			: undefined,
		selection: request.selection ? { values: [...request.selection.values] } : undefined,
	}
	const result = await controller.task.dispatchRuntime({ type: "INTERACTION_RESPONDED", response: interactionResponse })
	if (!result.accepted) {
		return response(false, normalizeResult(result.error?.code))
	}
	await controller.task.waitForInteractionSettlement(request.interactionId)
	return response(true, "accepted")
}
