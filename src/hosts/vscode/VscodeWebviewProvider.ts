import { sendShowWebviewEvent } from "@core/controller/ui/subscribeToShowWebview"
import { shouldUseWebviewHmr, WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { ClineExtensionContext } from "@/shared/cline"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class VscodeWebviewProvider extends WebviewProvider implements vscode.WebviewViewProvider {
	// Used in package.json as the view's id. This value cannot be changed due to how vscode caches
	// views based on their id, and updating the id would break existing instances of the extension.
	public static readonly SIDEBAR_ID = ExtensionRegistryInfo.views.Sidebar

	private webview?: vscode.WebviewView
	private readonly providerDisposables: vscode.Disposable[] = []
	private viewDisposables: vscode.Disposable[] = []
	private viewGeneration = 0

	constructor(context: ClineExtensionContext, options?: { deferController?: boolean }) {
		super(context, { ...options, isSidebar: true })
		vscode.workspace.onDidChangeConfiguration(
			async (event) => {
				if (event?.affectsConfiguration("cline.mcpMarketplace.enabled")) {
					const controller = await this.controllerReady
					await controller.postStateToWebview()
				}
			},
			null,
			this.providerDisposables,
		)
	}

	override getWebviewUrl(path: string) {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		const uri = this.webview.webview.asWebviewUri(vscode.Uri.file(path))
		return uri.toString()
	}

	override getCspSource() {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		return this.webview.webview.cspSource
	}

	override isVisible() {
		return this.webview?.visible || false
	}

	public getWebview(): vscode.WebviewView | undefined {
		return this.webview
	}

	/**
	 * Initializes and sets up the webview when it's first created.
	 *
	 * @param webviewView - The sidebar webview view instance to be resolved
	 * @returns A promise that resolves when the webview has been fully initialized
	 */
	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		// One provider outlives multiple WebviewView instances. Release only the
		// previous view bindings; the Controller and provider-level listeners live on.
		this.disposeViewBindings()
		const generation = ++this.viewGeneration
		const viewDisposables: vscode.Disposable[] = []
		this.viewDisposables = viewDisposables
		this.webview = webviewView

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		const controller = await this.startupReady
		if (!this.isActiveView(webviewView, generation)) return
		if (!controller) {
			webviewView.webview.html = this.getStartupFailureHtml()
			Logger.error("[VscodeWebviewProvider] Rendering storage initialization failure view", this.getStartupFailure())
			return
		}
		controller.setAccountUsagePollingEnabled(webviewView.visible)

		// Register before assigning HTML because cached/HMR webviews can post
		// webviewReady and initial gRPC subscriptions during navigation.
		this.setWebviewMessageListener(webviewView.webview, webviewView, generation, viewDisposables)

		webviewView.webview.html = shouldUseWebviewHmr(this.context.extensionMode)
			? await this.getHMRHtmlContent()
			: this.getHtmlContent()

		// Logs show up in bottom panel > Debug Console
		//Logger.log("registering listener")

		// Listen for when the sidebar becomes visible
		// https://github.com/microsoft/vscode-discussions/discussions/840

		// onDidChangeVisibility is only available on the sidebar webview
		// Otherwise WebviewView and WebviewPanel have all the same properties except for this visibility listener
		// WebviewPanel is not currently used in the extension
		webviewView.onDidChangeVisibility(
			async () => {
				if (!this.isActiveView(webviewView, generation)) return
				const controller = await this.controllerReady
				controller.setAccountUsagePollingEnabled(this.webview?.visible ?? false)
				if (this.webview?.visible) {
					// View becoming visible should not steal editor focus.
					await sendShowWebviewEvent(controller, true)
				}
			},
			null,
			viewDisposables,
		)

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is moved to another container.
		// Only clean UI bindings — the Controller and task should continue running.
		webviewView.onDidDispose(
			() => {
				if (this.webview !== webviewView || this.viewGeneration !== generation) return
				void this.controllerReady.then((controller) => controller.setAccountUsagePollingEnabled(false))
				this.webview = undefined
				this.disposeViewBindings()
			},
			null,
			viewDisposables,
		)

		// Push current state to the newly created webview for UI sync.
		// DO NOT clear task — the task should survive webview disposal/recreation.
		if (this.hasController()) {
			const controller = await this.controllerReady
			await controller.postStateToWebview()
		}

		Logger.log("[VscodeWebviewProvider] Webview view resolved")

		// Title setting logic removed to allow VSCode to use the container title primarily.
	}

	private getStartupFailureHtml(): string {
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width,initial-scale=1">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
			<title>Dline startup error</title>
			<style>
				body { padding: 24px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
				h1 { font-size: 18px; }
				p { line-height: 1.5; }
				code { color: var(--vscode-errorForeground); }
			</style>
		</head>
		<body>
			<h1>Dline storage initialization failed</h1>
			<p>Dline stopped before starting tasks or background services because its storage could not be loaded safely.</p>
			<p>Reload VS Code after resolving the storage error. Open <code>Output → Dline</code> for the original diagnostic.</p>
		</body>
		</html>`
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * IMPORTANT: When passing methods as callbacks in JavaScript/TypeScript, the method's
	 * 'this' context can be lost. This happens because the method is passed as a
	 * standalone function reference, detached from its original object.
	 *
	 * The Problem:
	 * Doing: webview.onDidReceiveMessage(this.controller.handleWebviewMessage)
	 * Would cause 'this' inside handleWebviewMessage to be undefined or wrong,
	 * leading to "TypeError: this.setUserInfo is not a function"
	 *
	 * The Solution:
	 * We wrap the method call in an arrow function, which:
	 * 1. Preserves the lexical scope's 'this' binding
	 * 2. Ensures handleWebviewMessage is called as a method on the controller instance
	 * 3. Maintains access to all controller methods and properties
	 *
	 * Alternative solutions could use .bind() or making handleWebviewMessage an arrow
	 * function property, but this approach is clean and explicit.
	 *
	 * @param webview The webview instance to attach the message listener to
	 */
	private setWebviewMessageListener(
		webview: vscode.Webview,
		webviewView: vscode.WebviewView,
		generation: number,
		disposables: vscode.Disposable[],
	) {
		webview.onDidReceiveMessage(
			(message) => {
				if (!this.isActiveView(webviewView, generation)) return
				this.handleWebviewMessage(message)
			},
			null,
			disposables,
		)
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	async handleWebviewMessage(message: WebviewMessage) {
		const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)

		switch (message.type) {
			case "webviewReady": {
				break
			}
			case "grpc_request": {
				if (message.grpc_request) {
					const controller = await this.controllerReady
					await handleGrpcRequest(controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			default: {
				Logger.error("Received unhandled WebviewMessage type:", JSON.stringify(message))
			}
		}
	}

	/**
	 * Sends a message from the extension to the webview.
	 *
	 * @param message - The message to send to the webview
	 * @returns A thenable that resolves to a boolean indicating success, or undefined if the webview is not available
	 */
	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		const webview = this.webview
		const generation = this.viewGeneration
		if (!webview) {
			Logger.warn("[VscodeWebviewProvider] Webview message delivery skipped", {
				reason: "no_active_view",
				messageType: message.type,
				generation,
			})
			return undefined
		}
		const delivered = await webview.webview.postMessage(message)
		if (!delivered) {
			Logger.warn("[VscodeWebviewProvider] Webview message delivery failed", {
				reason: "post_message_rejected",
				messageType: message.type,
				generation,
			})
		}
		return delivered
	}

	private isActiveView(webviewView: vscode.WebviewView, generation: number): boolean {
		return this.webview === webviewView && this.viewGeneration === generation
	}

	private disposeViewBindings(): void {
		while (this.viewDisposables.length) this.viewDisposables.pop()?.dispose()
	}

	override async dispose() {
		this.disposeViewBindings()
		while (this.providerDisposables.length) this.providerDisposables.pop()?.dispose()
		this.webview = undefined
		// Await parent dispose so Controller.clearTask() → terminate()
		// completes before the webview is fully torn down. Without await,
		// the async dispose chain is fire-and-forget and errors / resource
		// leaks may go undetected.
		await super.dispose()
	}
}
