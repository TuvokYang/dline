import { MoveCommandToBackgroundRequest, MoveCommandToBackgroundResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."

/** Move a foreground command or subagent to explicit background tracking. */
export async function moveCommandToBackground(
	controller: Controller,
	request: MoveCommandToBackgroundRequest,
): Promise<MoveCommandToBackgroundResponse> {
	const task = controller.task
	if (!task || task.taskId !== request.taskId || !request.activityId) {
		return MoveCommandToBackgroundResponse.create({ moved: false })
	}
	const movedCommand = await task.owners.commands.requestBackgroundHandoff(request.activityId)
	if (movedCommand) return MoveCommandToBackgroundResponse.create({ moved: true })
	const movedActivities = await task.owners.activities.moveToBackground([request.activityId])
	return MoveCommandToBackgroundResponse.create({ moved: movedActivities.includes(request.activityId) })
}
