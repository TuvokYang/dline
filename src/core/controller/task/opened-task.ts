import type { Controller } from ".."

/** The identity a Webview request echoes for the task surface it was opened against. */
export interface TaskOpeningRequest {
	readonly taskId: string
	readonly taskInstanceId: string
}

/** One opening of a task: the running session, or the read-only history display before it runs. */
export interface TaskOpening {
	readonly taskId: string
	readonly taskInstanceId: string
}

/**
 * The surface a request was opened against, when it is still the current one.
 *
 * Admission depends on the opening, never on whether the task is working. A
 * request from an earlier opening of the same task, from before a reopen or a
 * promotion into the runtime, resolves to undefined.
 */
export function currentOpening(controller: Controller, request: TaskOpeningRequest): TaskOpening | undefined {
	const opening = controller.currentOpening()
	return opening &&
		request.taskInstanceId &&
		opening.taskId === request.taskId &&
		opening.taskInstanceId === request.taskInstanceId
		? opening
		: undefined
}
