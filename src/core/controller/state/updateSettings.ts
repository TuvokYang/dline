import { buildApiHandler } from "@core/api"
import {
	DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS,
	DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS,
	isValidAutoCondenseReservePair,
	isValidAutoCondenseTokenSetting,
	MAX_AUTO_CONDENSE_CONTEXT_TOKENS,
	MAX_AUTO_CONDENSE_TRIGGER_PERCENT,
	MIN_AUTO_CONDENSE_TRIGGER_PERCENT,
} from "@shared/auto-condense"
import { resolveMaxParallelSubagents, resolveMaxParallelToolCalls } from "@shared/concurrency-limits"
import { Empty } from "@shared/proto/dline/common"
import { PlanActMode, McpDisplayMode as ProtoMcpDisplayMode, UpdateSettingsRequest } from "@shared/proto/dline/state"
import type { SettingsKey } from "@shared/storage/state-keys"
import { OpenaiReasoningEffort } from "@shared/storage/types"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { isLocalSearchEngineId } from "@shared/web-search"
import { ClineEnv } from "@/config"
import { settingsAffectPromptFreshness } from "@/core/prompts/system-prompt-cache/PromptFreshnessProjection"
import { fetchRemoteConfig } from "@/core/storage/remote-config/fetch"
import { clearRemoteConfig } from "@/core/storage/remote-config/utils"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { isChatInputSendShortcut } from "@/shared/ChatInputSendShortcut"
import { McpDisplayMode } from "@/shared/McpDisplayMode"
import { Logger } from "@/shared/services/Logger"
import { MIN_TERMINAL_COMMAND_HANDOFF_SECONDS, MIN_TERMINAL_COMMAND_TIMEOUT_SECONDS } from "@/shared/terminal-settings"
import { telemetryService } from "../../../services/telemetry"
import { BrowserSettings as SharedBrowserSettings } from "../../../shared/BrowserSettings"
import { Controller } from ".."
import { accountLogoutClicked } from "../account/accountLogoutClicked"

/**
 * Safely access a field from a runtime plain object without `as unknown as Record`.
 * Used to bridge proto-generated types that lack certain fields at compile time.
 */
function getConfigField(config: unknown, field: string): unknown {
	if (config && typeof config === "object" && field in config) {
		return (config as Record<string, unknown>)[field]
	}
	return undefined
}

function getStringConfigField(config: unknown, field: string): string | undefined {
	const value = getConfigField(config, field)
	return typeof value === "string" ? value : undefined
}

/**
 * Updates multiple extension settings in a single request
 * @param controller The controller instance
 * @param request The request containing the settings to update
 * @returns An empty response
 */
export async function updateSettings(controller: Controller, request: UpdateSettingsRequest): Promise<Empty> {
	const startedAt = performance.now()
	const fields = Object.keys(request).sort()
	try {
		const localWebSearchEngine = request.localWebSearchEngine
		if (localWebSearchEngine !== undefined && !isLocalSearchEngineId(localWebSearchEngine)) {
			throw new Error(`Unsupported local web search engine: ${localWebSearchEngine}`)
		}

		const shouldUpdateMinReserve = request.autoCondenseMinReserveTokens !== undefined
		const shouldUpdateMaxReserve = request.autoCondenseMaxReserveTokens !== undefined
		let resolvedMinReserveTokens: number | undefined
		let resolvedMaxReserveTokens: number | undefined
		if (shouldUpdateMinReserve || shouldUpdateMaxReserve) {
			resolvedMinReserveTokens = shouldUpdateMinReserve
				? Number(request.autoCondenseMinReserveTokens)
				: (controller.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens") ??
					DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS)
			resolvedMaxReserveTokens = shouldUpdateMaxReserve
				? Number(request.autoCondenseMaxReserveTokens)
				: (controller.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens") ??
					DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS)

			if (
				!isValidAutoCondenseTokenSetting(resolvedMinReserveTokens) ||
				!isValidAutoCondenseTokenSetting(resolvedMaxReserveTokens)
			) {
				throw new Error(`Auto-compact reserve must be an integer from 0 to ${MAX_AUTO_CONDENSE_CONTEXT_TOKENS} tokens`)
			}
			if (!isValidAutoCondenseReservePair(resolvedMinReserveTokens, resolvedMaxReserveTokens)) {
				throw new Error("Auto-compact reserve minimum cannot exceed maximum")
			}
		}

		if (request.clineEnv !== undefined) {
			ClineEnv.setEnvironment(request.clineEnv)
			await accountLogoutClicked(controller, Empty.create())
		}

		if (request.apiConfiguration) {
			const protoApiConfiguration = request.apiConfiguration

			const convertedApiConfigurationFromProto = {
				...protoApiConfiguration,
				planModeProfile: getStringConfigField(protoApiConfiguration, "planModeProfile"),
				actModeProfile: getStringConfigField(protoApiConfiguration, "actModeProfile"),
				imageProfileId: getStringConfigField(protoApiConfiguration, "imageProfileId"),
				imageProfile: getStringConfigField(protoApiConfiguration, "imageProfile"),
				planModeReasoningEffort: getConfigField(protoApiConfiguration, "planModeReasoningEffort") as
					| OpenaiReasoningEffort
					| undefined,
				actModeReasoningEffort: getConfigField(protoApiConfiguration, "actModeReasoningEffort") as
					| OpenaiReasoningEffort
					| undefined,
			}

			controller.stateManager.setApiConfiguration(convertedApiConfigurationFromProto)

			if (controller.task) {
				const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
				const apiConfigForHandler = {
					...controller.stateManager.getApiConfiguration(),
					ulid: controller.task.ulid,
				}
				controller.task.api = buildApiHandler(apiConfigForHandler, currentMode)
			}
		}

		// Reporting consents are independent, so each is applied only when the
		// request actually carries it.
		if (request.usageReportingSetting) {
			await controller.updateUsageReportingSetting(request.usageReportingSetting as TelemetrySetting)
		}
		if (request.errorReportingSetting) {
			await controller.updateErrorReportingSetting(request.errorReportingSetting as TelemetrySetting)
		}

		// Update plan/act separate models setting. An active Task must collapse
		// its split bindings before the global unified-mode default is published.
		if (request.planActSeparateModelsSetting !== undefined) {
			const wasSeparate = controller.stateManager.getCanonicalSettingsKey("planActSeparateModelsSetting")
			if (wasSeparate && !request.planActSeparateModelsSetting && controller.task) {
				const taskState = controller.task.taskSm
				const profileId = taskState.mode === "plan" ? taskState.planModeProfileId : taskState.actModeProfileId
				const profileName = taskState.mode === "plan" ? taskState.planModeProfile : taskState.actModeProfile
				if (!profileName) {
					throw new Error("Cannot disable Profile split without an active task Profile binding.")
				}
				await controller.task.commitProfileBindings(profileId ? { profileId, profileName } : profileName, ["plan", "act"])
				controller.stateManager.setGlobalStateBatch({
					planModeProfileId: profileId,
					planModeProfile: profileName,
					actModeProfileId: profileId,
					actModeProfile: profileName,
				})
			}
			controller.stateManager.setGlobalState("planActSeparateModelsSetting", request.planActSeparateModelsSetting)
		}

		// Update checkpoints setting
		if (request.enableCheckpointsSetting !== undefined) {
			controller.stateManager.setGlobalState("enableCheckpointsSetting", request.enableCheckpointsSetting)
		}

		// Update MCP responses collapsed setting
		if (request.mcpResponsesCollapsed !== undefined) {
			controller.stateManager.setGlobalState("mcpResponsesCollapsed", request.mcpResponsesCollapsed)
		}

		// Update MCP display mode setting
		if (request.mcpDisplayMode !== undefined) {
			// Convert proto enum to string type
			let displayMode: McpDisplayMode
			switch (request.mcpDisplayMode) {
				case ProtoMcpDisplayMode.RICH:
					displayMode = "rich"
					break
				case ProtoMcpDisplayMode.PLAIN:
					displayMode = "plain"
					break
				case ProtoMcpDisplayMode.MARKDOWN:
					displayMode = "markdown"
					break
				default:
					throw new Error(`Invalid MCP display mode value: ${request.mcpDisplayMode}`)
			}
			controller.stateManager.setGlobalState("mcpDisplayMode", displayMode)
		}

		if (request.mode !== undefined) {
			const mode = request.mode === PlanActMode.PLAN ? "plan" : "act"
			controller.stateManager.setGlobalState("mode", mode)
		}

		if (request.preferredLanguage !== undefined) {
			controller.stateManager.setGlobalState("preferredLanguage", request.preferredLanguage)
		}

		if (request.chatInputSendShortcut !== undefined) {
			if (!isChatInputSendShortcut(request.chatInputSendShortcut)) {
				throw new Error(`Invalid chat input send shortcut: ${request.chatInputSendShortcut}`)
			}
			controller.stateManager.setGlobalState("chatInputSendShortcut", request.chatInputSendShortcut)
		}

		// Update terminal timeout setting
		if (request.shellIntegrationTimeout !== undefined) {
			controller.stateManager.setGlobalState("shellIntegrationTimeout", Number(request.shellIntegrationTimeout))
		}

		// Update terminal reuse setting
		if (request.terminalReuseEnabled !== undefined) {
			controller.stateManager.setGlobalState("terminalReuseEnabled", request.terminalReuseEnabled)
		}

		// Update terminal output line limit
		if (request.terminalOutputLineLimit !== undefined) {
			controller.stateManager.setGlobalState("terminalOutputLineLimit", Number(request.terminalOutputLineLimit))
		}

		if (request.terminalCommandTimeoutSeconds !== undefined) {
			const timeoutSeconds = Number(request.terminalCommandTimeoutSeconds)
			if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < MIN_TERMINAL_COMMAND_TIMEOUT_SECONDS) {
				throw new Error(`Terminal command timeout must be at least ${MIN_TERMINAL_COMMAND_TIMEOUT_SECONDS} seconds`)
			}
			controller.stateManager.setGlobalState("terminalCommandTimeoutSeconds", timeoutSeconds)
		}

		if (request.terminalCommandHandoffSeconds !== undefined) {
			const handoffSeconds = Number(request.terminalCommandHandoffSeconds)
			if (!Number.isSafeInteger(handoffSeconds) || handoffSeconds < MIN_TERMINAL_COMMAND_HANDOFF_SECONDS) {
				throw new Error(`Terminal command handoff must be at least ${MIN_TERMINAL_COMMAND_HANDOFF_SECONDS} seconds`)
			}
			controller.stateManager.setGlobalState("terminalCommandHandoffSeconds", handoffSeconds)
		}

		if (request.vscodeTerminalExecutionMode !== undefined && request.vscodeTerminalExecutionMode !== "") {
			controller.stateManager.setGlobalState(
				"vscodeTerminalExecutionMode",
				request.vscodeTerminalExecutionMode === "backgroundExec" ? "backgroundExec" : "vscodeTerminal",
			)
		}

		// Update max consecutive mistakes
		if (request.maxConsecutiveMistakes !== undefined) {
			controller.stateManager.setGlobalState("maxConsecutiveMistakes", Number(request.maxConsecutiveMistakes))
		}

		// Update strict plan mode setting
		if (request.strictPlanModeEnabled !== undefined) {
			controller.stateManager.setGlobalState("strictPlanModeEnabled", request.strictPlanModeEnabled)
		}

		if (request.hooksEnabled !== undefined) {
			const wasEnabled = controller.stateManager.getGlobalSettingsKey("hooksEnabled") ?? true
			const isEnabled = !!request.hooksEnabled
			controller.stateManager.setGlobalState("hooksEnabled", isEnabled)
			if (controller.task && wasEnabled !== isEnabled) {
				telemetryService.captureFeatureToggle(controller.task.ulid, "hooks", isEnabled, controller.task.api.getModel().id)
			}
		}
		// Update yolo mode setting
		if (request.yoloModeToggled !== undefined) {
			if (controller.task) {
				telemetryService.captureYoloModeToggle(controller.task.ulid, request.yoloModeToggled)
			}
			controller.stateManager.setGlobalState("yoloModeToggled", request.yoloModeToggled)
		}

		if (request.imageGenerationEnabled !== undefined) {
			controller.stateManager.setGlobalState("imageGenerationEnabled", request.imageGenerationEnabled)
		}

		// Update Web Tools settings. Credentials must remain in Secret Storage.
		if (request.clineWebToolsEnabled !== undefined) {
			if (controller.task) {
				telemetryService.captureClineWebToolsToggle(controller.task.ulid, request.clineWebToolsEnabled)
			}
			controller.stateManager.setGlobalState("clineWebToolsEnabled", request.clineWebToolsEnabled)
		}
		if (localWebSearchEngine !== undefined) {
			controller.stateManager.setGlobalState("localWebSearchEngine", localWebSearchEngine)
		}
		const searxngSearchUrl = request.searxngSearchUrl
		if (searxngSearchUrl !== undefined) {
			controller.stateManager.setGlobalState("searxngSearchUrl", searxngSearchUrl.trim() || undefined)
		}
		const searxngSearchToken = request.searxngSearchToken
		if (searxngSearchToken !== undefined) {
			controller.stateManager.setSecret("searxngSearchToken", searxngSearchToken.trim() ? searxngSearchToken : undefined)
		}

		// Update worktrees setting
		if (request.worktreesEnabled !== undefined) {
			controller.stateManager.setGlobalState("worktreesEnabled", request.worktreesEnabled)
		}

		// Update subagents setting
		if (request.subagentsEnabled !== undefined) {
			const wasEnabled = controller.stateManager.getGlobalSettingsKey("subagentsEnabled") ?? true
			const isEnabled = !!request.subagentsEnabled
			controller.stateManager.setGlobalState("subagentsEnabled", isEnabled)

			// Capture telemetry when setting changes
			if (wasEnabled !== isEnabled) {
				telemetryService.captureSubagentToggle(isEnabled)
			}
		}

		// Update auto-condense setting
		if (request.useAutoCondense !== undefined) {
			if (controller.task) {
				telemetryService.captureAutoCondenseToggle(
					controller.task.ulid,
					request.useAutoCondense,
					controller.task.api.getModel().id,
				)
			}
			controller.stateManager.setGlobalState("useAutoCondense", request.useAutoCondense)
		}

		if (request.autoCondenseTriggerPercent !== undefined) {
			const triggerPercent = Number(request.autoCondenseTriggerPercent)
			if (
				!Number.isSafeInteger(triggerPercent) ||
				triggerPercent < MIN_AUTO_CONDENSE_TRIGGER_PERCENT ||
				triggerPercent > MAX_AUTO_CONDENSE_TRIGGER_PERCENT
			) {
				throw new Error(
					`Auto-compact trigger must be an integer from ${MIN_AUTO_CONDENSE_TRIGGER_PERCENT} to ${MAX_AUTO_CONDENSE_TRIGGER_PERCENT} percent`,
				)
			}
			controller.stateManager.setGlobalState("autoCondenseTriggerPercent", triggerPercent)
		}

		if (request.autoCondenseMaxContextTokens !== undefined) {
			const maxContextTokens = Number(request.autoCondenseMaxContextTokens)
			if (
				!Number.isSafeInteger(maxContextTokens) ||
				maxContextTokens < 0 ||
				maxContextTokens > MAX_AUTO_CONDENSE_CONTEXT_TOKENS
			) {
				throw new Error(
					`Auto-compact maximum context must be an integer from 0 to ${MAX_AUTO_CONDENSE_CONTEXT_TOKENS} tokens`,
				)
			}
			controller.stateManager.setGlobalState("autoCondenseMaxContextTokens", maxContextTokens)
		}

		if (shouldUpdateMinReserve && resolvedMinReserveTokens !== undefined) {
			controller.stateManager.setGlobalState("autoCondenseMinReserveTokens", resolvedMinReserveTokens)
		}
		if (shouldUpdateMaxReserve && resolvedMaxReserveTokens !== undefined) {
			controller.stateManager.setGlobalState("autoCondenseMaxReserveTokens", resolvedMaxReserveTokens)
		}

		// Update focus chain settings
		if (request.focusChainSettings !== undefined) {
			{
				const currentSettings = controller.stateManager.getGlobalSettingsKey("focusChainSettings")
				const wasEnabled = currentSettings?.enabled ?? false
				const isEnabled = request.focusChainSettings.enabled

				const focusChainSettings = {
					enabled: isEnabled,
					remindClineInterval: request.focusChainSettings.remindClineInterval,
				}
				controller.stateManager.setGlobalState("focusChainSettings", focusChainSettings)

				// Capture telemetry when setting changes
				if (wasEnabled !== isEnabled) {
					telemetryService.captureFocusChainToggle(isEnabled)
				}
			}
		}

		// Update custom prompt choice
		if (request.customPrompt !== undefined) {
			const value = request.customPrompt === "compact" ? "compact" : undefined
			controller.stateManager.setGlobalState("customPrompt", value)
		}

		// Update browser settings
		if (request.browserSettings !== undefined) {
			// Get current browser settings to preserve fields not in the request
			const currentSettings = controller.stateManager.getGlobalSettingsKey("browserSettings")

			// Convert from protobuf format to shared format, merging with existing settings
			const newBrowserSettings: SharedBrowserSettings = {
				...currentSettings, // Start with existing settings (and defaults)
				viewport: {
					// Apply updates from request
					width: request.browserSettings.viewport?.width || currentSettings.viewport.width,
					height: request.browserSettings.viewport?.height || currentSettings.viewport.height,
				},
				// Explicitly handle optional boolean and string fields from the request
				remoteBrowserEnabled:
					request.browserSettings.remoteBrowserEnabled === undefined
						? currentSettings.remoteBrowserEnabled
						: request.browserSettings.remoteBrowserEnabled,
				remoteBrowserHost:
					request.browserSettings.remoteBrowserHost === undefined
						? currentSettings.remoteBrowserHost
						: request.browserSettings.remoteBrowserHost,
				chromeExecutablePath:
					// If chromeExecutablePath is explicitly in the request (even as ""), use it.
					// Otherwise, fall back to mergedWithDefaults.
					"chromeExecutablePath" in request.browserSettings
						? request.browserSettings.chromeExecutablePath
						: currentSettings.chromeExecutablePath,
				disableToolUse:
					request.browserSettings.disableToolUse === undefined
						? currentSettings.disableToolUse
						: request.browserSettings.disableToolUse,
				customArgs:
					"customArgs" in request.browserSettings ? request.browserSettings.customArgs : currentSettings.customArgs,
			}

			// Update global state with new settings
			controller.stateManager.setGlobalState("browserSettings", newBrowserSettings)
		}

		// Update default terminal profile. Runtime components are configured once after all settings are persisted.
		if (request.defaultTerminalProfile !== undefined) {
			controller.stateManager.setGlobalState("defaultTerminalProfile", request.defaultTerminalProfile)
		}

		if (request.backgroundEditEnabled !== undefined) {
			controller.stateManager.setGlobalState("backgroundEditEnabled", !!request.backgroundEditEnabled)
		}

		if (request.multiRootEnabled !== undefined) {
			controller.stateManager.setGlobalState("multiRootEnabled", !!request.multiRootEnabled)
		}

		if (request.nativeToolCallEnabled !== undefined) {
			controller.stateManager.setGlobalState("nativeToolCallEnabled", !!request.nativeToolCallEnabled)
			if (controller.task) {
				telemetryService.captureFeatureToggle(
					controller.task.ulid,
					"native-tool-call",
					request.nativeToolCallEnabled,
					controller.task.api.getModel().id,
				)
			}
		}

		if (request.enableParallelToolCalling !== undefined) {
			controller.stateManager.setGlobalState("enableParallelToolCalling", !!request.enableParallelToolCalling)
			controller.task?.notifyToolConcurrencyLimitChanged()
		}

		// Clamp on the way in as well as on the way out. Storing an out-of-range
		// value would leave the persisted document disagreeing with every reader
		// of it, and a later build that widened the range would silently adopt a
		// limit the user never chose.
		if (request.maxParallelToolCalls !== undefined) {
			controller.stateManager.setGlobalState(
				"maxParallelToolCalls",
				resolveMaxParallelToolCalls(request.maxParallelToolCalls, true),
			)
			controller.task?.notifyToolConcurrencyLimitChanged()
		}

		if (request.maxParallelSubagents !== undefined) {
			controller.stateManager.setGlobalState(
				"maxParallelSubagents",
				resolveMaxParallelSubagents(request.maxParallelSubagents),
			)
			controller.task?.notifySubagentConcurrencyLimitChanged()
		}

		if (request.optOutOfRemoteConfig !== undefined) {
			const hadOptedOut = controller.stateManager.getGlobalSettingsKey("optOutOfRemoteConfig")
			const isOptingOut = !!request.optOutOfRemoteConfig
			const isReenablingRemoteConfig = !isOptingOut && hadOptedOut

			// Update now so any subsequent function can access the updated value
			controller.stateManager.setGlobalState("optOutOfRemoteConfig", isOptingOut)

			if (isOptingOut && !hadOptedOut) {
				clearRemoteConfig()
			} else if (isReenablingRemoteConfig) {
				// Fire-and-forget: We don't need to await here
				// The function catches any errors and posts the updated state to the webview
				// The immediate state update below shows the user's intent (opted-in),
				// and we apply the actual config afterwards without blocking the settings update
				fetchRemoteConfig(controller)
			}
		}

		if (request.doubleCheckCompletionEnabled !== undefined) {
			controller.stateManager.setGlobalState("doubleCheckCompletionEnabled", request.doubleCheckCompletionEnabled)
		}

		if (request.lazyTeammateModeEnabled !== undefined) {
			controller.stateManager.setGlobalState("lazyTeammateModeEnabled", request.lazyTeammateModeEnabled)
		}

		if (request.showFeatureTips !== undefined) {
			controller.stateManager.setGlobalState("showFeatureTips", request.showFeatureTips)
		}

		if (request.showActiveTasksInEnvDetails !== undefined) {
			controller.stateManager.setGlobalState("showActiveTasksInEnvDetails", request.showActiveTasksInEnvDetails)
		}

		if (request.mcpEnabled !== undefined) {
			controller.stateManager.setGlobalState("mcpEnabled", request.mcpEnabled)
		}

		// Profile-driven model selection
		Logger.info("[updateSettings] received", {
			fields,
			planModeProfile: request.planModeProfile,
			actModeProfile: request.actModeProfile,
			imageProfileId: request.imageProfileId,
			imageProfile: request.imageProfile,
		})
		const didChangeProfile = request.planModeProfile !== undefined || request.actModeProfile !== undefined
		if (request.planModeProfile !== undefined) {
			controller.stateManager.setGlobalState("planModeProfile", request.planModeProfile)
		}
		if (request.actModeProfile !== undefined) {
			Logger.info("[updateSettings] setting actModeProfile=", request.actModeProfile)
			controller.stateManager.setGlobalState("actModeProfile", request.actModeProfile)
		}
		if (request.imageProfileId !== undefined) {
			controller.stateManager.setGlobalState("imageProfileId", request.imageProfileId)
		}
		if (request.imageProfile !== undefined) {
			controller.stateManager.setGlobalState("imageProfile", request.imageProfile)
		}

		// Synchronize profiles when unified mode is active (planActSeparateModelsSetting = false)
		if (didChangeProfile) {
			const separateModels = controller.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")

			if (separateModels === false) {
				// Unified mode: synchronize both profiles to the same value
				const newProfile = request.planModeProfile || request.actModeProfile
				if (newProfile) {
					Logger.info("[updateSettings] Unified mode: synchronizing both profiles to", newProfile)
					controller.stateManager.setGlobalState("planModeProfile", newProfile)
					controller.stateManager.setGlobalState("actModeProfile", newProfile)
				}
			}

			// Global profile changes are welcome/new-task defaults only. Existing
			// tasks retain their task-local bindings and handlers unchanged.
		}

		// A successful Settings RPC is a durable commit boundary. Reconfigure
		// runtime components and publish the new state only after every pending
		// storage write has completed successfully.
		const flushStartedAt = performance.now()
		await controller.stateManager.flushPendingState()
		const flushMs = Math.round(performance.now() - flushStartedAt)
		const configureStartedAt = performance.now()
		await controller.configureGlobalComponents()
		const configureMs = Math.round(performance.now() - configureStartedAt)

		// A running Task holds a frozen prompt. Settings that the freshness
		// projection represents must re-evaluate it here, or the next request
		// keeps advertising the tool set captured before this commit.
		// `onSyncExternalChange` only covers commits observed from another
		// process, so a local RPC would otherwise never invalidate.
		const publishStartedAt = performance.now()
		if (controller.task && settingsAffectPromptFreshness(fields as SettingsKey[])) {
			await controller.task.flushPromptFreshnessInvalidation("settings")
		} else {
			await controller.postStateToWebview()
		}
		recordPerfPhase(
			PerfDomain.Settings,
			"rpc_complete",
			performance.now() - startedAt,
			{
				fields: fields.length,
				flushMs,
				configureMs,
				publishMs: Math.round(performance.now() - publishStartedAt),
			},
			{ taskId: controller.task?.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[SettingsPerf] phase=rpc_complete taskId=${controller.task?.taskId ?? "none"} fields=${fields.join(",") || "none"} flushMs=${flushMs} configureMs=${configureMs} publishMs=${Math.round(performance.now() - publishStartedAt)} totalMs=${Math.round(performance.now() - startedAt)}`,
			)
		}

		return Empty.create()
	} catch (error) {
		Logger.error("Failed to update settings:", error)
		recordPerfPhase(
			PerfDomain.Settings,
			"rpc_error",
			performance.now() - startedAt,
			{ fields: fields.length },
			{ taskId: controller.task?.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[SettingsPerf] phase=rpc_error taskId=${controller.task?.taskId ?? "none"} fields=${fields.join(",") || "none"} totalMs=${Math.round(performance.now() - startedAt)}`,
			)
		}
		throw error
	}
}
