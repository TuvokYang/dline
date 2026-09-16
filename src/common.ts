import { WebviewProvider } from "./core/webview"
import "./utils/path" // necessary to have access to String.prototype.toPosix

import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import type { StorageContext } from "@/shared/storage/storage-context"
import { FileContextTracker } from "./core/context/context-tracking/FileContextTracker"
import { flushAllWorkspaceHistoryManagers } from "./core/controller/history/WorkspaceHistoryManager"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import { HookProcessRegistry } from "./core/hooks/HookProcessRegistry"
import { ModelRegistry } from "./core/model-registry/ModelRegistry"
import { ensureSeedProviders } from "./core/model-registry/seed-initializer"
import { StateManager } from "./core/storage/StateManager"
import { AgentConfigLoader } from "./core/task/tools/subagent/AgentConfigLoader"
import { ExtensionRegistryInfo } from "./registry"
import { ErrorService } from "./services/error"
import { featureFlagsService } from "./services/feature-flags"
import { getDistinctId } from "./services/logging/distinctId"
import { DlineRuntimeFileManager } from "./services/runtime-files"
import { disposeTelemetryService, telemetryService } from "./services/telemetry"
import { recordPerfPhase } from "./services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "./services/telemetry/instrumentation/perf-domains"
import { PostHogClientProvider } from "./services/telemetry/providers/posthog/PostHogClientProvider"
import { activateRuntimeTelemetry, deactivateRuntimeTelemetry } from "./services/telemetry/runtime/activation"
import { getRuntimeTelemetryLifecycle } from "./services/telemetry/runtime/host"
import { forwardRuntimeEvent } from "./services/telemetry/runtime/provider-event-bridge"
import { cleanupTestMode } from "./services/test/TestMode"
import { ShowMessageType } from "./shared/proto/dline/host/window"
import { syncWorker } from "./shared/services/worker/sync"
import { getBlobStoreSettingsFromEnv } from "./shared/services/worker/worker"
import { getLatestAnnouncementId } from "./utils/announcements"
import { arePathsEqual } from "./utils/path"

/**
 * Performs intialization for Cline that is common to all platforms.
 *
 * @param context
 * @returns The webview provider
 * @throws ClineConfigurationError if endpoints.json exists but is invalid
 */
export async function initialize(storageContext: StorageContext): Promise<WebviewProvider> {
	const initStart = performance.now()
	// Mirrors the extension activate path: every step publishes its elapsed
	// offset so a slow initialization is attributable without debug logging.
	const recordInitStage = (stage: string): number => {
		const elapsedMs = performance.now() - initStart
		recordPerfPhase(PerfDomain.Activation, "stage", elapsedMs, { stage, entry: "common_initialize" })
		return elapsedMs
	}
	Logger.debug("[Dline] common.initialize: start")
	// Configure the shared Logging class to use HostProvider's output channels and debug logger
	{
		const elapsedMs = recordInitStage("loggerConfigured")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] common.initialize: Logger configured +${Math.round(elapsedMs)}ms`)
		}
	}
	Logger.subscribe((msg: string) => HostProvider.get().logToChannel(msg)) // File system logging
	Logger.subscribe((msg: string) => {
		HostProvider.env.debugLog({ value: msg }).catch((err: unknown) => {
			// biome-ignore lint/plugin: intentional — must not use Logger to avoid recursion
			console.error("[Dline] debugLog failed:", err)
		})
	})

	// Prime cachedDocumentsPath so synchronous consumers (getDlineDocumentsPathSync)
	// use the correct system Documents directory. Must run before StateManager.init
	// which calls AgentConfigLoader.getInstance → getDlineDocumentsPathSync.
	const { warmupDocumentsPathCache } = await import("./core/storage/disk")
	await warmupDocumentsPathCache()

	// Initialize ClineEndpoint configuration (reads bundled and ~/.cline/endpoints.json if present)
	// This must be done before any other code that calls ClineEnv.config()
	// Throws ClineConfigurationError if config file exists but is invalid
	const { ClineEndpoint } = await import("./config")
	{
		const elapsedMs = recordInitStage("beforeClineEndpoint")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] common.initialize: before ClineEndpoint +${Math.round(elapsedMs)}ms`)
		}
	}
	await ClineEndpoint.initialize(HostProvider.get().extensionFsPath)
	{
		const elapsedMs = recordInitStage("afterClineEndpoint")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] common.initialize: after ClineEndpoint +${Math.round(elapsedMs)}ms`)
		}
	}

	try {
		{
			const elapsedMs = recordInitStage("beforeStateManager")
			if (Logger.isDebugEnabled()) {
				Logger.debug(`[Dline] common.initialize: before StateManager +${Math.round(elapsedMs)}ms`)
			}
		}
		await StateManager.initialize(storageContext)
		{
			const elapsedMs = recordInitStage("afterStateManager")
			if (Logger.isDebugEnabled()) {
				Logger.debug(`[Dline] common.initialize: after StateManager +${Math.round(elapsedMs)}ms`)
			}
		}
	} catch (error) {
		Logger.error("[Dline] CRITICAL: Failed to initialize StateManager:", error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Failed to initialize storage. Please check logs for details or try restarting the client.",
		})
		const webview = HostProvider.get().createWebviewProvider()
		webview.setStartupFailure(error)
		return webview
	}

	// =============== Model Registry ===============
	// Ensure seed provider configs exist and initialize the model registry
	try {
		const registry = ModelRegistry.getInstance()
		await ensureSeedProviders(registry.providersDir)
		await registry.initialize()
	} catch (error) {
		Logger.error("[Dline] Failed to initialize ModelRegistry:", error)
	}

	// =============== External services ===============
	await ErrorService.initialize()
	// PostHog client provider disabled - no telemetry data upload

	// =============== Webview services ===============
	{
		const elapsedMs = recordInitStage("beforeCreateWebview")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] common.initialize: before createWebview +${Math.round(elapsedMs)}ms`)
		}
	}
	const webview = HostProvider.get().createWebviewProvider()
	webview.ensureController()

	// Initialize OrchestratorController and register sidebar as main controller
	const { OrchestratorController } = await import("./core/orchestrator/OrchestratorController")
	OrchestratorController.initialize().registerMainController(webview.controller)

	// Register ModelRegistry fs-watch → webview state push
	ModelRegistry.getInstance().onChange(() => {
		webview.controller?.postStateToWebview()
	})

	{
		const elapsedMs = recordInitStage("afterEnsureController")
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] common.initialize: after ensureController +${Math.round(elapsedMs)}ms`)
		}
	}

	const stateManager = StateManager.get()

	// Start runtime diagnostics once consent is readable. Failure is contained:
	// diagnostics assist troubleshooting, so they must never block activation.
	try {
		await activateRuntimeTelemetry({
			dataDir: storageContext.dataDir,
			// Runtime diagnostics support error investigation, so they follow the
			// error-reporting consent rather than product analytics consent.
			telemetrySetting: stateManager.getGlobalSettingsKey("errorReportingSetting") ?? "unset",
			onEvent: (event) => forwardRuntimeEvent(event, telemetryService),
			activeTaskIds: () =>
				OrchestratorController.getInstance()
					.getActiveControllers()
					.flatMap((controller) => {
						const task = controller.task
						return task && !["completed", "aborted", "paused"].includes(task.getActiveTaskPhase())
							? [task.taskId]
							: []
					}),
		})
	} catch (error) {
		Logger.error("[Dline] Failed to start runtime telemetry:", error)
	}

	// Non-blocking announcement check and display
	showVersionUpdateAnnouncement(stateManager)
	// Check if this workspace was opened from worktree quick launch
	await checkWorktreeAutoOpen(stateManager)

	// =============== Background sync and cleanup tasks ===============
	// Use remote config blobStoreConfig if available, otherwise fall back to env vars
	const blobStoreSettings = stateManager.getRemoteConfigSettings()?.blobStoreConfig ?? getBlobStoreSettingsFromEnv()
	syncWorker().init({ ...blobStoreSettings, userDistinctId: getDistinctId() })
	// Clean up old temp files in background (non-blocking) and start periodic cleanup every 24 hours
	DlineRuntimeFileManager.startPeriodicCleanup()
	// Clean up orphaned file context warnings (startup cleanup)
	FileContextTracker.cleanupOrphanedWarnings(stateManager)

	telemetryService.captureExtensionActivated()
	getRuntimeTelemetryLifecycle()?.diagnostics.phase("activation.common_ready", "completed", performance.now() - initStart)

	{
		const elapsedMs = performance.now() - initStart
		recordPerfPhase(PerfDomain.Activation, "common_initialize", elapsedMs, { stage: "done" })
		if (Logger.isDebugEnabled()) {
			Logger.debug(`[Dline] common.initialize: done +${Math.round(elapsedMs)}ms`)
		}
	}
	return webview
}

async function showVersionUpdateAnnouncement(stateManager: StateManager) {
	// Version checking for autoupdate notification
	const currentVersion = ExtensionRegistryInfo.version
	const previousVersion = stateManager.getGlobalStateKey("version")
	// Perform post-update actions if necessary
	try {
		if (!previousVersion || currentVersion !== previousVersion) {
			Logger.log(`Dline version changed: ${previousVersion} -> ${currentVersion}. First run or update detected.`)

			// Check if there's a new announcement to show
			const lastShownAnnouncementId = stateManager.getGlobalStateKey("lastShownAnnouncementId")
			const latestAnnouncementId = getLatestAnnouncementId()

			if (lastShownAnnouncementId !== latestAnnouncementId) {
				// Show notification when there's a new announcement (major/minor updates or fresh installs)
				const message = previousVersion
					? `Dline has been updated to v${currentVersion}`
					: `Welcome to Dline v${currentVersion}`
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message,
				})
			}
			// Always update the main version tracker for the next launch.
			await stateManager.setGlobalState("version", currentVersion)
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		Logger.error(`Error during post-update actions: ${errorMessage}, Stack trace: ${error.stack}`)
	}
}

/**
 * Checks if this workspace was opened from the worktree quick launch button.
 * If so, opens the Cline sidebar and clears the state.
 */
async function checkWorktreeAutoOpen(stateManager: StateManager): Promise<void> {
	try {
		// Read directly from globalState (not StateManager cache) since this may have been
		// set by another window right before this one opened
		const worktreeAutoOpenPath = stateManager.getGlobalStateKey("worktreeAutoOpenPath")
		if (!worktreeAutoOpenPath) {
			return
		}

		// Get current workspace path
		const workspacePaths = (await HostProvider.workspace.getWorkspacePaths({})).paths
		if (workspacePaths.length === 0) {
			return
		}

		const currentPath = workspacePaths[0]

		// Check if current workspace matches the worktree path
		if (arePathsEqual(currentPath, worktreeAutoOpenPath)) {
			// Clear the state first to prevent re-triggering
			stateManager.setGlobalState("worktreeAutoOpenPath", undefined)
			// Open the Cline sidebar
			await HostProvider.workspace.openClineSidebarPanel({})
		}
	} catch (error) {
		Logger.error("Error checking worktree auto-open", error)
	}
}

/**
 * Performs cleanup when Cline is deactivated that is common to all platforms.
 */
export async function tearDown(): Promise<void> {
	const diagnostics = getRuntimeTelemetryLifecycle()?.diagnostics
	const observe = (stage: string, action: () => Promise<void>) => (diagnostics ? diagnostics.observe(stage, action) : action())
	diagnostics?.phase("shutdown", "started")
	try {
		AgentConfigLoader.getInstance()?.dispose()
		PostHogClientProvider.getInstance().dispose()
		featureFlagsService.dispose()

		// Keep consent and telemetry alive while controllers finish their tasks.
		try {
			await observe("shutdown.state_initial_flush", () => StateManager.get().flushPendingState())
		} catch (error) {
			Logger.error("[Dline] Initial StateManager shutdown flush failed:", error)
		}
		await observe("shutdown.controllers", () => WebviewProvider.disposeAllInstances())
		try {
			await observe("shutdown.task_history", () => flushAllWorkspaceHistoryManagers())
		} catch (error) {
			Logger.error("[Dline] Task history shutdown flush failed:", error)
		}
		await observe("shutdown.error_service", () => ErrorService.get().dispose())
		syncWorker().dispose()
		await observe("shutdown.hooks", () => HookProcessRegistry.terminateAll())
		HookDiscoveryCache.getInstance().dispose()
		DlineRuntimeFileManager.stopPeriodicCleanup()
		try {
			await observe("shutdown.state_final_flush", () => StateManager.get().flushPendingState())
		} catch (error) {
			Logger.error("[Dline] Final StateManager shutdown flush failed:", error)
		}
		diagnostics?.phase("shutdown.business_cleanup", "completed")
	} finally {
		// Flush even after failed cleanup, before storage removes the consent authority.
		try {
			await deactivateRuntimeTelemetry()
		} catch (error) {
			Logger.internalError("[Dline] Runtime telemetry shutdown failed:", error)
		}
		try {
			await disposeTelemetryService()
		} catch (error) {
			Logger.internalError("[Dline] Telemetry shutdown failed:", error)
		}
	}
	// Telemetry deliberately does not claim that the process exited successfully.
	await StateManager.shutdown()
	cleanupTestMode()
}
