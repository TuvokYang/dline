import type { InputQueueMutation } from "@core/task/input-queue/InputQueueMutation"
import { MutateInputQueueRequest, MutateInputQueueResponse } from "@shared/proto/dline/task"
import { Controller } from ".."

/**
 * Translate the proto oneof into the queue's own mutation shape.
 *
 * Only one field is ever set by the transport; anything else is reported as a
 * missing operation by the queue itself rather than being guessed at here.
 */
function toMutation(request: MutateInputQueueRequest): InputQueueMutation {
	return {
		enqueue: request.enqueue,
		toggleMode: request.toggleMode,
		reorder: request.reorder,
		beginEdit: request.beginEdit,
		commitEdit: request.commitEdit,
		cancelEdit: request.cancelEdit,
		remove: request.remove,
	}
}

/**
 * Applies one user-driven change to the current task's input queue.
 *
 * The task id is checked so a change composed against an older task cannot land
 * on whatever task happens to be active now; the queue is per-task state and
 * silently retargeting it would deliver the user's text to the wrong place.
 */
export async function mutateInputQueue(
	controller: Controller,
	request: MutateInputQueueRequest,
): Promise<MutateInputQueueResponse> {
	const task = controller.task
	if (!task || (request.taskId && task.taskId !== request.taskId) || !task.owners.inputQueue) {
		return MutateInputQueueResponse.create({ accepted: false, result: "missing_task" })
	}
	const outcome = await task.owners.inputQueue.mutate(toMutation(request))
	return MutateInputQueueResponse.create(outcome)
}
