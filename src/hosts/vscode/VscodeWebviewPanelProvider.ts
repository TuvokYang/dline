import { shouldUseWebviewHmr, WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { OrchestratorController } from "@/core/orchestrator/OrchestratorController"
import { normalizeTaskPanelTitle } from "@/core/task/TaskPanelTitle"
import { HostProvider } from "@/hosts/host-provider"
import type { ClineExtensionContext } from "@/shared/cline"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import type { WebviewMessage } from "@/shared/WebviewMessage"
import { dlineEditorGroup } from "./DlineEditorGroup"

/**
 * Shape of the state persisted via acquireVsCodeApi().setState() inside the webview.
 * VSCode automatically serializes/deserializes this across window reloads
 * and passes it to WebviewPanelSerializer.deserializeWebviewPanel.
 */
interface PanelState {
	taskId: string
}

/**
 * WebviewProvider implementation that renders inside a VSCode Editor Tab
 * via vscode.window.createWebviewPanel.
 *
 * Each panel has its own Controller and Task, fully independent from the sidebar.
 * Panel close = task disposal.
 */
export class VscodeWebviewPanelProvider extends WebviewProvider {
	private panel?: vscode.WebviewPanel
	private disposables: vscode.Disposable[] = []
	private pendingTaskId?: string
	private isWebviewReady = false

	/**
	 * Creates a new Editor Tab panel and initializes it.
	 * Must be called after construction to actually show the panel.
	 *
	 * @param title - Panel tab title
	 */
	async createPanel(title: string): Promise<void> {
		const extUri = vscode.Uri.file(HostProvider.get().extensionFsPath)
		const iconPath = vscode.Uri.joinPath(vscode.Uri.file(HostProvider.get().extensionFsPath), "assets", "icons", "icon.png")

		const panel = vscode.window.createWebviewPanel(
			"dlineTask",
			normalizeTaskPanelTitle(title),
			{ viewColumn: dlineEditorGroup.getCreateViewColumn(), preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extUri],
			},
		)
		this.panel = panel
		panel.iconPath = iconPath
		dlineEditorGroup.register(panel)
		this.registerPanelVisibilityListener(panel)

		// Register message listener BEFORE setting HTML to avoid missing
		// early webviewReady messages from fast-loading webview bundles.
		this.setWebviewMessageListener(panel.webview)

		panel.webview.html = shouldUseWebviewHmr(this.context.extensionMode)
			? await this.getHMRHtmlContent()
			: this.getHtmlContent()

		// Notify orchestrator of new panel
		OrchestratorController.getInstance().onPanelCreated()

		// Dispose self when panel is closed
		panel.onDidDispose(
			() => {
				this.controller.detachUi()
				dlineEditorGroup.unregister(panel)
				this.isWebviewReady = false
				this.pendingTaskId = undefined
				this.panel = undefined
				while (this.disposables.length) {
					this.disposables.pop()?.dispose()
				}
				OrchestratorController.getInstance().onPanelDisposed()
				void this.dispose()
			},
			null,
			this.disposables,
		)

		// A panel opened for a new task legitimately has no task id yet; the id
		// arrives later through setPendingTaskId. Printing the raw value made
		// that ordinary case read as `undefined` and look like the defect being
		// investigated, so the two cases are named instead.
		Logger.debug(
			this.pendingTaskId === undefined
				? "[VscodeWebviewPanelProvider] Panel created for a new task; task id pending"
				: `[VscodeWebviewPanelProvider] Panel created for task ${this.pendingTaskId}`,
		)
	}

	/**
	 * Restores a panel that VSCode automatically recreates after a window reload.
	 * Called by the WebviewPanelSerializer registered in extension.ts.
	 */
	static async restorePanel(context: ClineExtensionContext, panel: vscode.WebviewPanel, state: PanelState): Promise<void> {
		Logger.debug(`[VscodeWebviewPanelProvider] restorePanel called, taskId=${state?.taskId ?? "none"}`)
		const provider = new VscodeWebviewPanelProvider(context, { deferController: false })
		provider.panel = panel
		dlineEditorGroup.register(panel)
		provider.registerPanelVisibilityListener(panel)

		// Register listener BEFORE HTML
		provider.setWebviewMessageListener(panel.webview)

		panel.webview.html = shouldUseWebviewHmr(context.extensionMode)
			? await provider.getHMRHtmlContent()
			: provider.getHtmlContent()

		// Notify orchestrator
		OrchestratorController.getInstance().onPanelCreated()

		panel.onDidDispose(
			() => {
				provider.controller.detachUi()
				dlineEditorGroup.unregister(panel)
				provider.isWebviewReady = false
				provider.pendingTaskId = undefined
				provider.panel = undefined
				while (provider.disposables.length) {
					provider.disposables.pop()?.dispose()
				}
				OrchestratorController.getInstance().onPanelDisposed()
				void provider.dispose()
			},
			null,
			provider.disposables,
		)

		const taskId = state?.taskId
		if (!taskId) {
			panel.title = "Dline"
			await provider.controller.postStateToWebview()
			const { sendChatButtonClickedEvent } = await import("@/core/controller/ui/subscribeToChatButtonClicked")
			await sendChatButtonClickedEvent(provider.controller)
			Logger.log("[VscodeWebviewPanelProvider] Restored panel without task (blank state)")
			return
		}

		Logger.log(`[VscodeWebviewPanelProvider] Restoring panel for task ${taskId}`)
		try {
			const historyItem =
				provider.controller.stateManager.getGlobalStateKey("taskHistory").find((item) => item.id === taskId) ??
				(await provider.controller.getTaskWithId(taskId)).historyItem
			const title = normalizeTaskPanelTitle(historyItem.task || "Dline")
			panel.title = title
			// Persist state on next webviewReady
			provider.setPendingTaskId(taskId)
			const revealRestoredTask = async () => {
				const { sendChatButtonClickedEvent } = await import("@/core/controller/ui/subscribeToChatButtonClicked")
				await sendChatButtonClickedEvent(provider.controller)
			}
			void provider.controller
				.initTask(undefined, undefined, undefined, historyItem, undefined, {
					onHistoryTaskReadyToDisplay: revealRestoredTask,
				})
				.then(() => {
					// The panel title is user task text; only its size is logged.
					Logger.log(`[VscodeWebviewPanelProvider] Task ${taskId} restored in panel: titleChars=${title.length}`)
				})
				.catch(async (error) => {
					Logger.warn(`[VscodeWebviewPanelProvider] Failed to restore task ${taskId}, showing blank state:`, error)
					panel.title = "Dline"
					try {
						await provider.controller.postStateToWebview()
						await revealRestoredTask()
					} catch (revealError) {
						Logger.warn("[VscodeWebviewPanelProvider] Failed to reveal fallback panel state:", revealError)
					}
				})
		} catch (error) {
			Logger.warn(`[VscodeWebviewPanelProvider] Task ${taskId} not found, showing blank state:`, error)
			panel.title = "Dline"
			await provider.controller.postStateToWebview()
			const { sendChatButtonClickedEvent } = await import("@/core/controller/ui/subscribeToChatButtonClicked")
			await sendChatButtonClickedEvent(provider.controller)
		}
	}

	/**
	 * Updates the editor tab title.
	 */
	updateTitle(title: string): void {
		if (this.panel) {
			this.panel.title = normalizeTaskPanelTitle(title)
		}
	}

	/**
	 * Sets the taskId to persist once the webview signals it is ready.
	 * If the webview is already ready, posts immediately.
	 */
	setPendingTaskId(taskId: string): void {
		this.pendingTaskId = taskId
		if (this.isWebviewReady) {
			void this.postPanelState(taskId)
		}
	}

	/**
	 * Clears the persisted panel state. Must be called before task termination
	 * so the pending taskId is not left behind for the next window reload.
	 */
	async clearPanelState(): Promise<void> {
		this.pendingTaskId = undefined
		if (this.panel) {
			const result = await this.panel.webview.postMessage({ type: "dlineClearPanelState" })
			if (!result) {
				Logger.warn("[VscodeWebviewPanelProvider] clearPanelState message not delivered")
			}
		}
	}

	/**
	 * Posts a message to the webview asking it to persist the panel state
	 * via acquireVsCodeApi().setState(). VSCode automatically saves this
	 * and passes it to WebviewPanelSerializer.deserializeWebviewPanel
	 * on next window reload.
	 */
	private async postPanelState(taskId: string): Promise<void> {
		if (!this.panel) return
		try {
			const delivered = await this.panel.webview.postMessage({ type: "dlineSetPanelState", taskId })
			if (delivered) {
				Logger.debug(`[VscodeWebviewPanelProvider] Panel state posted: taskId=${taskId}`)
			} else {
				Logger.warn(`[VscodeWebviewPanelProvider] Panel state postMessage returned false: taskId=${taskId}`)
			}
		} catch (error) {
			Logger.warn(`[VscodeWebviewPanelProvider] Panel state postMessage failed:`, error)
		}
	}

	override getWebviewUrl(path: string): string {
		if (!this.panel) throw new Error("Webview panel not initialized")
		return this.panel.webview.asWebviewUri(vscode.Uri.file(path)).toString()
	}

	override getCspSource(): string {
		if (!this.panel) throw new Error("Webview panel not initialized")
		return this.panel.webview.cspSource
	}

	override isVisible(): boolean {
		return this.panel?.visible ?? false
	}

	getPanel(): vscode.WebviewPanel | undefined {
		return this.panel
	}

	private registerPanelVisibilityListener(panel: vscode.WebviewPanel): void {
		this.controller.setAccountUsagePollingEnabled(panel.visible)
		panel.onDidChangeViewState(
			(event) => {
				dlineEditorGroup.synchronize(event.webviewPanel)
				this.controller.setAccountUsagePollingEnabled(event.webviewPanel.visible)
			},
			null,
			this.disposables,
		)
	}

	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message), null, this.disposables)
	}

	async handleWebviewMessage(message: WebviewMessage) {
		switch (message.type) {
			case "webviewReady": {
				this.isWebviewReady = true
				if (this.pendingTaskId) {
					void this.postPanelState(this.pendingTaskId)
				}
				break
			}
			case "grpc_request": {
				if (message.grpc_request) {
					const controller = await this.controllerReady
					const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)
					await handleGrpcRequest(controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			default: {
				// Every known discriminator is handled above, so TypeScript narrows this
				// branch to never. A malformed runtime payload can still reach it, so read
				// the discriminator defensively. The message body can hold user text; only
				// the discriminator identifies the defect.
				const unhandled: { type?: unknown } = message
				Logger.error(`Received unhandled WebviewMessage type: ${String(unhandled.type)}`)
			}
		}
	}

	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		return this.panel?.webview.postMessage(message)
	}

	override async dispose() {
		this.isWebviewReady = false
		this.pendingTaskId = undefined
		while (this.disposables.length) {
			this.disposables.pop()?.dispose()
		}
		if (this.panel) {
			dlineEditorGroup.unregister(this.panel)
			this.panel.dispose()
		}
		this.panel = undefined
		await super.dispose()
	}
}
