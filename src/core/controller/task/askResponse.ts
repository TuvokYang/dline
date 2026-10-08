import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { Empty } from "@shared/proto/dline/common"
import { AskResponseRequest, DispatchInteractionRequest } from "@shared/proto/dline/task"
import { fromProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { dispatchInteraction } from "./dispatchInteraction"

/**
 * Decode the submitted structure, or report that this response is text only.
 *
 * An undecodable document is dropped and diagnosed: admission would reject it
 * anyway, and the user's text remains a valid response on its own.
 */
function decodeSemanticInput(request: AskResponseRequest): SemanticInputDocument | undefined {
	if (!request.semanticInput) return undefined
	const decoded = fromProtoSemanticInputDocument(request.semanticInput)
	if (decoded.ok) return decoded.document
	Logger.warn(`askResponse: dropping undecodable semantic input (${decoded.diagnostic.code})`)
	return undefined
}

function selectAction(responseType: string, actionIds: readonly string[]): string | undefined {
	const preferences =
		responseType === "yesButtonClicked" || responseType === "retry"
			? ["approve", "acknowledge", "resume", "retry", "process_anyway", "confirm_utility", "start_new_task"]
			: responseType === "noButtonClicked"
				? ["reject", "stop"]
				: ["reply", "resume", "retry", "acknowledge"]
	return preferences.find((candidate) => actionIds.includes(candidate)) ?? actionIds[0]
}

/** Compatibility adapter that routes legacy asks into canonical interaction or intake events. */
export async function askResponse(controller: Controller, request: AskResponseRequest): Promise<Empty> {
	try {
		const session = controller.task
		if (!session) {
			Logger.warn("askResponse: No active task to receive response")
			return Empty.create()
		}
		if (!session.writable) {
			Logger.warn(`askResponse: Task ${session.taskId} is owned by another window; response refused`)
			return Empty.create()
		}
		// Retry during an automatic countdown sends the scheduled attempt now,
		// spending the same retry the countdown would have spent.
		if (request.responseType === "retry" && session.owners.providerRetry?.retryNow()) return Empty.create()
		const state = session.state()
		const semanticInput = decodeSemanticInput(request)
		const interaction =
			state.dialog.primary?.status === "awaiting"
				? state.dialog.primary
				: Object.values(state.dialog.approvalsByBlock).find((candidate) => candidate.status === "awaiting")
		if (!interaction) {
			if (request.responseType === "messageResponse" && (request.text || request.images.length || request.files.length)) {
				const input = await session.inputs.materialize({
					text: request.text,
					images: [...request.images],
					files: [...request.files],
					...(semanticInput === undefined ? {} : { semanticInput }),
				})
				await session.task.submitInput(input)
			}
			return Empty.create()
		}
		const actionId = selectAction(
			request.responseType,
			interaction.actionRules.map((rule) => rule.actionId),
		)
		if (!actionId) return Empty.create()
		await dispatchInteraction(
			controller,
			DispatchInteractionRequest.create({
				taskId: session.taskId,
				turnId: interaction.turnId,
				interactionId: interaction.interactionId,
				actionId,
				stateRevision: state.revision,
				draft: {
					text: request.text,
					images: [...request.images],
					files: [...request.files],
					...(semanticInput === undefined ? {} : { semanticInput: request.semanticInput }),
				},
			}),
		)
		return Empty.create()
	} catch (error) {
		Logger.error("Error in askResponse handler:", error)
		throw error
	}
}
