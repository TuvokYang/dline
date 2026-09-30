import type { Controller } from ".."

/** Read admission depends on the opened Task, never on whether it is working. */
export function getOpenedTask(controller: Controller, request: { taskId: string; taskInstanceId: string }) {
	const task = controller.task
	return task && request.taskInstanceId && task.taskId === request.taskId && task.taskInstanceId === request.taskInstanceId
		? task
		: undefined
}
