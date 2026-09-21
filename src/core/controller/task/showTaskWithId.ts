import { StringRequest } from "@shared/proto/dline/common"
import { TaskResponse } from "@shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

/**
 * Shows a task with the specified ID
 * @param controller The controller instance
 * @param request The request containing the task ID
 * @returns TaskResponse with task details
 */
export async function showTaskWithId(controller: Controller, request: StringRequest): Promise<TaskResponse> {
	try {
		const id = request.value

		let didNavigate = false
		const navigateToHistoryTask = async () => {
			if (didNavigate) return
			didNavigate = true
			await controller.postStateToWebview({ immediate: true })
			await sendChatButtonClickedEvent(controller)
		}
		const revealReadyHistoryTask = async () => {
			didNavigate = true
			await sendChatButtonClickedEvent(controller)
		}

		// First check if task exists in global state for faster access
		const taskHistory = controller.stateManager.getGlobalStateKey("taskHistory")
		const historyItem = taskHistory.find((item) => item.id === id)

		// We need to initialize the task before returning data
		if (historyItem) {
			// Always initialize the task with the history item
			await controller.initTask(undefined, undefined, undefined, historyItem, undefined, {
				onHistoryTaskPreparingToDisplay: navigateToHistoryTask,
				onHistoryTaskReadyToDisplay: revealReadyHistoryTask,
			})
			if (!didNavigate) {
				await sendChatButtonClickedEvent(controller)
			}

			// Return task data for gRPC response
			return TaskResponse.create({
				id: historyItem.id,
				task: historyItem.task || "",
				ts: historyItem.ts || 0,
				isFavorited: historyItem.isFavorited || false,
				size: historyItem.size || 0,
				totalCost: historyItem.totalCost || 0,
				tokensIn: historyItem.tokensIn || 0,
				tokensOut: historyItem.tokensOut || 0,
				cacheWrites: historyItem.cacheWrites || 0,
				cacheReads: historyItem.cacheReads || 0,
				cacheHitRate: historyItem.cacheHitRate || 0,
				currency: historyItem.currency || "",
			})
		}

		// If not in global state, fetch from storage
		const { historyItem: fetchedItem } = await controller.getTaskWithId(id)

		// Initialize the task with the fetched item
		await controller.initTask(undefined, undefined, undefined, fetchedItem, undefined, {
			onHistoryTaskPreparingToDisplay: navigateToHistoryTask,
			onHistoryTaskReadyToDisplay: revealReadyHistoryTask,
		})
		if (!didNavigate) {
			await sendChatButtonClickedEvent(controller)
		}

		return TaskResponse.create({
			id: fetchedItem.id,
			task: fetchedItem.task || "",
			ts: fetchedItem.ts || 0,
			isFavorited: fetchedItem.isFavorited || false,
			size: fetchedItem.size || 0,
			totalCost: fetchedItem.totalCost || 0,
			tokensIn: fetchedItem.tokensIn || 0,
			tokensOut: fetchedItem.tokensOut || 0,
			cacheWrites: fetchedItem.cacheWrites || 0,
			cacheReads: fetchedItem.cacheReads || 0,
			cacheHitRate: fetchedItem.cacheHitRate || 0,
			currency: fetchedItem.currency || "",
		})
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		const stack = error instanceof Error ? error.stack : undefined
		Logger.error(`[showTaskWithId] msg=${msg} stack=${stack}`)
		throw error
	}
}
