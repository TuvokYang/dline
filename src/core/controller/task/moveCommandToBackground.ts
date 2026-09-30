import { MoveCommandToBackgroundRequest, MoveCommandToBackgroundResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { getOpenedTask } from "./opened-task"

/** Move a foreground command or subagent to explicit background tracking. */
export async function moveCommandToBackground(
	controller: Controller,
	request: MoveCommandToBackgroundRequest,
): Promise<MoveCommandToBackgroundResponse> {
	const task = getOpenedTask(controller, request)
	if (!task || task.isReadOnly() || !request.activityId) {
		return MoveCommandToBackgroundResponse.create({ moved: false })
	}
	const movedCommand = await task.moveCommandToBackground(request.activityId)
	if (movedCommand) return MoveCommandToBackgroundResponse.create({ moved: true })
	if (controller.task !== task || task.isReadOnly()) return MoveCommandToBackgroundResponse.create({ moved: false })
	const movedActivities = await task.activityStore.moveToBackground([request.activityId])
	return MoveCommandToBackgroundResponse.create({ moved: movedActivities.includes(request.activityId) })
}
