import { Empty } from "@shared/proto/dline/common"
import { AskResponseRequest, DispatchInteractionRequest } from "@shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { dispatchInteraction } from "./dispatchInteraction"

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
		const state = session.state()
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
				},
			}),
		)
		return Empty.create()
	} catch (error) {
		Logger.error("Error in askResponse handler:", error)
		throw error
	}
}
