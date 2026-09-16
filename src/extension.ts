// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import { DIFF_VIEW_URI_SCHEME } from "@hosts/vscode/VscodeDiffViewProvider"
import { envFlagEnabled } from "@shared/env"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { sendAccountButtonClickedEvent } from "./core/controller/ui/subscribeToAccountButtonClicked"
import { sendChatButtonClickedEvent } from "./core/controller/ui/subscribeToChatButtonClicked"
import { sendHistoryButtonClickedEvent } from "./core/controller/ui/subscribeToHistoryButtonClicked"
import { sendMcpButtonClickedEvent } from "./core/controller/ui/subscribeToMcpButtonClicked"
import { sendSettingsButtonClickedEvent } from "./core/controller/ui/subscribeToSettingsButtonClicked"
import { sendWorktreesButtonClickedEvent } from "./core/controller/ui/subscribeToWorktreesButtonClicked"
import { WebviewProvider } from "./core/webview"
import { registerExtensionReloadWatcher } from "./dev/ExtensionReloadWatcher"
import { createClineAPI } from "./exports"
import { initializeTestMode } from "./services/test/TestMode"
import "./utils/path" // necessary to have access to String.prototype.toPosix
import fs from "node:fs/promises"
import path from "node:path"
import type { ExtensionContext } from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { vscodeHostBridgeClient } from "@/hosts/vscode/hostbridge/client/host-grpc-client"
import { hasClineToDlineMigrationCandidates, migrateFromClineToDline } from "@/shared/services/migration"
import { createStorageContext } from "@/shared/storage/storage-context"
import { readTextFromClipboard, writeTextToClipboard } from "@/utils/env"
import { initialize, tearDown } from "./common"
import { addToCline } from "./core/controller/commands/addToCline"
import { explainWithCline } from "./core/controller/commands/explainWithCline"
import { fixWithCline } from "./core/controller/commands/fixWithCline"
import { improveWithCline } from "./core/controller/commands/improveWithCline"
import { sendAddToInputEvent } from "./core/controller/ui/subscribeToAddToInput"
import { sendShowWebviewEvent } from "./core/controller/ui/subscribeToShowWebview"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import { OrchestratorController } from "./core/orchestrator/OrchestratorController"
import {
	cleanupMcpMarketplaceCatalogFromGlobalState,
	cleanupOldApiKey,
	migrateCustomInstructionsToGlobalRules,
	migrateWelcomeViewCompleted,
	migrateWorkspaceToGlobalStorage,
} from "./core/storage/state-migrations"
import { workspaceResolver } from "./core/workspace"
import { findMatchingNotebookCell, getContextForCommand, showWebview } from "./hosts/vscode/commandUtils"
import { abortCommitGeneration, generateCommitMsg } from "./hosts/vscode/commit-message-generator"
import { registerClineOutputChannel } from "./hosts/vscode/hostbridge/env/debugLog"
import {
	disposeVscodeCommentReviewController,
	getVscodeCommentReviewController,
} from "./hosts/vscode/review/VscodeCommentReviewController"
import { VscodeTerminalManager } from "./hosts/vscode/terminal/VscodeTerminalManager"
import { VscodeTerminalPool } from "./hosts/vscode/terminal/VscodeTerminalPool"
import { DefaultVscodeTerminalPoolRuntime } from "./hosts/vscode/terminal/VscodeTerminalPoolRuntime"
import { VscodeWindowsProcessTreeProvider } from "./hosts/vscode/terminal/VscodeWindowsProcessTreeProvider"
import { VscodeDiffViewProvider } from "./hosts/vscode/VscodeDiffViewProvider"
import { VscodeWebviewProvider } from "./hosts/vscode/VscodeWebviewProvider"
import { exportVSCodeStorageToSharedFiles } from "./hosts/vscode/vscode-to-file-migration"
import { ExtensionRegistryInfo } from "./registry"
import { AuthService } from "./services/auth/AuthService"
import { LogoutReason } from "./services/auth/types"
import { DlineRuntimeFileManager } from "./services/runtime-files"
import { telemetryService } from "./services/telemetry"
import { recordPerfPhase } from "./services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "./services/telemetry/instrumentation/perf-domains"
import { SharedUriHandler, TASK_URI_PATH } from "./services/uri/SharedUriHandler"
import { ShowMessageType } from "./shared/proto/dline/host/window"
import { fileExistsAtPath } from "./utils/fs"

const RELOAD_WINDOW_ACTION = "Reload Window"
const RELOAD_WINDOW_PROMPT_VERSION_KEY = "dlineReloadWindowPromptVersion"

// This method is called when the VS Code extension is activated.
// NOTE: This is VS Code specific - services that should be registered
// for all-platform should be registered in common.ts.
export async function activate(context: vscode.ExtensionContext) {
	const activationStartTime = performance.now()
	// Each step records its own elapsed offset so a slow startup can be
	// attributed to a stage without needing debug logging to be enabled.
	const recordActivationStage = (stage: string): number => {
		const elapsedMs = performance.now() - activationStartTime
		recordPerfPhase(PerfDomain.Activation, "stage", elapsedMs, { stage, entry: "extension_activate" })
		return elapsedMs
	}
	Logger.debug("[Dline] extension activate: start")

	// 1. Set up HostProvider for VSCode
	// IMPORTANT: This must be done before any service can be registered
	{
		const elapsedMs = recordActivationStage("setupHostProvider")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: setupHostProvider +${Math.round(elapsedMs)}ms`)
		}
	}
	setupHostProvider(context)
	if (IS_DEV && !IS_E2E && DEV_WORKSPACE_FOLDER) {
		registerExtensionReloadWatcher(context, DEV_WORKSPACE_FOLDER)
	}
	const webview = HostProvider.get().createWebviewProvider() as VscodeWebviewProvider
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VscodeWebviewProvider.SIDEBAR_ID, webview, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// 2. Migrate legacy Cline data before Dline cleanup can create target files.
	{
		const elapsedMs = recordActivationStage("beforeMigrate")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: before migrate +${Math.round(elapsedMs)}ms`)
		}
	}
	await migrateFromClineWithProgress(context)
	{
		const elapsedMs = recordActivationStage("afterMigrate")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: after migrate +${Math.round(elapsedMs)}ms`)
		}
	}

	// 3. Clean up legacy data patterns within VSCode's native storage.
	// Must run BEFORE the file export so we copy clean state.
	{
		const elapsedMs = recordActivationStage("beforeCleanupLegacy")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: before cleanupLegacy +${Math.round(elapsedMs)}ms`)
		}
	}
	await cleanupLegacyVSCodeStorage(context)
	{
		const elapsedMs = recordActivationStage("afterCleanupLegacy")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: after cleanupLegacy +${Math.round(elapsedMs)}ms`)
		}
	}

	// 4. One-time export of VSCode's native storage to shared file-backed stores.
	// After this, all platforms (VSCode, CLI, JetBrains) read from ~/.cline/data/.
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	const storageContext = createStorageContext({ workspacePath })
	{
		const elapsedMs = recordActivationStage("beforeExportVSCode")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: before exportVSCode +${Math.round(elapsedMs)}ms`)
		}
	}
	await exportVSCodeStorageToSharedFiles(context, storageContext)
	{
		const elapsedMs = recordActivationStage("afterExportVSCode")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: after exportVSCode +${Math.round(elapsedMs)}ms`)
		}
	}

	// 4. Register services and perform common initialization
	// IMPORTANT: Must be done after host provider is setup and migrations are complete
	{
		const elapsedMs = recordActivationStage("beforeInitialize")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: before initialize +${Math.round(elapsedMs)}ms`)
		}
	}
	await initialize(storageContext)
	{
		const elapsedMs = performance.now() - activationStartTime
		recordPerfPhase(PerfDomain.Activation, "extension_activate", elapsedMs, { stage: "afterInitialize" })
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] extension activate: after initialize +${Math.round(elapsedMs)}ms`)
		}
	}
	if (!webview.hasController()) {
		Logger.error("[Dline] Activation stopped because core storage initialization failed")
		return
	}
	void showReloadWindowPromptIfNeeded(context)

	// 5. Register WebviewPanelSerializer for Editor Tab panel restoration
	// VSCode calls deserializeWebviewPanel when restoring the window with previously-open panels.
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer("dlineTask", {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any) {
				// Dynamic import to avoid circular deps at module load time
				const { VscodeWebviewPanelProvider } = await import("./hosts/vscode/VscodeWebviewPanelProvider")
				await VscodeWebviewPanelProvider.restorePanel(context as any, panel, state)
			},
		}),
	)

	// 6. Register services and commands specific to VS Code
	// Initialize test mode and add disposables to context
	const testModeWatchers = await initializeTestMode(webview)
	context.subscriptions.push(...testModeWatchers)
	if (IS_E2E && process.env.DLINE_E2E_TASK_HISTORY_CONTROL_DIR) {
		const { startTaskHistoryControl } = await import("./test/e2e-control/task-history-control")
		const control = await startTaskHistoryControl(webview.controller, process.env.DLINE_E2E_TASK_HISTORY_CONTROL_DIR)
		context.subscriptions.push({ dispose: () => void control.dispose() })
	}

	// Initialize hook discovery cache for performance optimization
	HookDiscoveryCache.getInstance().initialize(
		context as any, // Adapt VSCode ExtensionContext to generic interface
		(dir: string) => {
			try {
				const pattern = new vscode.RelativePattern(dir, "*")
				const watcher = vscode.workspace.createFileSystemWatcher(pattern)
				// Ensure watcher is disposed when extension is deactivated
				context.subscriptions.push(watcher)
				// Adapt VSCode FileSystemWatcher to generic interface
				return {
					onDidCreate: (listener: () => void) => watcher.onDidCreate(listener),
					onDidChange: (listener: () => void) => watcher.onDidChange(listener),
					onDidDelete: (listener: () => void) => watcher.onDidDelete(listener),
					dispose: () => watcher.dispose(),
				}
			} catch {
				return null
			}
		},
		(callback: () => void) => {
			// Adapt VSCode Disposable to generic interface
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders(callback)
			context.subscriptions.push(disposable)
			return disposable
		},
	)

	// NOTE: Commands must be added to the internal registry before registering them with VSCode
	const { commands } = ExtensionRegistryInfo

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.PlusButton, async () => {
			// Create a new Editor Tab panel for a fresh task.
			// The sidebar and any existing panels are unaffected.
			const { VscodeWebviewPanelProvider } = await import("./hosts/vscode/VscodeWebviewPanelProvider")
			const panelProvider = new VscodeWebviewPanelProvider(context as any, { deferController: false })
			await panelProvider.createPanel("Dline")
			// Push initial state so the new panel shows the welcome/ready UI
			await panelProvider.controller.postStateToWebview()
			await sendChatButtonClickedEvent(panelProvider.controller)
		}),
	)
	const sidebarController = () => OrchestratorController.getInstance().getMainController()
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.McpButton, () => {
			const c = sidebarController()
			if (c) sendMcpButtonClickedEvent(c)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.SettingsButton, () => {
			const c = sidebarController()
			if (c) sendSettingsButtonClickedEvent(c)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.HistoryButton, () => {
			const c = sidebarController()
			if (c) sendHistoryButtonClickedEvent(c)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.AccountButton, () => {
			const c = sidebarController()
			if (c) sendAccountButtonClickedEvent(c)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.WorktreesButton, () => {
			const c = sidebarController()
			if (c) sendWorktreesButtonClickedEvent(c)
		}),
	)

	/*
	We use the text document content provider API to show the left side for diff view by creating a
	virtual document for the original content. This makes it readonly so users know to edit the right
	side if they want to keep their changes.

	- This API allows you to create readonly documents in VSCode from arbitrary sources, and works by
	claiming an uri-scheme for which your provider then returns text contents. The scheme must be
	provided when registering a provider and cannot change afterwards.
	- Note how the provider doesn't create uris for virtual documents - its role is to provide contents
	 given such an uri. In return, content providers are wired into the open document logic so that
	 providers are always considered.
	https://code.visualstudio.com/api/extension-guides/virtual-documents
	*/
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	const handleUri = async (uri: vscode.Uri) => {
		const url = decodeURIComponent(uri.toString())
		const isTaskUri = getUriPath(url) === TASK_URI_PATH

		if (isTaskUri) {
			await openClineSidebarForTaskUri()
		}

		let success = await SharedUriHandler.handleUri(url)

		// Task deeplinks can race with first-time sidebar initialization.
		if (!success && isTaskUri) {
			await openClineSidebarForTaskUri()
			success = await SharedUriHandler.handleUri(url)
		}

		if (!success) {
			Logger.warn("Extension URI handler: Failed to process URI:", uri.toString())
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register size testing commands in development mode
	if (IS_DEV) {
		vscode.commands.executeCommand("setContext", "cline.isDevMode", IS_DEV)
		// Use dynamic import to avoid loading the module in production
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(webview.controller)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("[Dline] Dev mode activated & dev commands registered")
			})
			.catch((error) => {
				Logger.log(`[Dline] Failed to register dev commands: ${error}`)
			})
	}

	// Recover UI messages from API conversation history
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.RecoverUiMessages, async () => {
			try {
				const { recoverUiMessages } = await import("./core/controller/task/recoverUiMessages")
				const controller = OrchestratorController.getInstance().getMainController()
				if (controller) {
					await recoverUiMessages(controller)
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: "UI messages recovered from API history. Reload the task to see changes.",
					})
				} else {
					const taskId = await vscode.window.showInputBox({
						prompt: "Enter the task ID to recover UI messages for",
						placeHolder: "e.g. 1781163362616",
					})
					if (taskId) {
						await recoverUiMessages(null as any, taskId)
						HostProvider.window.showMessage({
							type: ShowMessageType.INFORMATION,
							message: `UI messages recovered for task ${taskId}.`,
						})
					}
				}
			} catch (error) {
				Logger.error("[recoverUiMessages] Failed:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Failed to recover UI messages: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.TerminalOutput, async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// Save current clipboard content
			const tempCopyBuffer = await readTextFromClipboard()

			try {
				// Copy the *existing* terminal selection (without selecting all)
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// Get copied content
				const terminalContents = (await readTextFromClipboard()).trim()

				// Restore original clipboard content
				await writeTextToClipboard(tempCopyBuffer)

				if (!terminalContents) {
					// No terminal content was copied (either nothing selected or some error)
					return
				}
				// Ensure the sidebar view is visible but preserve editor focus
				await showWebview(true)

				await sendAddToInputEvent(webview.controller, `Terminal output:\n\`\`\`\n${terminalContents}\n\`\`\``)

				Logger.log("addSelectedTerminalOutputToChat", terminalContents, terminal.name)
			} catch (error) {
				// Ensure clipboard is restored even if an error occurs
				await writeTextToClipboard(tempCopyBuffer)
				Logger.error("Error getting terminal contents:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to get terminal contents",
				})
			}
		}),
	)

	// Register code action provider
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

				provideCodeActions(
					document: vscode.TextDocument,
					range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					const CONTEXT_LINES_TO_EXPAND = 3
					const START_OF_LINE_CHAR_INDEX = 0
					const LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING = 1

					const actions: vscode.CodeAction[] = []
					const editor = vscode.window.activeTextEditor // Get active editor for selection check

					// Expand range to include surrounding 3 lines or use selection if broader
					const selection = editor?.selection
					let expandedRange = range
					if (
						editor &&
						selection &&
						!selection.isEmpty &&
						selection.contains(range.start) &&
						selection.contains(range.end)
					) {
						expandedRange = selection
					} else {
						expandedRange = new vscode.Range(
							Math.max(0, range.start.line - CONTEXT_LINES_TO_EXPAND),
							START_OF_LINE_CHAR_INDEX,
							Math.min(
								document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
								range.end.line + CONTEXT_LINES_TO_EXPAND,
							),
							document.lineAt(
								Math.min(
									document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
									range.end.line + CONTEXT_LINES_TO_EXPAND,
								),
							).text.length,
						)
					}

					// Add to Dline (Always available)
					const addAction = new vscode.CodeAction("Add to Dline", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: commands.AddToChat,
						title: "Add to Dline",
						arguments: [expandedRange, context.diagnostics],
					}
					actions.push(addAction)

					// Explain with Dline (Always available)
					const explainAction = new vscode.CodeAction("Explain with Dline", vscode.CodeActionKind.RefactorExtract) // Using a refactor kind
					explainAction.command = {
						command: commands.ExplainCode,
						title: "Explain with Dline",
						arguments: [expandedRange],
					}
					actions.push(explainAction)

					// Improve with Cline (Always available)
					const improveAction = new vscode.CodeAction("Improve with Dline", vscode.CodeActionKind.RefactorRewrite) // Using a refactor kind
					improveAction.command = {
						command: commands.ImproveCode,
						title: "Improve with Dline",
						arguments: [expandedRange],
					}
					actions.push(improveAction)

					// Fix with Dline (Only if diagnostics exist)
					if (context.diagnostics.length > 0) {
						const fixAction = new vscode.CodeAction("Fix with Dline", vscode.CodeActionKind.QuickFix)
						fixAction.isPreferred = true
						fixAction.command = {
							command: commands.FixWithCline,
							title: "Fix with Dline",
							arguments: [expandedRange, context.diagnostics],
						}
						actions.push(fixAction)
					}
					return actions
				}
			})(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.RefactorExtract,
					vscode.CodeActionKind.RefactorRewrite,
				],
			},
		),
	)

	// Register the command handlers
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.AddToChat, async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics, { panelTitle: "Add to Dline" })
			if (!context) {
				return
			}
			await addToCline(context.controller, context.commandContext, undefined, {
				startTask: context.surface === "panel",
			})
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FixWithCline, async (range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics, { panelTitle: "Fix with Dline" })
			if (!context) {
				return
			}
			await fixWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ExplainCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range, undefined, { panelTitle: "Explain with Dline" })
			if (!context) {
				return
			}
			await explainWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ImproveCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range, undefined, { panelTitle: "Improve with Dline" })
			if (!context) {
				return
			}
			await improveWithCline(context.controller, context.commandContext)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FocusChatInput, async (preserveEditorFocus = false) => {
			const webview = WebviewProvider.getVisibleInstance() ?? WebviewProvider.getInstance()
			if (!webview) {
				Logger.warn("[Dline] FocusChatInput: no WebviewProvider instance available")
				return
			}

			// Only sidebar providers have getWebview(); editor panel providers
			// use getPanel() instead. Avoid calling getWebview() on the wrong
			// type, which would throw TypeError.
			if (!(webview instanceof VscodeWebviewProvider)) {
				Logger.warn("[Dline] FocusChatInput: WebviewProvider instance is not a sidebar provider")
				return
			}
			const webviewView = webview.getWebview()
			if (webviewView) {
				if (preserveEditorFocus) {
					// Only make webview visible without forcing focus
					webviewView.show(false)
				} else {
					// Show and force focus (default behavior for explicit focus actions)
					webviewView.show(true)
				}
			}

			// Send show webview event with preserveEditorFocus flag
			sendShowWebviewEvent(webview.controller, preserveEditorFocus)
			telemetryService.captureButtonClick("command_focusChatInput", webview.controller?.task?.ulid)
		}),
	)

	// Register Jupyter Notebook command handlers
	const NOTEBOOK_EDIT_INSTRUCTIONS = `Special considerations for using replace_in_file on *.ipynb files:
* Jupyter notebook files are JSON format with specific structure for source code cells
* Source code in cells is stored as JSON string arrays ending with explicit \\n characters and commas
* Always match the exact JSON format including quotes, commas, and escaped newlines.`

	// Helper to get notebook context for Jupyter commands
	async function getNotebookCommandContext(range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) {
		const activeNotebook = vscode.window.activeNotebookEditor
		if (!activeNotebook) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No active Jupyter notebook found. Please open a .ipynb file first.",
			})
			return null
		}

		const ctx = await getContextForCommand(range, diagnostics, { reuseBusySidebar: true })
		if (!ctx) {
			return null
		}

		const filePath = ctx.commandContext.filePath || ""
		let cellJson: string | null = null
		if (activeNotebook.notebook.cellCount > 0) {
			const cellIndex = activeNotebook.notebook.cellAt(activeNotebook.selection.start).index
			cellJson = await findMatchingNotebookCell(filePath, cellIndex)
		}

		return { ...ctx, cellJson }
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterGenerateCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Generate Notebook Cell",
					"Enter your prompt for generating notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
Insert a new Jupyter notebook cell above or below the current cell based on user prompt.
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await addToCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterExplainCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = ctx.cellJson
					? `\n\nCurrent Notebook Cell Context (JSON, sanitized of image data):\n\`\`\`json\n${ctx.cellJson}\n\`\`\``
					: undefined

				await explainWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterImproveCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Improve Notebook Cell",
					"Enter your prompt for improving the current notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await improveWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	// Register the openWalkthrough command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.Walkthrough, async () => {
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#DlineWalkthrough`)
			telemetryService.captureButtonClick("command_openWalkthrough")
		}),
	)

	// Register the reconstructTaskHistory command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ReconstructTaskHistory, async () => {
			const { reconstructTaskHistory } = await import("./core/commands/reconstructTaskHistory")
			await reconstructTaskHistory()
			telemetryService.captureButtonClick("command_reconstructTaskHistory")
		}),
	)

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.GenerateCommit, async (scm) => {
			generateCommitMsg(webview.controller, scm)
		}),
		vscode.commands.registerCommand(commands.AbortCommit, () => {
			abortCommitGeneration()
		}),
	)

	// Listen for secrets changes (e.g., cross-window login/logout sync)
	const unsubSecrets = storageContext.secrets.onDidChange((event) => {
		if (event.key === "cline:clineAccountId") {
			const secretValue = storageContext.secrets.get<string>(event.key)
			const activeWebview = WebviewProvider.getVisibleInstance()
			const controller = activeWebview?.controller

			const authService = AuthService.getInstance(controller)
			if (secretValue) {
				// Secret was added or updated - restore auth info (login from another window)
				authService?.restoreRefreshTokenAndRetrieveAuthInfo()
			} else {
				// Secret was removed - handle logout for all windows
				authService?.handleDeauth(LogoutReason.CROSS_WINDOW_SYNC)
			}
		}
	})
	context.subscriptions.push({ dispose: unsubSecrets })

	Logger.log(`[Dline] extension activated in ${performance.now() - activationStartTime} ms`)

	return createClineAPI(webview.controller)
}

async function showReloadWindowPromptIfNeeded(context: vscode.ExtensionContext) {
	const currentVersion = ExtensionRegistryInfo.version
	const lastPromptedVersion = context.globalState.get<string>(RELOAD_WINDOW_PROMPT_VERSION_KEY)
	if (lastPromptedVersion === currentVersion) {
		return
	}

	const selected = await vscode.window.showInformationMessage(
		`Dline v${currentVersion} is installed. Reload VS Code to finish activating the extension.`,
		RELOAD_WINDOW_ACTION,
	)
	await context.globalState.update(RELOAD_WINDOW_PROMPT_VERSION_KEY, currentVersion)

	if (selected === RELOAD_WINDOW_ACTION) {
		await vscode.commands.executeCommand("workbench.action.reloadWindow")
	}
}

async function showJupyterPromptInput(title: string, placeholder: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick()
		quickPick.title = title
		quickPick.placeholder = placeholder
		quickPick.ignoreFocusOut = true

		// Allow free text input
		quickPick.canSelectMany = false

		let userInput = ""

		quickPick.onDidChangeValue((value) => {
			userInput = value
			// Update items to show the current input
			if (value) {
				quickPick.items = [
					{
						label: "$(check) Use this prompt",
						detail: value,
						alwaysShow: true,
					},
				]
			} else {
				quickPick.items = []
			}
		})

		quickPick.onDidAccept(() => {
			if (userInput) {
				resolve(userInput)
				quickPick.hide()
			}
		})

		quickPick.onDidHide(() => {
			if (!userInput) {
				resolve(undefined)
			}
			quickPick.dispose()
		})

		quickPick.show()
	})
}

function setupHostProvider(context: ExtensionContext) {
	DlineRuntimeFileManager.initialize()
	DlineRuntimeFileManager.startPeriodicCleanup()
	context.subscriptions.push({ dispose: () => DlineRuntimeFileManager.stopPeriodicCleanup() })
	const outputChannel = registerClineOutputChannel(context)
	outputChannel.appendLine("[Dline] Setting up VS Code host...")

	let webviewProvider: VscodeWebviewProvider | undefined
	const createWebview = () => {
		webviewProvider ??= new VscodeWebviewProvider(context, { deferController: true })
		return webviewProvider
	}
	const createDiffView = () => new VscodeDiffViewProvider()
	const createCommentReview = () => getVscodeCommentReviewController()
	const terminalPool = new VscodeTerminalPool(new DefaultVscodeTerminalPoolRuntime())
	context.subscriptions.push({ dispose: () => terminalPool.dispose() })
	const createTerminalManager = () => new VscodeTerminalManager(terminalPool)
	const windowsProcessTreeProvider =
		process.platform === "win32" ? new VscodeWindowsProcessTreeProvider(vscode.env.appRoot) : undefined

	const getCallbackUrl = async (path: string, _preferredPort?: number) => {
		const scheme = vscode.env.uriScheme || "vscode"
		const callbackUri = vscode.Uri.parse(`${scheme}://${context.extension.id}${path}`)

		if (vscode.env.uiKind === vscode.UIKind.Web) {
			// In VS Code Web (Codespaces, code serve-web), vscode:// URIs redirect to the
			// desktop app instead of staying in the browser. Use asExternalUri to convert
			// to a web-reachable HTTPS URL that routes back to the extension's URI handler.
			const externalUri = await vscode.env.asExternalUri(callbackUri)
			return externalUri.toString(true)
		}

		// In regular desktop VS Code, use the vscode:// URI protocol handler directly.
		return callbackUri.toString(true)
	}
	HostProvider.initialize(
		createWebview,
		createDiffView,
		createCommentReview,
		createTerminalManager,
		vscodeHostBridgeClient,
		() => {}, // No-op logger, logging is handled via HostProvider.env.debugLog
		getCallbackUrl,
		getBinaryLocation,
		context.extensionUri.fsPath,
		context.globalStorageUri.fsPath,
		windowsProcessTreeProvider,
	)
}

function getUriPath(url: string): string | undefined {
	try {
		return new URL(url).pathname
	} catch {
		return undefined
	}
}

async function openClineSidebarForTaskUri(): Promise<void> {
	const sidebarWaitTimeoutMs = 3000
	const sidebarWaitIntervalMs = 50

	await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)

	const startedAt = Date.now()
	while (Date.now() - startedAt < sidebarWaitTimeoutMs) {
		if (WebviewProvider.getVisibleInstance()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, sidebarWaitIntervalMs))
	}

	Logger.warn("Task URI handling timed out waiting for Cline sidebar visibility")
}

async function getBinaryLocation(name: string): Promise<string> {
	// The only binary currently supported is the rg binary from the VSCode installation.
	if (!name.startsWith("rg")) {
		throw new Error(`Binary '${name}' is not supported`)
	}

	// Package folders to search for the ripgrep binary, relative to appRoot
	// @vscode/ripgrep-universal stores binaries under bin/<platform>/ (e.g. bin/win32-x64/)
	const platformDir = `${process.platform}-${process.arch}`
	const rgPkgFolders = [
		"node_modules/@vscode/ripgrep/bin/",
		"node_modules/vscode-ripgrep/bin",
		`node_modules/@vscode/ripgrep-universal/bin/${platformDir}/`,
		"node_modules.asar.unpacked/vscode-ripgrep/bin/",
		"node_modules.asar.unpacked/@vscode/ripgrep/bin/",
		`node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/${platformDir}/`,
	]

	// Check if the binary exists under a given root path
	const checkPath = async (root: string, pkgFolder: string) => {
		const fullPathResult = workspaceResolver.resolveWorkspacePath(
			root,
			path.join(pkgFolder, name),
			"Services.ripgrep.getBinPath",
		)
		const fullPath = typeof fullPathResult === "string" ? fullPathResult : fullPathResult.absolutePath
		return (await fileExistsAtPath(fullPath)) ? fullPath : undefined
	}

	// Search all package folders under the appRoot path
	const searchUnderRoot = async (root: string): Promise<string | undefined> => {
		for (const pkgFolder of rgPkgFolders) {
			const found = await checkPath(root, pkgFolder)
			if (found) return found
		}
		return undefined
	}

	// 1. Try the standard appRoot path first
	const binPath = await searchUnderRoot(vscode.env.appRoot)
	if (binPath) return binPath

	// 2. Fallback: VSCode 1.123.0+ uses hash-versioned subdirectories (e.g. 0958016b2a/resources/app).
	//    If appRoot is incorrect, search for hash dirs next to the current executable.
	try {
		const execDir = path.dirname(process.execPath)
		const entries = await fs.readdir(execDir, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.isDirectory() && /^[a-f0-9]{8,}$/i.test(entry.name)) {
				const altRoot = path.join(execDir, entry.name, "resources", "app")
				const found = await searchUnderRoot(altRoot)
				if (found) return found
			}
		}
	} catch {
		// Ignore readdir errors (e.g. permission denied) and fall through to error
	}

	throw new Error("Could not find ripgrep binary")
}

// This method is called when your extension is deactivated
export async function deactivate() {
	// Dispose Non-VSCode-specific services
	await tearDown()

	// VSCode-specific services
	disposeVscodeCommentReviewController()
}

const IS_DEV = envFlagEnabled(process.env.IS_DEV)
const IS_E2E = envFlagEnabled(process.env.E2E_TEST)
const DEV_WORKSPACE_FOLDER = process.env.DEV_WORKSPACE_FOLDER

/**
 * Migrate legacy Cline data to Dline paths with VSCode progress notification.
 * Shows a progress indicator only when there is eligible data to migrate.
 */
async function migrateFromClineWithProgress(context: ExtensionContext): Promise<void> {
	if (Logger.skipMigration) {
		Logger.log("[Dline] Migration skipped via SKIP_MIGRATION env var")
		return
	}
	const migrationOptions = {
		legacyVscodeGlobalStoragePaths: getLegacyClineGlobalStoragePaths(context),
	}

	if (!(await hasClineToDlineMigrationCandidates(migrationOptions))) {
		return
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Dline: Migrating legacy Cline data...",
			cancellable: false,
		},
		async (progress) => {
			progress.report({ message: "Copying data into empty Dline locations..." })
			const result = await migrateFromClineToDline(migrationOptions)
			if (result.migrated) {
				const details = result.details.join(", ")
				progress.report({ message: details })
				vscode.window.showInformationMessage(`Dline: Data migrated - ${details}`)
			}
		},
	)
}

function getLegacyClineGlobalStoragePaths(context: ExtensionContext): string[] {
	const currentStoragePath = path.normalize(context.globalStorageUri.fsPath)
	const currentStorageKey = process.platform === "win32" ? currentStoragePath.toLowerCase() : currentStoragePath
	const globalStorageRoot = path.dirname(currentStoragePath)
	const legacyExtensionIds = ["saoudrizwan.claude-dev", "cline.cline"]

	return legacyExtensionIds
		.map((extensionId) => path.join(globalStorageRoot, extensionId))
		.filter((candidatePath) => {
			const candidate = path.normalize(candidatePath)
			const candidateKey = process.platform === "win32" ? candidate.toLowerCase() : candidate
			return candidateKey !== currentStorageKey
		})
}

// VSCode-specific storage migrations
const LEGACY_VSCODE_STORAGE_MIGRATION_VERSION = 1
const LEGACY_VSCODE_STORAGE_MIGRATION_VERSION_KEY = "__legacyVSCodeStorageMigrationVersion"

async function cleanupLegacyVSCodeStorage(context: ExtensionContext): Promise<void> {
	try {
		await cleanupOldApiKey(context)
		const migrationVersion = context.globalState.get<number>(LEGACY_VSCODE_STORAGE_MIGRATION_VERSION_KEY)
		if (migrationVersion !== undefined && migrationVersion >= LEGACY_VSCODE_STORAGE_MIGRATION_VERSION) {
			return
		}

		Logger.info("[VS Code Storage Migrations] Starting")

		// Migrate custom instructions to global Cline rules (one-time cleanup)
		await migrateCustomInstructionsToGlobalRules(context)

		// Migrate welcomeViewCompleted setting based on existing API keys (one-time cleanup)
		await migrateWelcomeViewCompleted(context)

		// Migrate workspace storage values back to global storage (reverting previous migration)
		await migrateWorkspaceToGlobalStorage(context)

		// Clean up MCP marketplace catalog from global state (moved to disk cache)
		await cleanupMcpMarketplaceCatalogFromGlobalState(context)

		await context.globalState.update(LEGACY_VSCODE_STORAGE_MIGRATION_VERSION_KEY, LEGACY_VSCODE_STORAGE_MIGRATION_VERSION)

		Logger.info("[VS Code Storage Migrations] Completed")
	} catch (error) {
		Logger.warn(`[VS Code Storage Migrations] Failed${error instanceof Error ? `: ${error.message}` : ""}`)
	}
}
