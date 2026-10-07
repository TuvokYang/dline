import { MoveCommandToBackgroundRequest, MoveCommandToBackgroundResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { currentOpening } from "./opened-task"

/** Move a foreground command or subagent to explicit background tracking. */
export async function moveCommandToBackground(
	controller: Controller,
	request: MoveCommandToBackgroundRequest,
): Promise<MoveCommandToBackgroundResponse> {
	// Only a running session owns commands; a history display has nothing to move.
	const task = controller.task
	if (!task || currentOpening(controller, request) !== task || !request.activityId) {
		return MoveCommandToBackgroundResponse.create({ moved: false })
	}
	const movedCommand = await task.owners.commands.requestBackgroundHandoff(request.activityId)
	if (movedCommand) return MoveCommandToBackgroundResponse.create({ moved: true })
	if (controller.task !== task) return MoveCommandToBackgroundResponse.create({ moved: false })
	const movedActivities = await task.owners.activities.moveToBackground([request.activityId])
	return MoveCommandToBackgroundResponse.create({ moved: movedActivities.includes(request.activityId) })
}
