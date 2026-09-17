import { Empty } from "@shared/proto/dline/common"
import { PlanActMode, UpdateTaskSettingsRequest } from "@shared/proto/dline/state"
import { Logger } from "@shared/services/Logger"
import { Mode } from "@/shared/storage/types"
import { Controller } from ".."
import { normalizeOpenaiReasoningEffort } from "./reasoningEffort"
import { prepareTaskRuntimeOverrideUpdate } from "./taskRuntimeOverrides"

// Concurrency ceilings are global-only. They are carried on the shared Settings
// message, so a Task request can reach them, but writing them per task would be
// wrong twice over: the value would skip the clamp applied on the global write
// path, and `getGlobalSettingsKey` prefers the active task's document, so the
// stale task value would shadow the global one and make a slider change appear
// to snap back for as long as that task stays open.
const GLOBAL_ONLY_SETTING_KEYS = new Set(["maxParallelToolCalls", "maxParallelSubagents"])

const TASK_RUNTIME_OVERRIDE_KEYS = new Set([
	"planModeReasoningOverrideKind",
	"planModeReasoningOverrideEffort",
	"planModeThinkingBudgetTokens",
	"actModeReasoningOverrideKind",
	"actModeReasoningOverrideEffort",
	"actModeThinkingBudgetTokens",
	"planModeServiceTierOverrideKind",
	"planModeServiceTierOverrideTier",
	"actModeServiceTierOverrideKind",
	"actModeServiceTierOverrideTier",
])

/**
 * Updates task-specific settings for the current task.
 */
export async function updateTaskSettings(controller: Controller, request: UpdateTaskSettingsRequest): Promise<Empty> {
	const convertPlanActMode = (mode: PlanActMode): Mode => {
		return mode === PlanActMode.PLAN ? "plan" : "act"
	}

	let taskId: string
	if (request.taskId) {
		taskId = request.taskId
	} else {
		if (!controller.task) {
			throw new Error("No active task to update settings for")
		}
		taskId = controller.task.taskId
	}

	let promptFreshnessPublished = false
	if (request.settings) {
		const taskCapabilityTogglesChanged = request.settings.taskCapabilityToggles !== undefined
		const hasTaskRuntimeOverrideUpdate = Object.entries(request.settings).some(
			([key, value]) => value !== undefined && TASK_RUNTIME_OVERRIDE_KEYS.has(key),
		)
		const taskRuntimeOverrideUpdate = hasTaskRuntimeOverrideUpdate
			? prepareTaskRuntimeOverrideUpdate(request.settings, controller.stateManager.getApiConfigurationForTask(taskId))
			: { mutations: [], changed: false }
		const {
			autoApprovalSettings,
			planModeReasoningEffort,
			actModeReasoningEffort,
			planModeProfile,
			actModeProfile,
			mode,
			customPrompt,
			browserSettings,
			...simpleSettings
		} = request.settings

		const filteredSettings = Object.fromEntries(
			Object.entries(simpleSettings).filter(
				([key, value]) =>
					key !== "openaiReasoningEffort" &&
					value !== undefined &&
					!TASK_RUNTIME_OVERRIDE_KEYS.has(key) &&
					!GLOBAL_ONLY_SETTING_KEYS.has(key),
			),
		)

		if (Object.keys(filteredSettings).length > 0) {
			controller.stateManager.setTaskSettingsBatch(taskId, filteredSettings)
		}
		for (const mutation of taskRuntimeOverrideUpdate.mutations) {
			if (mutation.value === undefined) {
				controller.stateManager.clearTaskSetting(taskId, mutation.key)
			} else {
				controller.stateManager.setTaskSettings(taskId, mutation.key, mutation.value)
			}
		}

		if (autoApprovalSettings) {
			const currentAutoApprovalSettings = controller.stateManager.getGlobalSettingsKey("autoApprovalSettings")
			const mergedSettings = {
				...currentAutoApprovalSettings,
				...(autoApprovalSettings.version !== undefined && { version: autoApprovalSettings.version }),
				...(autoApprovalSettings.enableNotifications !== undefined && {
					enableNotifications: autoApprovalSettings.enableNotifications,
				}),
				actions: {
					...currentAutoApprovalSettings.actions,
					...(autoApprovalSettings.actions
						? Object.fromEntries(Object.entries(autoApprovalSettings.actions).filter(([_, v]) => v !== undefined))
						: {}),
				},
			}
			controller.stateManager.setTaskSettings(taskId, "autoApprovalSettings", mergedSettings)
		}

		if (planModeReasoningEffort !== undefined) {
			controller.stateManager.setTaskSettings(
				taskId,
				"planModeReasoningEffort",
				normalizeOpenaiReasoningEffort(planModeReasoningEffort),
			)
		}

		if (actModeReasoningEffort !== undefined) {
			controller.stateManager.setTaskSettings(
				taskId,
				"actModeReasoningEffort",
				normalizeOpenaiReasoningEffort(actModeReasoningEffort),
			)
		}

		if (mode !== undefined) {
			const converted = convertPlanActMode(mode)
			const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
			if (converted !== currentMode) {
				controller.stateManager.setTaskSettings(taskId, "mode", converted)
			}
		}

		if (customPrompt === "compact") {
			controller.stateManager.setTaskSettings(taskId, "customPrompt", "compact")
		}

		// Track whether any API-handler-affecting settings changed,
		// so we can rebuild the active task's API handler.
		let taskProfileChanged = false

		if (typeof planModeProfile === "string") {
			taskProfileChanged = true
			controller.stateManager.setTaskSettings(taskId, "planModeProfile", planModeProfile)
		}

		if (typeof actModeProfile === "string") {
			taskProfileChanged = true
			controller.stateManager.setTaskSettings(taskId, "actModeProfile", actModeProfile)
		}

		const taskReasoningChanged =
			planModeReasoningEffort !== undefined || actModeReasoningEffort !== undefined || taskRuntimeOverrideUpdate.changed
		const taskModeChanged = mode !== undefined
		const shouldRebuild = taskProfileChanged || taskReasoningChanged || taskModeChanged

		if (browserSettings !== undefined) {
			const currentSettings = controller.stateManager.getGlobalSettingsKey("browserSettings")

			const newBrowserSettings = {
				...currentSettings,
				viewport: {
					width: browserSettings.viewport?.width || currentSettings.viewport.width,
					height: browserSettings.viewport?.height || currentSettings.viewport.height,
				},
				...(browserSettings.remoteBrowserEnabled !== undefined && {
					remoteBrowserEnabled: browserSettings.remoteBrowserEnabled,
				}),
				...(browserSettings.remoteBrowserHost !== undefined && {
					remoteBrowserHost: browserSettings.remoteBrowserHost,
				}),
				...(browserSettings.chromeExecutablePath !== undefined && {
					chromeExecutablePath: browserSettings.chromeExecutablePath,
				}),
				...(browserSettings.disableToolUse !== undefined && {
					disableToolUse: browserSettings.disableToolUse,
				}),
				...(browserSettings.customArgs !== undefined && {
					customArgs: browserSettings.customArgs,
				}),
			}

			controller.stateManager.setTaskSettings(taskId, "browserSettings", newBrowserSettings)
		}

		// RPC success is a durable boundary: publish and rebuild only after task settings reach disk.
		await controller.stateManager.flushPendingState()

		// Rebuild the active task's API handler exactly once when its runtime configuration changed.
		if (shouldRebuild && controller.task && controller.task.taskId === taskId) {
			Logger.info("[updateTaskSettings] profile/mode/reasoning changed — rebuilding API handler", {
				taskId,
				planModeProfile: planModeProfile ?? "(unchanged)",
				actModeProfile: actModeProfile ?? "(unchanged)",
				planModeReasoningEffort: planModeReasoningEffort ?? "(unchanged)",
				actModeReasoningEffort: actModeReasoningEffort ?? "(unchanged)",
				taskRuntimeOverrideChanged: taskRuntimeOverrideUpdate.changed,
				mode: mode ?? "(unchanged)",
			})
			await controller.task.rebuildApiHandler()
			if (taskProfileChanged || taskModeChanged) {
				controller.restartAccountUsagePolling()
			}
		}
		if (taskCapabilityTogglesChanged && controller.task && controller.task.taskId === taskId) {
			await controller.task.flushPromptFreshnessInvalidation("task_capability_toggle")
			promptFreshnessPublished = true
		}
	}

	if (!promptFreshnessPublished) await controller.postStateToWebview()

	return Empty.create()
}
