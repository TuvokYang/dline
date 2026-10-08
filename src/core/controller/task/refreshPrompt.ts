import type { RefreshPromptRequest, RefreshPromptResponse } from "@shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/**
 * Handle manual system prompt cache refresh for an active task.
 * @param controller Controller instance.
 * @param request Refresh request with task ID.
 * @returns Success status.
 */
export async function refreshPrompt(controller: Controller, request: RefreshPromptRequest): Promise<RefreshPromptResponse> {
	Logger.debug(`[RefreshPrompt] requested taskId=${request.taskId}`)
	const task = controller.task
	if (!task || task.taskId !== request.taskId) {
		Logger.debug(`[RefreshPrompt] rejected taskId=${request.taskId} activeTaskId=${task?.taskId ?? "none"}`)
		return { success: false }
	}
	await task.owners.prompt.refreshManual()
	Logger.debug(`[RefreshPrompt] refreshed taskId=${request.taskId}`)
	return { success: true }
}
