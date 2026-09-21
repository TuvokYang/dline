import { Empty, StringRequest } from "@shared/proto/dline/common"
import { WebviewProviderRegistry } from "@/core/webview/WebviewProviderRegistry"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../index"
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

/**
 * Opens an existing task from history in a new Editor Tab window.
 * The task is loaded from history and displayed in a separate panel,
 * leaving the sidebar unaffected.
 *
 * If an existing idle panel is available (no active task), it will be reused.
 *
 * @param controller The current controller (used to access history)
 * @param request Contains the task ID to open
 */
export async function openTaskInNewWindow(controller: Controller, request: StringRequest): Promise<Empty> {
	const taskId = request.value
	if (!taskId) {
		Logger.warn("[openTaskInNewWindow] No task ID provided")
		return Empty.create()
	}

	try {
		// Dynamically import to avoid circular deps at module load time
		const { VscodeWebviewPanelProvider } = await import("@/hosts/vscode/VscodeWebviewPanelProvider")
		// Prefer the already loaded history metadata. Falling back to getTaskWithId
		// parses the complete API history, which is unnecessary for panel display.
		const historyItem =
			controller.stateManager.getGlobalStateKey("taskHistory").find((item) => item.id === taskId) ??
			(await controller.getTaskWithId(taskId)).historyItem
		const title = historyItem.task || "Dline"

		// Try to reuse an existing idle panel (has controller but no active task)
		let panelProvider: any
		const existingPanels = WebviewProviderRegistry.getPanels()
		for (const panel of existingPanels) {
			if (
				panel instanceof VscodeWebviewPanelProvider &&
				panel.hasController() &&
				!panel.controller.hasActiveTaskSurface()
			) {
				panelProvider = panel
				break
			}
		}

		if (panelProvider) {
			// Reuse existing panel
			panelProvider.ensureController()
			panelProvider.setPendingTaskId(taskId)
			panelProvider.updateTitle(title)
			void panelProvider.controller
				.initTask(undefined, undefined, undefined, historyItem, undefined, {
					onHistoryTaskReadyToDisplay: () => sendChatButtonClickedEvent(panelProvider.controller),
				})
				.then(() => {
					Logger.log(`[openTaskInNewWindow] Task ${taskId} reopened in existing panel`)
				})
				.catch((error: unknown) => {
					Logger.error(`[openTaskInNewWindow] Failed to initialize task ${taskId} in existing panel:`, error)
				})
		} else {
			// Create a new panel with the task title
			panelProvider = new VscodeWebviewPanelProvider(controller.context, { deferController: false })
			await panelProvider.createPanel(title)
			panelProvider.setPendingTaskId(taskId)

			// Initialize the task from history
			void panelProvider.controller
				.initTask(undefined, undefined, undefined, historyItem, undefined, {
					onHistoryTaskReadyToDisplay: () => sendChatButtonClickedEvent(panelProvider.controller),
				})
				.then(() => {
					Logger.log(`[openTaskInNewWindow] Task ${taskId} opened in new panel`)
				})
				.catch((error: unknown) => {
					Logger.error(`[openTaskInNewWindow] Failed to initialize task ${taskId} in new panel:`, error)
				})
		}
	} catch (error) {
		Logger.error(`[openTaskInNewWindow] Failed to open task ${taskId}:`, error)
	}

	return Empty.create()
}
