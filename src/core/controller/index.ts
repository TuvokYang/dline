import { createHash, randomUUID } from "node:crypto"
import type { Anthropic } from "@anthropic-ai/sdk"
import { accountUsageCoordinator } from "@core/account-usage/AccountUsageCoordinator"
import { decorateProviderAccountUsage } from "@core/account-usage/provider-usage"
import {
	type AccountUsage,
	type AccountUsageResetResult,
	type ApiHandler,
	buildApiHandler,
	buildApiHandlerFromProfile,
} from "@core/api"
import { getProfileModelInfo } from "@core/api/model-info"
import { createGlobalConfigurationSnapshot, type GlobalConfigurationSnapshot } from "@core/configuration/GlobalConfiguration"
import { GlobalConfigurationManager, type GlobalConfigurationResult } from "@core/configuration/GlobalConfigurationManager"
import { resolveTargetContextScope } from "@core/context/context-management/target-context-scope"
import { ContextTransitionEngine } from "@core/controller/context-transition/ContextTransitionEngine"
import { ContextTransitionLease } from "@core/controller/context-transition/ContextTransitionLease"
import { ModeTransitionPolicy } from "@core/controller/context-transition/policies/ModeTransitionPolicy"
import { ProfileTransitionPolicy } from "@core/controller/context-transition/policies/ProfileTransitionPolicy"
import { findEnabledProfiles, readApiProfiles } from "@core/controller/file/getApiProfiles"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { IgnoreController } from "@core/ignore/IgnoreController"
import { TaskLockService } from "@core/locks/TaskLockService"
import { resolveProfileReference } from "@core/profiles/profile-binding"
import { getProfileCatalogRevision } from "@core/profiles/profile-catalog-state"
import { settingsAffectPromptFreshness } from "@core/prompts/system-prompt-cache/PromptFreshnessProjection"
import * as SecretsManager from "@core/storage/secrets"
import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { type CapabilityKind, mergeScopedToggles, readScopedToggles } from "@core/storage/settings/capability-toggle-store"
import { projectTaskView } from "@core/task/view/TaskViewProjector"
import { detectWorkspaceRoots } from "@core/workspace/detection"
import { setupWorkspaceManager } from "@core/workspace/setup"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import { type OpenAiCodexRuntimeMutationEvent, openAiCodexOAuthManager } from "@integrations/openai-codex/oauth"
import { ClineAccountService } from "@services/account/ClineAccountService"
import { McpHub } from "@services/mcp/McpHub"
import type { ModelInfo } from "@shared/api"
import type { ChatContent } from "@shared/ChatContent"
import { getContextWindowIndicatorTotalTokens } from "@shared/context-window-indicator"
import type { ExtensionState, Platform } from "@shared/ExtensionMessage"
import type { ApiMetrics } from "@shared/getApiMetrics"
import type { HistoryItem } from "@shared/HistoryItem"
import type { McpMarketplaceCatalog, McpMarketplaceItem, McpServer } from "@shared/mcp"
import type { ClineUserContent } from "@shared/messages/content"
import type { ModeSwitchRequestResult } from "@shared/mode-switch"
import type { ProfileSwitchRequestResult } from "@shared/profile-switch"
import type { TaskLockStatus } from "@shared/proto/dline/task"
import { type Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import {
	createTaskCapabilityToggles,
	parseTaskCapabilityToggles,
	serializeTaskCapabilityToggles,
	type TaskCapabilityToggles,
} from "@shared/TaskCapabilityToggles"
import { isReportingAllowed, type TelemetrySetting } from "@shared/TelemetrySetting"
import type { UserInfo } from "@shared/UserInfo"
import { fileExistsAtPath } from "@utils/fs"
import axios from "axios"
import open from "open"
import Mutex from "p-mutex"
import * as path from "path"
import { ClineEnv } from "@/config"
import { getDlineDocumentsPath, getDlineDocumentsPathSync } from "@/core/storage/disk"
import {
	readPersistedTaskCompletion,
	TASK_COMPLETION_BACKFILL_DELAY_MS,
	TASK_COMPLETION_BACKFILL_GENERATION,
	TaskCompletionBackfill,
} from "@/core/storage/TaskCompletionBackfill"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { AuthService } from "@/services/auth/AuthService"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { LogoutReason } from "@/services/auth/types"
import { featureFlagsService } from "@/services/feature-flags"
import { getDistinctId } from "@/services/logging/distinctId"
import { telemetryService } from "@/services/telemetry"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { getRuntimeTelemetryLifecycle } from "@/services/telemetry/runtime/host"
import { ClineExtensionContext } from "@/shared/cline"
import { getAxiosSettings } from "@/shared/net"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { Session } from "@/shared/services/Session"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getCwd, getDesktopDir } from "@/utils/path"
import { ModelRegistry } from "../model-registry/ModelRegistry"
import { ApiConversation } from "../storage/ApiConversation"
import { readJsonl } from "../storage/backend/jsonl/jsonl-utils"
import {
	ensureMcpServersDirectoryExists,
	ensureSettingsDirectoryExists,
	GlobalFileNames,
	writeMcpMarketplaceCatalogToCache,
} from "../storage/disk"
import { fetchRemoteConfig } from "../storage/remote-config/fetch"
import { clearRemoteConfig } from "../storage/remote-config/utils"
import { type PersistenceErrorEvent, StateManager } from "../storage/StateManager"
import { UIMessage } from "../storage/UIMessage"
import { Task } from "../task"
import { readDiscoveredToggles } from "./file/capability-discovery-cache"
import {
	getWorkspaceHistoryManager,
	type WorkspaceHistoryManager,
	type WorkspaceHistorySession,
} from "./history/WorkspaceHistoryManager"
import { projectMcpServersWithToggleOverrides } from "./mcp/mcp-server-toggle-projection"
import { sendMcpMarketplaceCatalogEvent } from "./mcp/subscribeToMcpMarketplaceCatalog"
import { ModeSwitchCoordinator } from "./mode-switch/ModeSwitchCoordinator"
import type { ModeSwitchOperation, ResolvedModeProfile } from "./mode-switch/types"
import { getClineOnboardingModels } from "./models/getClineOnboardingModels"
import { appendClineStealthModels } from "./models/refreshOpenRouterModels"
import { ProfileSwitchCoordinator } from "./profile-switch/ProfileSwitchCoordinator"
import type { ProfileSwitchOperation, ResolvedProfileTarget } from "./profile-switch/types"
import { projectFocusChainHistory } from "./state/focusChainHistoryProjection"
import { cleanupStateSubscriptions, sendAccountUsageUpdate, sendStateUpdate } from "./state/subscribeToState"
import { projectTaskHistory } from "./state/taskHistoryProjection"
import { prepareHistoryTaskForDisplay, projectHistoryPreparingView } from "./task/history-task-readiness"
import { startTaskLifecycle } from "./task/task-start-lifecycle"
import { sendChatButtonClickedEvent } from "./ui/subscribeToChatButtonClicked"

/**
 * Merge window for ordinary state publications.
 *
 * Matches the delivery debounce in subscribeToState so moving coalescing ahead
 * of the build keeps the user-visible latency ceiling unchanged.
 */
const STATE_POST_COALESCE_MS = 50

const ACCOUNT_USAGE_BINDING_SETTINGS = new Set([
	"mode",
	"planModeProfileId",
	"planModeProfile",
	"actModeProfileId",
	"actModeProfile",
])

type InitTaskOptions = {
	onHistoryTaskPreparingToDisplay?: () => Promise<void>
	onHistoryTaskReadyToDisplay?: () => Promise<void>
	/** Context fragments for spawned or new tasks. Each entry becomes an independent text block for cache-friendly design. */
	context?: string[]
	/** Trusted internal content appended to the successor's first Provider request. */
	initialUserContent?: ClineUserContent[]
	/** Return after task-start admission while the agent loop continues in the background. */
	startInBackground?: boolean
	/** Complete identity-dependent setup before the task can issue its first API request. */
	beforeStart?: (taskId: string) => Promise<void> | void
	/** Observe a background task-start failure without rejecting the completed admission. */
	onBackgroundError?: (error: unknown, taskId: string) => Promise<void> | void
	/** Internal lifecycle transaction already removed the previous Task. */
	skipInitialClear?: boolean
}

type PostStateOptions = {
	immediate?: boolean
}

export type TaskLifecycleScope = {
	/** Clear the active task while already holding the controller lifecycle lock. */
	clearTask(options?: {
		clearPanelState?: boolean
		preserveCompletedState?: boolean
		suppressPostState?: boolean
		deferTeardown?: boolean
	}): Promise<void>
}

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts

https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class Controller {
	/**
	 * One backfill scan per process.
	 *
	 * Multiple Controllers (multi-window/webview) share the same taskHistory
	 * file; letting each one schedule its own scan multiplied full-history
	 * reads and durable transactions for identical repairs.
	 */
	private static taskCompletionBackfillScheduled = false

	task?: Task

	mcpHub: McpHub
	readonly mcpOwnerId = randomUUID()
	accountService: ClineAccountService
	authService: AuthService
	ocaAuthService: OcaAuthService
	readonly stateManager: StateManager
	readonly lockService: TaskLockService
	readonly globalConfigurationManager: GlobalConfigurationManager<GlobalConfigurationSnapshot>

	// NEW: Add workspace manager (optional initially)
	private workspaceManager?: WorkspaceRootManager
	private workspaceHistoryManager?: WorkspaceHistoryManager
	private workspaceHistorySession?: WorkspaceHistorySession
	private backgroundCommandRunning = false
	private backgroundCommandTaskId?: string

	// Flag to prevent duplicate cancellations from spam clicking
	private cancelInProgress = false
	/**
	 * Durable teardown of a Task that has already been detached from the surface.
	 *
	 * Closing a task only needs the surface released to return the user to Recent;
	 * flushing stores, releasing the task lock and clearing registries can finish
	 * afterwards. Every lifecycle operation awaits this promise, so the deferred
	 * work still completes before another Task is created or resumed.
	 */
	private pendingTaskTeardown?: Promise<void>
	private readonly taskLifecycleMutex = new Mutex()
	private readonly taskHistoryProjectionMutex = new Mutex()

	private readonly contextTransitionEngine: ContextTransitionEngine
	/**
	 * Own the Profile transaction separately from the Mode transaction.
	 *
	 * Both engines hold a single-slot `ContextTransitionLease`. Sharing one engine
	 * meant a Mode compaction, or a Profile notice left unanswered by a reloaded
	 * webview, pinned that slot and made every later Profile switch report
	 * `in_progress` forever. A Profile switch never compacts, so it needs no
	 * mutual exclusion with Mode and must never be blocked by one.
	 */
	private readonly profileTransitionEngine: ContextTransitionEngine
	private readonly modeSwitchCoordinator: ModeSwitchCoordinator
	private readonly profileSwitchCoordinator: ProfileSwitchCoordinator
	private nextStateRevision = 0
	private latestStateRevision = 0
	/** Pending coalescing window for non-immediate state publications. */
	private pendingStatePostTimer?: ReturnType<typeof setTimeout>
	/**
	 * Last history projection, keyed by the array it was computed from.
	 *
	 * The cached history is replaced wholesale on every update rather than
	 * mutated, so the array reference identifies its contents. A state
	 * publication that carries an unchanged history therefore reuses this
	 * instead of re-sorting and re-projecting every entry.
	 */
	private taskHistoryProjectionCache?: {
		source: readonly HistoryItem[]
		items: ReturnType<typeof projectTaskHistory>["items"]
	}

	/**
	 * Snapshot the currently effective resource toggles for a newly created task.
	 *
	 * Locally discovered resources resolve through the scope chain, so a workspace
	 * override is inherited while an untouched resource stays at its default.
	 */
	private getInheritedTaskCapabilityToggles(): TaskCapabilityToggles {
		return createTaskCapabilityToggles({
			globalClineRulesToggles: this.stateManager.getGlobalSettingsKey("globalClineRulesToggles") || {},
			localClineRulesToggles: this.readLocalCapabilityToggles("rules"),
			localCursorRulesToggles: this.readLocalCapabilityToggles("cursorRules"),
			localWindsurfRulesToggles: this.readLocalCapabilityToggles("windsurfRules"),
			localAgentsRulesToggles: this.readLocalCapabilityToggles("agentsRules"),
			globalWorkflowToggles: this.stateManager.getGlobalSettingsKey("globalWorkflowToggles") || {},
			localWorkflowToggles: this.readLocalCapabilityToggles("workflows"),
			globalSkillsToggles: this.stateManager.getGlobalSettingsKey("globalSkillsToggles") || {},
			localSkillsToggles: this.readLocalCapabilityToggles("skills"),
			remoteSkillsToggles: this.stateManager.getGlobalStateKey("remoteSkillsToggles") || {},
			remoteRulesToggles: this.stateManager.getGlobalStateKey("remoteRulesToggles") || {},
			remoteWorkflowToggles: this.stateManager.getGlobalStateKey("remoteWorkflowToggles") || {},
			globalSubagentsToggles: this.stateManager.getGlobalSettingsKey("globalSubagentsToggles") || {},
			localSubagentsToggles: this.readLocalCapabilityToggles("subagents"),
			mcpServers: Object.fromEntries(this.getMcpServersForOwner().map((server) => [server.name, server.disabled !== true])),
		})
	}

	/**
	 * Resolve the effective state of every locally discovered resource of one kind.
	 *
	 * Two independent facts are combined here. Discovery says which resources
	 * exist; the scope chain says what the user explicitly decided. An override
	 * is sparse, so a path that is absent there inherits the discovery default
	 * instead of reading as disabled — publishing the override map on its own
	 * would leave the panel empty until the user toggled something.
	 */
	private readLocalCapabilityToggles(kind: CapabilityKind): Record<string, boolean> {
		const overrides = mergeScopedToggles(readScopedToggles(this.stateManager, kind))
		const discovered = readDiscoveredToggles(this as unknown as Controller, kind)
		const resolved: Record<string, boolean> = {}
		for (const [resourcePath, enabled] of Object.entries(discovered)) {
			const id = capabilityResourceId(resourcePath)
			resolved[resourcePath] = overrides[id] ?? overrides[resourcePath] ?? enabled
		}
		return resolved
	}

	private applyWorkspaceMcpServerToggles(servers: readonly McpServer[]): McpServer[] {
		const toggles = this.stateManager.getWorkspaceStateKey("mcpServersToggles") || {}
		return projectMcpServersWithToggleOverrides(servers, toggles)
	}

	getMcpServersForOwner(): McpServer[] {
		return this.applyWorkspaceMcpServerToggles(this.mcpHub.getAllServersForOwner(this.mcpOwnerId))
	}

	async getLatestMcpServersForOwner(): Promise<McpServer[]> {
		await this.ensureWorkspaceMcpDescriptors()
		return this.applyWorkspaceMcpServerToggles(await this.mcpHub.getLatestMcpServersRPC(this.mcpOwnerId))
	}

	setWorkspaceMcpServerEnabled(serverName: string, enabled: boolean): void {
		const toggles = { ...(this.stateManager.getWorkspaceStateKey("mcpServersToggles") || {}) }
		toggles[serverName] = enabled
		this.stateManager.setWorkspaceState("mcpServersToggles", toggles)
	}

	private updateWorkspaceMcpRegistration(workspaceRoots?: readonly string[]): Promise<void> {
		const generation = ++this.workspaceMcpRegistrationGeneration
		const registration = (async () => {
			const roots = workspaceRoots ?? (await HostProvider.workspace.getWorkspacePaths({})).paths
			if (this.disposed || generation !== this.workspaceMcpRegistrationGeneration) return
			await this.mcpHub.registerWorkspaceOwner(this.mcpOwnerId, roots)
			this.task?.invalidatePromptFreshness("mcp_registry")
		})().catch((error) => {
			Logger.error("[Controller] Failed to register workspace MCP descriptors:", error)
		})
		this.workspaceMcpRegistration = registration
		return registration
	}

	async ensureWorkspaceMcpDescriptors(): Promise<void> {
		await this.workspaceMcpRegistration
	}

	/**
	 * Resolve the workspace-scoped ignore rules, loading them at most once.
	 *
	 * Concurrent callers share one in-flight load. A changed workspace root
	 * replaces the instance because the rules belong to that root.
	 */
	async ensureIgnoreController(cwd: string): Promise<IgnoreController> {
		const resolvedCwd = path.resolve(cwd)
		if (this.ignoreController && this.ignoreControllerCwd === resolvedCwd) {
			return this.ignoreController
		}
		if (this.ignoreControllerSetup && this.ignoreControllerCwd === resolvedCwd) {
			return await this.ignoreControllerSetup
		}

		const previous = this.ignoreController
		this.ignoreControllerCwd = resolvedCwd
		this.ignoreController = undefined
		const controller = new IgnoreController(resolvedCwd)
		this.ignoreControllerSetup = controller
			.initialize()
			.then(() => {
				this.ignoreController = controller
				return controller
			})
			.finally(() => {
				this.ignoreControllerSetup = undefined
			})

		// Release the superseded instance's watcher only after the replacement is
		// in flight, so a failed load cannot leave the workspace without rules.
		if (previous) void previous.dispose().catch(() => undefined)
		return await this.ignoreControllerSetup
	}

	/** Return the loaded ignore rules, or undefined before the first load completes. */
	getIgnoreController(): IgnoreController | undefined {
		return this.ignoreController
	}

	// Timer for periodic remote config fetching
	private remoteConfigTimer?: NodeJS.Timeout
	// Timer for periodic account usage polling
	private accountUsageTimer?: NodeJS.Timeout
	private accountUsageHandler?: ApiHandler
	private accountUsagePollGeneration = 0
	private accountUsagePolling = false
	private accountUsagePollingEnabled = true
	private disposed = false
	private uiDetached = false
	private stateBuildsAfterDetach = 0
	private suppressedStatePostsAfterDetach = 0
	private workspaceMcpRegistration: Promise<void> = Promise.resolve()
	private workspaceMcpRegistrationGeneration = 0
	/**
	 * Workspace-scoped exclusion rules shared by every Task on this Controller.
	 *
	 * Rules are workspace state, not Task state: a per-Task instance re-read and
	 * re-watched the same files for each Task and let discovery, checkpoints and
	 * prompt-input watching drift apart.
	 */
	private ignoreController?: IgnoreController
	private ignoreControllerSetup?: Promise<IgnoreController>
	private ignoreControllerCwd?: string
	/** Shared in-flight workspace root detection, so concurrent callers spawn one `git` sweep. */
	private workspaceManagerSetup?: Promise<WorkspaceRootManager | undefined>
	// Timer for periodic lock heartbeat (keeps .lock file fresh)
	private lockHeartbeatTimer?: NodeJS.Timeout
	// Timer for polling lock status when task is in read-only mode
	private lockPollTimer?: NodeJS.Timeout
	// Invalidates poll rounds that are already suspended on an await
	private lockPollGeneration = 0
	// Whether the current task has an active lock
	private taskLockAcquired = false
	// Account usage data (refreshed every 60s, zero overhead on state push)
	private _accountUsage?: AccountUsage
	private accountUsageProfileKey?: string
	// Disposal function returned by StateManager.registerCallbacks().
	// Invoked in dispose() to unregister this controller from global
	// state-change notifications so closed windows don't keep receiving them.
	private stateManagerCallbacksDispose?: () => void
	private mcpPromptCatalogDispose?: () => void
	private openAiCodexRuntimeMutationDispose?: () => void

	/** Public getter for account usage data, used by subscribeToState/getLatestState. */
	getAccountUsage(): AccountUsage | undefined {
		return this._accountUsage
	}

	private isActiveProviderUsageProfile(profileId: string): boolean {
		const taskId = this.task?.taskId
		const apiConfig = this.stateManager.getApiConfigurationForTask(taskId)
		const mode = this.stateManager.getSettingsKeyForTask("mode", taskId) || "act"
		const profileReference =
			mode === "plan"
				? (apiConfig.planModeProfileId ?? apiConfig.planModeProfile)
				: (apiConfig.actModeProfileId ?? apiConfig.actModeProfile)
		const resolution = resolveProfileReference(readApiProfiles(), profileReference)
		return resolution.status === "resolved" && resolution.profile.id === profileId
	}

	/** Publish a shared snapshot only when its Profile is still active for the current mode. */
	async publishAccountUsageSnapshot(profileId: string, usage: AccountUsage): Promise<void> {
		if (!this.isActiveProviderUsageProfile(profileId)) return
		if (JSON.stringify(this._accountUsage) === JSON.stringify(usage)) return
		this._accountUsage = usage
		await sendAccountUsageUpdate(this, usage)
	}

	private buildProviderUsageHandler(profileId: string) {
		const normalizedProfileId = profileId.trim()
		if (normalizedProfileId.length === 0) throw new Error("A Provider Profile ID is required.")
		const profile = readApiProfiles().find((candidate) => candidate.id === normalizedProfileId && candidate.enabled !== false)
		if (!profile) throw new Error("The requested Provider Profile does not exist.")
		const taskId = this.task?.taskId
		const apiConfiguration = this.stateManager.getApiConfigurationForTask(taskId)
		const mode = this.stateManager.getSettingsKeyForTask("mode", taskId) || "act"
		return { profile, handler: buildApiHandlerFromProfile(apiConfiguration, mode, profile) }
	}

	/** Load one Profile's shared usage capability without introducing a second provider-specific service. */
	async loadProviderUsageSnapshot(profileId: string): Promise<AccountUsage> {
		const target = this.buildProviderUsageHandler(profileId)
		try {
			const usage = decorateProviderAccountUsage(
				target.profile,
				target.handler.getAccountUsage ? await target.handler.getAccountUsage() : undefined,
			) ?? {
				profileId: target.profile.id,
				providerId: target.profile.provider,
				currency: "",
				isAvailable: false,
			}
			await this.publishAccountUsageSnapshot(target.profile.id, usage)
			return usage
		} finally {
			target.handler.abort?.()
		}
	}

	/** Execute and refresh one reset-credit action through the selected Provider handler. */
	async consumeProviderUsageResetCredit(
		profileId: string,
		creditId: string,
	): Promise<{ result: AccountUsageResetResult; usage: AccountUsage }> {
		const target = this.buildProviderUsageHandler(profileId)
		try {
			if (!target.handler.consumeAccountUsageResetCredit) {
				throw new Error("The selected Provider does not support account usage reset credits.")
			}
			const result = await target.handler.consumeAccountUsageResetCredit(creditId)
			accountUsageCoordinator.deleteByPrefix(`${target.profile.id}:`)
			const usage = decorateProviderAccountUsage(
				target.profile,
				target.handler.getAccountUsage ? await target.handler.getAccountUsage() : undefined,
			) ?? {
				profileId: target.profile.id,
				providerId: target.profile.provider,
				currency: "",
				isAvailable: false,
			}
			await this.publishAccountUsageSnapshot(target.profile.id, usage)
			return { result, usage }
		} finally {
			target.handler.abort?.()
		}
	}

	// Public getter for workspace manager with lazy initialization - To get workspaces when task isn't initialized (Used by file mentions)
	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		if (this.workspaceManager) {
			return this.workspaceManager
		}
		// Root detection spawns `git` child processes for every workspace folder.
		// Concurrent callers previously each started their own detection because the
		// only guard was the resolved field. Share one in-flight setup instead.
		this.workspaceManagerSetup ??= setupWorkspaceManager({
			stateManager: this.stateManager,
			detectRoots: detectWorkspaceRoots,
		})
			.then(async (manager) => {
				this.workspaceManager = manager
				await this.updateWorkspaceMcpRegistration(manager.getRoots().map((root) => root.path))
				return manager
			})
			.catch((error) => {
				Logger.error("[Controller] Failed to initialize workspace manager:", error)
				return undefined
			})
			.finally(() => {
				this.workspaceManagerSetup = undefined
			})
		return await this.workspaceManagerSetup
	}

	// Synchronous getter for workspace manager
	getWorkspaceManager(): WorkspaceRootManager | undefined {
		return this.workspaceManager
	}

	/**
	 * Starts the periodic remote config fetching timer
	 * Fetches immediately and then every hour
	 */
	private startRemoteConfigTimer() {
		// Initial fetch
		fetchRemoteConfig(this)
		// Set up 1-hour interval
		this.remoteConfigTimer = setInterval(() => fetchRemoteConfig(this), 3600000) // 1 hour
	}

	constructor(readonly context: ClineExtensionContext) {
		Session.reset() // Reset session on controller initialization
		this.stateManager = StateManager.get()
		this.globalConfigurationManager = new GlobalConfigurationManager(() =>
			createGlobalConfigurationSnapshot(this.stateManager),
		)
		this.globalConfigurationManager.register({
			id: "terminal",
			configure: (snapshot) => this.configureTerminal(snapshot),
		})
		this.openAiCodexRuntimeMutationDispose = openAiCodexOAuthManager.subscribeToRuntimeMutations((event) =>
			this.handleOpenAiCodexRuntimeMutation(event).catch(() =>
				Logger.error("[CodexRuntime] Failed to invalidate the target Profile runtime."),
			),
		)
		this.stateManagerCallbacksDispose = StateManager.get().registerCallbacks({
			onPersistenceError: async ({ error }: PersistenceErrorEvent) => {
				// Just log - don't call reInitialize() (that sets isInitialized=false which
				// breaks running tasks) and don't show a warning (data is safe in memory
				// and will be retried automatically on the next debounced persistence).
				Logger.error("[Controller] Storage persistence failed (will retry):", error)
			},
			onSyncExternalChange: async (event) => {
				const startedAt = performance.now()
				const changedKeys = event.source === "settings" ? event.commit.changedKeys : []
				await this.configureGlobalComponents()
				if (changedKeys.some((key) => ACCOUNT_USAGE_BINDING_SETTINGS.has(key))) {
					this.restartAccountUsagePolling()
				}
				const configureMs = Math.round(performance.now() - startedAt)
				if (event.source === "settings" && this.task && settingsAffectPromptFreshness(event.commit.changedKeys)) {
					const freshnessStartedAt = performance.now()
					await this.task.flushPromptFreshnessInvalidation("settings")
					recordPerfPhase(
						PerfDomain.Settings,
						"controller_callback",
						performance.now() - startedAt,
						{
							source: event.source,
							changedKeys: changedKeys.length,
							configureMs,
							freshnessMs: Math.round(performance.now() - freshnessStartedAt),
							outcome: "freshness_publish",
						},
						{ taskId: this.task.taskId },
					)
					if (Logger.isDebugEnabled()) {
						Logger.debug(
							`[SettingsPerf] phase=controller_callback taskId=${this.task.taskId} source=${event.source} keys=${changedKeys.join(",") || "none"} configureMs=${configureMs} freshnessMs=${Math.round(performance.now() - freshnessStartedAt)} totalMs=${Math.round(performance.now() - startedAt)} outcome=freshness_publish`,
						)
					}
					return
				}
				const publishStartedAt = performance.now()
				await this.postStateToWebview()
				recordPerfPhase(
					PerfDomain.Settings,
					"controller_callback",
					performance.now() - startedAt,
					{
						source: event.source,
						changedKeys: changedKeys.length,
						configureMs,
						publishMs: Math.round(performance.now() - publishStartedAt),
						outcome: "state_publish",
					},
					{ taskId: this.task?.taskId },
				)
				if (Logger.isDebugEnabled()) {
					Logger.debug(
						`[SettingsPerf] phase=controller_callback taskId=${this.task?.taskId ?? "none"} source=${event.source} keys=${changedKeys.join(",") || "none"} configureMs=${configureMs} publishMs=${Math.round(performance.now() - publishStartedAt)} totalMs=${Math.round(performance.now() - startedAt)} outcome=state_publish`,
					)
				}
			},
		})
		this.authService = AuthService.getInstance(this)
		this.ocaAuthService = OcaAuthService.initialize(this)
		this.accountService = ClineAccountService.getInstance()
		this.contextTransitionEngine = this.createContextTransitionEngine()
		this.profileTransitionEngine = this.createContextTransitionEngine()
		this.modeSwitchCoordinator = this.createModeSwitchCoordinator()
		this.profileSwitchCoordinator = this.createProfileSwitchCoordinator()

		this.authService.restoreRefreshTokenAndRetrieveAuthInfo().then(() => {
			this.startRemoteConfigTimer()
		})

		this.mcpHub = McpHub.getSharedInstance(
			() => ensureMcpServersDirectoryExists(),
			() => ensureSettingsDirectoryExists(),
			ExtensionRegistryInfo.version,
			telemetryService,
		)
		this.mcpPromptCatalogDispose = this.mcpHub.subscribeToPromptCatalogChanges(() => {
			this.task?.invalidatePromptFreshness("mcp_registry")
		})
		void this.updateWorkspaceMcpRegistration()

		// Clean up legacy checkpoints
		cleanupLegacyCheckpoints().catch((error) => {
			Logger.error("Failed to cleanup legacy checkpoints:", error)
		})

		// Initialize lock service with file-based locks under the tasks directory
		const tasksBasePath = path.join(getDlineDocumentsPathSync(), "tasks")
		this.lockService = new TaskLockService(tasksBasePath, `vscode-${crypto.randomUUID()}`)

		// Start account usage polling. Network requests are deduplicated process-wide.
		this.startAccountUsagePolling()
		this.scheduleTaskCompletionBackfill()
		Logger.log("[Controller] ClineProvider instantiated")
	}

	/** Report whether this history already satisfies the current repair generation. */
	private hasCurrentTaskCompletionBackfillGeneration(): boolean {
		return this.stateManager.getGlobalStateKey("taskCompletionBackfillGeneration") >= TASK_COMPLETION_BACKFILL_GENERATION
	}

	/**
	 * Repair completion projections damaged by earlier versions, off the startup path.
	 *
	 * A damaged row cannot heal itself while nobody opens that Task, so the scan
	 * reads each Task's canonical snapshot. That is expensive, so it stays fully
	 * detached from startup: nothing awaits it, it is deferred well past
	 * activation, it runs at most once per process, and it runs at most once per
	 * repair generation.
	 */
	private scheduleTaskCompletionBackfill(): void {
		if (this.hasCurrentTaskCompletionBackfillGeneration()) return
		// Process-level single-flight: every Controller shares the same history
		// file, so a second scheduled scan would only multiply full-file reads
		// and durable transactions without repairing anything new.
		if (Controller.taskCompletionBackfillScheduled) return
		Controller.taskCompletionBackfillScheduled = true

		// Detached on purpose: the timer is unref'd and the run is not awaited by
		// any startup path, so the scan can never interleave with activation IO.
		const timer = setTimeout(() => {
			void this.runTaskCompletionBackfill().catch((error) =>
				Logger.debug(`[Controller] Task completion backfill skipped: ${error}`),
			)
		}, TASK_COMPLETION_BACKFILL_DELAY_MS)
		timer.unref?.()
	}

	private async runTaskCompletionBackfill(): Promise<void> {
		if (this.disposed) return
		// The marker may have been raised durably by another window while the
		// timer was pending; re-check before paying for the scan.
		if (this.hasCurrentTaskCompletionBackfillGeneration()) return

		const backfill = new TaskCompletionBackfill({
			listTasks: () => this.stateManager.taskHistory.getDeduplicated(),
			readCompletion: (taskId) => readPersistedTaskCompletion(taskId),
			persistBatch: (updates) => this.persistTaskCompletionStates(updates),
			onRepaired: async () => {
				await this.postStateToWebview()
			},
		})

		const result = await backfill.run()
		// Mark the migration done even when some rows failed: a failed row keeps
		// its current projection and is repaired when its Task is next opened, so
		// rescanning the whole history on every launch would buy nothing.
		this.stateManager.setGlobalState("taskCompletionBackfillGeneration", TASK_COMPLETION_BACKFILL_GENERATION)
		if (result.repaired > 0 || result.failed > 0) {
			Logger.info(
				`[Controller] Task completion backfill: scanned=${result.scanned}, repaired=${result.repaired}, failed=${result.failed}`,
			)
		}
	}

	/** Apply the latest global configuration snapshot to every registered runtime component. */
	async configureGlobalComponents(): Promise<GlobalConfigurationResult> {
		const result = await this.globalConfigurationManager.configureAll()
		if (result.durationMs >= 100) {
			Logger.debug(
				`[GlobalConfiguration] slow configuration: components=${result.components.length}, durationMs=${result.durationMs.toFixed(2)}`,
			)
		}
		return result
	}

	private configureTerminal(snapshot: GlobalConfigurationSnapshot): void {
		if (!this.task) return
		const result = this.task.configureTerminal(snapshot.terminal)
		if (result.closedCount > 0) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Closed ${result.closedCount} ${result.closedCount === 1 ? "terminal" : "terminals"} with different profile.`,
			})
		}
		if (result.busyTerminals.length > 0) {
			const count = result.busyTerminals.length
			HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message:
					`${count} busy ${count === 1 ? "terminal has" : "terminals have"} a different profile. ` +
					`Close ${count === 1 ? "it" : "them"} to use the new profile for all commands.`,
			})
		}
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	/** Return whether this controller can still accept UI subscriptions and updates. */
	isUiAttached(): boolean {
		return !this.uiDetached && !this.disposed
	}

	/** Detach the UI synchronously before asynchronous task and service cleanup starts. */
	detachUi(): void {
		if (this.uiDetached) return
		this.uiDetached = true
		this.clearPendingStatePost()
		this.stopAccountUsagePolling()
		const cleanup = cleanupStateSubscriptions(this)
		Logger.debug(
			`[Controller] UI detached: taskId=${this.task?.taskId ?? "none"}, subscribers=${cleanup.subscriberCount}, pendingState=${cleanup.hadPendingUpdate}, debounceTimer=${cleanup.hadDebounceTimer}, sendChain=${cleanup.hadSendChain}`,
		)
	}

	async dispose() {
		const disposeStartedAtMs = performance.now()
		const taskId = this.task?.taskId ?? "none"
		this.detachUi()
		this.disposed = true
		this.openAiCodexRuntimeMutationDispose?.()
		this.openAiCodexRuntimeMutationDispose = undefined
		// Clear the remote config timer
		if (this.remoteConfigTimer) {
			clearInterval(this.remoteConfigTimer)
			this.remoteConfigTimer = undefined
		}

		// Stop the account usage polling timer to prevent background
		// postStateToWebview calls after the controller is disposed.
		this.stopAccountUsagePolling()
		// Release the workspace ignore watchers with the window that owns them.
		const ignoreController = this.ignoreController
		this.ignoreController = undefined
		this.ignoreControllerCwd = undefined
		if (ignoreController) {
			void ignoreController.dispose().catch((error) => Logger.error("[Controller] Failed to dispose ignore rules:", error))
		}

		await this.clearTask()
		// Window shutdown is the one path that must observe a fully closed task:
		// its stores and locks may not outlive this process.
		await this.pendingTaskTeardown
		await this.workspaceHistoryManager
			?.flush()
			.catch((error) => Logger.error("[WorkspaceHistoryManager] Shutdown durability flush failed:", error))
		this.mcpPromptCatalogDispose?.()
		this.mcpPromptCatalogDispose = undefined
		await this.workspaceMcpRegistration
		await this.mcpHub.unregisterWorkspaceOwner(this.mcpOwnerId)
		await this.mcpHub.dispose()

		// Clean up lock resources
		this.lockService.cleanupOrphaned().catch((e) => Logger.error("Lock cleanup failed:", e))

		// Clean up per-controller gRPC subscription sets so dead streams
		// from MCP / model updates don't accumulate in global maps.
		const { cleanupMcpSubscriptions } = await import("./mcp/subscribeToMcpServers")
		const { cleanupOpenRouterSubscriptions } = await import("./models/subscribeToOpenRouterModels")
		const { cleanupLiteLlmSubscriptions } = await import("./models/subscribeToLiteLlmModels")
		cleanupMcpSubscriptions(this)
		cleanupOpenRouterSubscriptions(this)
		cleanupLiteLlmSubscriptions(this)

		// Unregister from StateManager so this controller no longer
		// receives external state-change notifications.
		this.stateManagerCallbacksDispose?.()

		const cleanupMs = Math.round(performance.now() - disposeStartedAtMs)
		Logger.debug(
			`[Controller] dispose timing: taskId=${taskId}, cleanupMs=${cleanupMs}, stateBuildsAfterDetach=${this.stateBuildsAfterDetach}, suppressedStatePosts=${this.suppressedStatePostsAfterDetach}`,
		)
		Logger.error("Controller disposed")
	}

	// Auth methods
	async handleSignOut() {
		try {
			// AuthService now handles its own storage cleanup in handleDeauth()
			this.stateManager.setGlobalState("userInfo", undefined)
			clearRemoteConfig()

			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of Cline",
			})
		} catch (_error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Logout failed",
			})
		}
	}

	// Oca Auth methods
	async handleOcaSignOut() {
		try {
			await this.ocaAuthService.handleDeauth(LogoutReason.USER_INITIATED)
			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of OCA",
			})
		} catch (_error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "OCA Logout failed",
			})
		}
	}

	async setUserInfo(info?: UserInfo) {
		this.stateManager.setGlobalState("userInfo", info)
	}

	async initTask(
		task?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		options?: InitTaskOptions,
	) {
		const initStartedAt = performance.now()
		let stageStartedAt = initStartedAt
		const initKind = historyItem ? "history" : task || images || files ? "new" : "empty"
		const logInitStage = (phase: string, taskId = historyItem?.id ?? "pending", details = "") => {
			const now = performance.now()
			recordPerfPhase(
				PerfDomain.TaskInit,
				"stage",
				now - stageStartedAt,
				{ stage: phase, kind: initKind, elapsedMs: Math.round(now - initStartedAt) },
				{ taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[TaskInitPerf] phase=${phase} taskId=${taskId} kind=${initKind} durationMs=${Math.round(now - stageStartedAt)} elapsedMs=${Math.round(now - initStartedAt)}${details ? ` ${details}` : ""}`,
				)
			}
			stageStartedAt = now
		}
		// Fire-and-forget: We intentionally don't await fetchRemoteConfig here.
		// Remote config is already fetched in startRemoteConfigTimer() which runs in the constructor,
		// so enterprise policies (yoloModeAllowed, allowedMCPServers, etc.) are already applied.
		// This call just ensures we have the latest state, but we shouldn't block the UI for it.
		// getGlobalSettingsKey() reads from remoteConfigCache on each call, so any updates
		// will apply as soon as this fetch completes. The function also calls postStateToWebview()
		// when done and catches all errors internally.
		fetchRemoteConfig(this)

		if (!options?.skipInitialClear) {
			await this.clearTask()
			logInitStage("initial_clear")
		}

		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		const vscodeTerminalExecutionMode = this.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
		const terminalOutputLineLimit = this.stateManager.getGlobalSettingsKey("terminalOutputLineLimit")
		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		const isNewUser = this.stateManager.getGlobalStateKey("isNewUser")
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")

		const NEW_USER_TASK_COUNT_THRESHOLD = 10

		// Check if the user has completed enough tasks to no longer be considered a "new user"
		if (isNewUser && !historyItem && taskHistory && taskHistory.length >= NEW_USER_TASK_COUNT_THRESHOLD) {
			this.stateManager.setGlobalState("isNewUser", false)
			await this.postStateToWebview()
		}

		if (autoApprovalSettings && !historyItem) {
			const updatedAutoApprovalSettings = {
				...autoApprovalSettings,
				version: (autoApprovalSettings.version ?? 1) + 1,
			}
			this.stateManager.setGlobalState("autoApprovalSettings", updatedAutoApprovalSettings)
		}

		// Initialize and persist the workspace manager (multi-root or single-root) with telemetry + fallback.
		// Detection spawns `git` per workspace folder and its result never changes for
		// the lifetime of this controller, so reuse the resolved manager instead of
		// re-detecting on the critical path of every task start.
		await this.ensureWorkspaceManager()
		logInitStage("workspace_manager")

		const cwd = this.workspaceManager?.getPrimaryRoot()?.path || (await getCwd(getDesktopDir()))
		// Load workspace exclusion rules before the Task exists so its first
		// discovery, tool call and prompt-input scan all see the same rules.
		const ignoreController = await this.ensureIgnoreController(cwd)
		logInitStage("ignore_controller")

		const taskId = historyItem?.id || Date.now().toString()
		const workspaceHistoryManager = this.resolveWorkspaceHistoryManager(cwd)
		const workspaceHistorySession = workspaceHistoryManager.beginTask(taskId)
		this.workspaceHistorySession = workspaceHistorySession

		// Acquire task lock via lock service
		this.taskLockAcquired = await this.lockService.acquireTaskLock(taskId)
		if (this.taskLockAcquired) {
			Logger.debug(`[Task ${taskId}] Task lock acquired`)
			this.startLockHeartbeat(taskId)
		} else {
			Logger.debug(`[Task ${taskId}] Task locked by another instance - read-only mode`)
			// Start polling for lock release in the background
			this.startLockPoll(taskId)
		}
		logInitStage("task_lock", taskId, `acquired=${this.taskLockAcquired}`)

		await this.stateManager.loadTaskSettings(taskId)
		logInitStage("task_settings", taskId)
		if (taskSettings) {
			this.stateManager.setTaskSettingsBatch(taskId, taskSettings)
		}

		// Freeze resource enablement at task creation. Resumed tasks keep their
		// persisted snapshot; only legacy tasks without one inherit current state.
		const initialTaskCache = this.stateManager.getTaskCacheRef(taskId)
		if (typeof initialTaskCache.taskCapabilityToggles !== "string") {
			this.stateManager.setTaskSettings(
				taskId,
				"taskCapabilityToggles",
				serializeTaskCapabilityToggles(this.getInheritedTaskCapabilityToggles()),
			)
		}

		// New task: inherit mode from the welcome-screen global setting.
		// Resumed tasks already have their mode persisted via loadTaskSettings.
		const taskCache = this.stateManager.getTaskCacheRef(taskId)
		if (!taskCache.mode) {
			const globalMode = this.stateManager.getGlobalSettingsKey("mode")
			this.stateManager.setTaskSettings(taskId, "mode", globalMode || "plan")
			Logger.debug(`[Task ${taskId}] initialized task-level mode from global: ${globalMode || "plan"}`)
		}

		// If restoring from history and HistoryItem has provider info, inject it
		// as task-specific settings so the task resumes with the same provider.
		// Mode is persisted separately via setTaskSettings in togglePlanActMode
		// and restored by loadTaskSettings above �?do NOT override it from historyItem.
		const uiMessage = await UIMessage.open(taskId)
		const apiConversation = await ApiConversation.open(taskId)
		logInitStage("message_stores_open", taskId)

		this.task = new Task({
			controller: this,
			mcpHub: this.mcpHub,
			updateTaskHistory: (historyItem) => workspaceHistoryManager.publishMetadata(historyItem, workspaceHistorySession),
			persistTaskCompletionState: (projectionTaskId, isCompleted, revision) =>
				workspaceHistoryManager.publishCompletion(
					{ taskId: projectionTaskId, isCompleted, revision },
					workspaceHistorySession,
				),
			publishTaskHistoryClose: () => workspaceHistoryManager.closeTask(workspaceHistorySession),
			postStateToWebview: (options) => this.postStateToWebview(options),
			reinitExistingTaskFromId: (taskId) => this.reinitExistingTaskFromId(taskId),
			cancelTask: () => this.cancelTask(),
			shellIntegrationTimeout,
			terminalReuseEnabled: terminalReuseEnabled ?? true,
			terminalOutputLineLimit: terminalOutputLineLimit ?? 500,
			defaultTerminalProfile: defaultTerminalProfile ?? "default",
			vscodeTerminalExecutionMode,
			cwd,
			ignoreController,
			stateManager: this.stateManager,
			workspaceManager: this.workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			uiMessage,
			apiConversation,
		})
		logInitStage("task_construct", taskId)
		this.restartAccountUsagePolling()
		const taskInstance = this.task
		const initializedTaskId = taskInstance.taskId

		// Register this controller so active task discovery covers every initTask path.
		const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
		OrchestratorController.getInstance().registerController(initializedTaskId, this)

		void this.persistPanelStateIfNeeded(initializedTaskId)

		try {
			if (historyItem) {
				if (this.taskLockAcquired) taskInstance.beginHistoryPreparation()
				const remainsCurrent = await prepareHistoryTaskForDisplay({
					displayHistory: () => taskInstance.displayHistory(),
					prepareFromHistory: (prepareOptions) => taskInstance.prepareFromHistory(prepareOptions),
					hasTaskLock: this.taskLockAcquired,
					isCurrent: () => this.task === taskInstance,
					onPreparingToDisplay: options?.onHistoryTaskPreparingToDisplay,
					onReadyToDisplay: options?.onHistoryTaskReadyToDisplay,
				})
				logInitStage("history_prepare", initializedTaskId, `current=${remainsCurrent}`)
				if (!remainsCurrent) {
					return initializedTaskId
				}
				// Readonly (taskLockAcquired === false): display-only, no recovery actions.
				// Frontend shows a lock banner with a force-unlock button.
			} else if (task || images || files) {
				await startTaskLifecycle({
					taskId: initializedTaskId,
					startInBackground: options?.startInBackground === true,
					beforeStart: options?.beforeStart,
					start: () => taskInstance.startTask(task, images, files, options?.context, options?.initialUserContent),
					onBackgroundError: async (error) => {
						const message = error instanceof Error ? error.message : String(error)
						Logger.error(`[Task ${initializedTaskId}] Background task start failed:`, error)
						if (this.task === taskInstance) {
							await taskInstance.say("error", `Background task failed: ${message}`).catch((sayError) => {
								Logger.error(`[Task ${initializedTaskId}] Failed to present background task error:`, sayError)
							})
							await this.postStateToWebview().catch((postError) => {
								Logger.error(`[Task ${initializedTaskId}] Failed to post background task error state:`, postError)
							})
						}
						await options?.onBackgroundError?.(error, initializedTaskId)
					},
				})
			}
		} finally {
			// Polling is started once in the constructor and is a controller-
			// lifetime concern — it should NOT be restarted per-task to avoid
			// creating duplicate, un-clearable intervals.
		}

		// Brief yield to let the UI frame render before pushing state.
		// Previously was 1000ms; reduced to a single microtask tick since
		// history resumes can push immediate state before navigating.
		await new Promise((r) => setTimeout(r, 0))
		if (this.task !== taskInstance) {
			return initializedTaskId
		}
		await this.postStateToWebview()
		logInitStage("final_state_publish", initializedTaskId)
		if (this.task !== taskInstance) {
			return initializedTaskId
		}
		void this.syncPanelTitle()
		void this.persistPanelStateIfNeeded(initializedTaskId)

		return initializedTaskId
	}

	async reinitExistingTaskFromId(taskId: string) {
		const history = await this.getTaskWithId(taskId)
		if (history) {
			await this.initTask(undefined, undefined, undefined, history.historyItem)
		}
	}

	/**
	 * Records the usage reporting consent.
	 *
	 * Consent must be given, not merely left unanswered: an undecided user is
	 * treated the same as one who declined. This setting controls product
	 * analytics only; runtime diagnostics follow error-reporting consent.
	 */
	async updateUsageReportingSetting(usageReportingSetting: TelemetrySetting) {
		const wasOptedIn = isReportingAllowed(this.stateManager.getGlobalSettingsKey("usageReportingSetting"))
		const isOptedIn = isReportingAllowed(usageReportingSetting)

		// Capture opt-out event BEFORE updating (so it gets sent while telemetry is still enabled)
		if (wasOptedIn && !isOptedIn) {
			telemetryService.captureUserOptOut()
		}

		this.stateManager.setGlobalState("usageReportingSetting", usageReportingSetting)

		// Capture opt-in event AFTER updating (so telemetry is enabled to receive it)
		if (!wasOptedIn && isOptedIn) {
			telemetryService.captureUserOptIn()
		}

		// The method re-reads the stored consent, so it decides for itself
		// whether a prompt is warranted.
		void this.warnIfHostTelemetryDisabled()

		await this.postStateToWebview()
	}

	/**
	 * Tells the user when their opt-in cannot take effect.
	 *
	 * The host's telemetry level overrides the extension's setting, so a user
	 * who opts in on a host with telemetry disabled would otherwise see a
	 * setting that silently does nothing. The prompt lives here rather than in
	 * the telemetry service because host UI is a Controller responsibility.
	 *
	 * Called both when consent changes and when a webview initializes: a user
	 * who opted in during an earlier session never passes through the setting
	 * path again, so checking only there would leave them permanently
	 * unaware that the host is suppressing what they agreed to.
	 */
	async warnIfHostTelemetryDisabled(): Promise<void> {
		try {
			if (!isReportingAllowed(this.stateManager.getGlobalSettingsKey("usageReportingSetting"))) {
				return
			}

			if (!(await telemetryService.isHostTelemetryDisabled())) {
				return
			}

			const response = await HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message:
					"Anonymous Cline error and usage reporting is enabled, but IDE telemetry is disabled. To enable error and usage reporting for this extension, enable telemetry in IDE settings.",
				options: { items: ["Open Settings"] },
			})

			if (response.selectedOption === "Open Settings") {
				await HostProvider.window.openSettings({ query: "telemetry.telemetryLevel" })
			}
		} catch (error) {
			// A notification that cannot be shown must not fail the setting change.
			Logger.error("[Controller] Failed to check host telemetry level:", error)
		}
	}

	/**
	 * Records the error reporting consent.
	 *
	 * Independent of usage reporting: a user may want crashes and runtime
	 * diagnostics available without agreeing to product analytics, or the reverse.
	 * The error provider reads this key directly; the runtime diagnostics pipeline
	 * must also receive changes immediately so its journal and export stay aligned.
	 */
	async updateErrorReportingSetting(errorReportingSetting: TelemetrySetting) {
		this.stateManager.setGlobalState("errorReportingSetting", errorReportingSetting)

		// The runtime diagnostics pipeline holds its own consent state, decided
		// when it started. Applying changes here avoids requiring a window reload
		// before journaling starts or stops.
		try {
			await getRuntimeTelemetryLifecycle()?.applyConsent(errorReportingSetting)
		} catch (error) {
			// Diagnostics are an aid; failing to apply consent must not stop the
			// setting itself from being saved or the webview from being refreshed.
			Logger.error("[Controller] Failed to apply runtime diagnostics consent:", error)
		}

		await this.postStateToWebview()
	}

	/** Create one independently leased transition state owner for this Controller. */
	private createContextTransitionEngine(): ContextTransitionEngine {
		return new ContextTransitionEngine({
			lease: new ContextTransitionLease(),
			compaction: {
				compact: ({ trigger, operationId, targetApi, targetMode, chatContent, transition }) =>
					this.task?.compactForTransition(trigger, operationId, targetApi, targetMode, chatContent, transition) ??
					Promise.resolve("failed"),
				complete: (operationId) => this.task?.completeContextCompaction(operationId) ?? Promise.resolve(),
				abort: async (operationId, reason) => {
					await this.task?.abortContextCompaction(operationId, reason)
				},
			},
			postState: () => this.postStateToWebview({ immediate: true }),
			createId: () => randomUUID(),
		})
	}

	/** Build the Mode-specific policy and expose the compatibility RPC adapter. */
	private createModeSwitchCoordinator(): ModeSwitchCoordinator {
		const policy = new ModeTransitionPolicy({
			profiles: {
				getSource: () => (this.task ? this.resolveModeProfile(this.task.getMode()) : undefined),
				resolve: (mode) => this.resolveModeProfile(mode),
			},
			pressure: {
				read: (targetApi, targetMode, chatContent) =>
					this.task?.projectModeSwitchTargetUsage(targetApi, targetMode, chatContent) ?? Promise.resolve(0),
			},
			commit: {
				validate: (operation) => this.validateModeSwitch(operation),
				commit: async (operation) => {
					if (!this.task) throw new Error("Active task is unavailable.")
					await this.task.commitMode(operation.target.mode, operation.chatContent)
					telemetryService.captureModeSwitch(this.task.ulid, operation.target.mode)
					this.restartAccountUsagePolling()
					await this.postStateToWebview({ immediate: true })
				},
			},
			getTaskId: () => this.task?.taskId,
		})
		return new ModeSwitchCoordinator({ engine: this.contextTransitionEngine, policy })
	}

	/** Build the Profile policy that rebinds handlers behind at most one advisory notice. */
	private createProfileSwitchCoordinator(): ProfileSwitchCoordinator {
		const policy = new ProfileTransitionPolicy({
			bindings: {
				getCurrentMode: () => this.task?.getMode() ?? "plan",
				getBinding: (mode) => this.resolveTaskProfileName(mode),
				resolveTarget: (profileId, profileName, mode) => this.resolveProfileTarget(profileId, profileName, mode),
			},
			occupied: {
				getOccupiedTokens: () => this.task?.getOccupiedContextTokens() ?? 0,
			},
			commit: {
				validate: (operation) => this.validateProfileSwitch(operation),
				commit: async (operation) => {
					if (!this.task) throw new Error("Active task is unavailable.")
					await this.task.commitProfileBindings(
						{ profileId: operation.targetProfileId, profileName: operation.targetProfile },
						operation.targetModes,
					)
					this.restartAccountUsagePolling()
					await this.postStateToWebview({ immediate: true })
				},
			},
			getTaskId: () => this.task?.taskId,
		})
		return new ProfileSwitchCoordinator({ engine: this.profileTransitionEngine, policy })
	}

	/** Resolve the stable task-local Profile identity for one mode. */
	private resolveTaskProfileId(mode: Mode): string | undefined {
		if (!this.task) return undefined
		const config = this.stateManager.getApiConfigurationForTask(this.task.taskId)
		return mode === "plan"
			? (this.task.taskSm.planModeProfileId ?? config.planModeProfileId)
			: (this.task.taskSm.actModeProfileId ?? config.actModeProfileId)
	}

	/** Resolve the effective task-local Profile name for one mode. */
	private resolveTaskProfileName(mode: Mode): string | undefined {
		if (!this.task) return undefined
		const config = this.stateManager.getApiConfigurationForTask(this.task.taskId)
		return mode === "plan"
			? (this.task.taskSm.planModeProfile ?? config.planModeProfile)
			: (this.task.taskSm.actModeProfile ?? config.actModeProfile)
	}

	/** Resolve effective profile metadata for one task-local mode. */
	private resolveModeProfile(mode: Mode): ResolvedModeProfile | undefined {
		if (!this.task) return undefined
		const config = this.stateManager.getApiConfigurationForTask(this.task.taskId)
		const profileReference = this.resolveTaskProfileId(mode) ?? this.resolveTaskProfileName(mode)
		const resolution = resolveProfileReference(readApiProfiles(), profileReference)
		if (resolution.status !== "resolved") return undefined
		const providerContextWindow = getProfileModelInfo(resolution.profile).capabilities?.contextWindow
		if (!providerContextWindow) return undefined

		const effectiveConfig = {
			...config,
			...(this.task.taskSm.planModeProfileId !== undefined && { planModeProfileId: this.task.taskSm.planModeProfileId }),
			...(this.task.taskSm.planModeProfile !== undefined && { planModeProfile: this.task.taskSm.planModeProfile }),
			...(this.task.taskSm.actModeProfileId !== undefined && { actModeProfileId: this.task.taskSm.actModeProfileId }),
			...(this.task.taskSm.actModeProfile !== undefined && { actModeProfile: this.task.taskSm.actModeProfile }),
			...(mode === "plan"
				? { planModeProfileId: resolution.profileId, planModeProfile: resolution.profileName }
				: { actModeProfileId: resolution.profileId, actModeProfile: resolution.profileName }),
			ulid: this.task.ulid,
		}
		const executionApi = buildApiHandler(effectiveConfig, mode)
		const { targetContextWindow, compactTriggerTokens, fittingExitTarget } = resolveTargetContextScope({
			providerContextWindow,
			triggerPercent: this.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent"),
			minReserveTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
			maxReserveTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
			maxContextTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
		})
		return {
			mode,
			profileId: resolution.profileId,
			profile: resolution.profileName,
			contextWindow: targetContextWindow,
			triggerTokens: compactTriggerTokens,
			fittingExitTarget,
			executionApi,
		}
	}

	/** Resolve one user-selected Profile into a frozen active-mode request scope. */
	private resolveProfileTarget(profileId: string, profileName: string, mode: Mode): ResolvedProfileTarget | undefined {
		if (!this.task) return undefined
		const resolution = resolveProfileReference(readApiProfiles(), profileId)
		if (resolution.status !== "resolved" || resolution.profileName !== profileName) return undefined
		const providerContextWindow = getProfileModelInfo(resolution.profile).capabilities?.contextWindow
		if (!providerContextWindow) return undefined
		const config = this.stateManager.getApiConfigurationForTask(this.task.taskId)
		const effectiveConfig = {
			...config,
			...(mode === "plan"
				? { planModeProfileId: resolution.profileId, planModeProfile: resolution.profileName }
				: { actModeProfileId: resolution.profileId, actModeProfile: resolution.profileName }),
			ulid: this.task.ulid,
		}
		const executionApi = buildApiHandler(effectiveConfig, mode)
		const { targetContextWindow, compactTriggerTokens, fittingExitTarget } = resolveTargetContextScope({
			providerContextWindow,
			triggerPercent: this.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent"),
			minReserveTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
			maxReserveTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
			maxContextTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
		})
		return {
			profileId: resolution.profileId,
			profile: resolution.profileName,
			mode,
			contextWindow: targetContextWindow,
			triggerTokens: compactTriggerTokens,
			fittingExitTarget,
			executionApi,
		}
	}

	/** Validate task, source mode, and source profile immediately before compaction or commit. */
	private validateModeSwitch(operation: ModeSwitchOperation): boolean {
		const source = this.task ? this.resolveModeProfile(this.task.getMode()) : undefined
		return Boolean(
			this.task?.taskId === operation.taskId &&
				source?.mode === operation.source.mode &&
				source.profileId === operation.source.profileId &&
				source.contextWindow === operation.source.contextWindow,
		)
	}

	/** Validate every source binding captured before a Profile preflight. */
	private validateProfileSwitch(operation: ProfileSwitchOperation): boolean {
		if (this.task?.taskId !== operation.taskId || this.task.getMode() !== operation.activeMode) return false
		return operation.targetModes.every((mode) => this.resolveTaskProfileName(mode) === operation.sourceBindings[mode])
	}

	/** Reject Task-local runtime override changes while the active Task cannot safely replace its handler. */
	assertTaskRuntimeOverridesMutable(taskId: string): void {
		const task = this.task
		if (!task || task.taskId !== taskId) return

		const runtimeState = task.getRuntimeState()
		if (
			["initializing", "streaming", "resuming", "cancelling"].includes(runtimeState.phase) ||
			task.taskState.isStreaming ||
			task.taskState.isWaitingForFirstChunk
		) {
			throw new Error("Task runtime overrides cannot change while a request is active.")
		}
		if (task.getContextCompactionOperationId() || task.taskState.currentlySummarizing) {
			throw new Error("Task runtime overrides cannot change while context compaction is active.")
		}

		const transitionIsActive = (phase: string) => phase !== "idle" && phase !== "failed"
		const modeSwitch = this.modeSwitchCoordinator.getSnapshot()
		const profileSwitch = this.profileSwitchCoordinator.getSnapshot()
		if (
			(transitionIsActive(modeSwitch.phase) && (!modeSwitch.taskId || modeSwitch.taskId === taskId)) ||
			(transitionIsActive(profileSwitch.phase) && (!profileSwitch.taskId || profileSwitch.taskId === taskId))
		) {
			throw new Error("Task runtime overrides cannot change during a Profile or mode transition.")
		}
	}

	/** Request a task-local transaction or update the welcome-screen global mode. */
	async requestModeSwitch(targetMode: Mode, chatContent?: ChatContent): Promise<ModeSwitchRequestResult> {
		if (!this.task) {
			this.stateManager.setGlobalState("mode", targetMode)
			await this.postStateToWebview({ immediate: true })
			return { status: "switched", operationId: crypto.randomUUID() }
		}
		return this.modeSwitchCoordinator.request({ taskId: this.task.taskId, targetMode, chatContent })
	}

	/** Confirm the active mode-switch compaction transaction. */
	async confirmModeSwitch(operationId: string): Promise<ModeSwitchRequestResult> {
		return this.modeSwitchCoordinator.confirm(operationId)
	}

	/** Cancel the active mode-switch confirmation transaction. */
	async cancelModeSwitch(operationId: string): Promise<ModeSwitchRequestResult> {
		return this.modeSwitchCoordinator.cancel(operationId)
	}

	/** Request a confirmation-gated Profile transition for the active task. */
	async requestProfileSwitch(
		targetProfileReference: string,
		targetModes: Mode[],
		chatContent?: ChatContent,
	): Promise<ProfileSwitchRequestResult> {
		const resolution = resolveProfileReference(readApiProfiles(), targetProfileReference)
		if (resolution.status !== "resolved") {
			return { status: "rejected", error: resolution.error }
		}

		const uniqueModes = [...new Set(targetModes)]
		if (uniqueModes.length === 0) {
			return { status: "rejected", error: "Profile switch requires at least one target mode." }
		}

		if (!this.task) {
			const updates: Partial<Settings> = {}
			for (const mode of uniqueModes) {
				if (mode === "plan") {
					updates.planModeProfileId = resolution.profileId
					updates.planModeProfile = resolution.profileName
				} else {
					updates.actModeProfileId = resolution.profileId
					updates.actModeProfile = resolution.profileName
				}
			}
			this.stateManager.setGlobalStateBatch(updates)
			await this.stateManager.flushPendingState()
			this.restartAccountUsagePolling()
			await this.postStateToWebview({ immediate: true })
			return { status: "switched", operationId: randomUUID() }
		}

		return this.profileSwitchCoordinator.request({
			taskId: this.task.taskId,
			targetProfileId: resolution.profileId,
			targetProfile: resolution.profileName,
			targetModes: uniqueModes,
			chatContent,
		})
	}

	async confirmProfileSwitch(operationId: string): Promise<ProfileSwitchRequestResult> {
		return this.profileSwitchCoordinator.confirm(operationId)
	}

	async cancelProfileSwitch(operationId: string): Promise<ProfileSwitchRequestResult> {
		return this.profileSwitchCoordinator.cancel(operationId)
	}

	/** Compatibility wrapper for internal callers that still consume a Boolean commit result. */
	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		const result = await this.requestModeSwitch(modeToSwitchTo, chatContent)
		return result.status === "switched"
	}

	async toggleActModeForYoloMode(): Promise<boolean> {
		if (!this.task) return false
		await this.task.commitMode("act")
		telemetryService.captureModeSwitch(this.task.ulid, "act")
		this.restartAccountUsagePolling()
		await this.postStateToWebview({ immediate: true })
		return true
	}

	async cancelTask() {
		if (this.cancelInProgress || !this.task) {
			return
		}
		this.cancelInProgress = true
		try {
			this.updateBackgroundCommandState(false)
			const result = await this.task.requestCancellation()
			if (!result.accepted) {
				Logger.warn(`Controller.cancelTask: runtime rejected cancellation (${result.error?.code ?? "unknown"})`)
			}
		} finally {
			this.cancelInProgress = false
		}
	}

	updateBackgroundCommandState(running: boolean, taskId?: string) {
		const nextTaskId = running ? taskId : undefined
		if (this.backgroundCommandRunning === running && this.backgroundCommandTaskId === nextTaskId) {
			return
		}
		this.backgroundCommandRunning = running
		this.backgroundCommandTaskId = nextTaskId
		void this.postStateToWebview()
	}

	/**
	 * Persists the panel state to the webview so VSCode can restore it on next window reload.
	 * State is saved via acquireVsCodeApi().setState() inside the webview.
	 *
	 * @param taskId - The task ID to persist
	 */
	private async persistPanelStateIfNeeded(taskId: string): Promise<void> {
		try {
			const { WebviewProviderRegistry } = await import("@/core/webview/WebviewProviderRegistry")
			const { VscodeWebviewPanelProvider } = await import("@/hosts/vscode/VscodeWebviewPanelProvider")
			const panels = WebviewProviderRegistry.getPanels()
			for (const provider of panels) {
				if (provider instanceof VscodeWebviewPanelProvider && provider.hasController() && provider.controller === this) {
					provider.setPendingTaskId(taskId)
					break
				}
			}
		} catch {
			// Non-critical; panel may not be available (e.g. sidebar controller)
		}
	}

	private async clearPanelStateIfNeeded(): Promise<void> {
		try {
			const { WebviewProviderRegistry } = await import("@/core/webview/WebviewProviderRegistry")
			const { VscodeWebviewPanelProvider } = await import("@/hosts/vscode/VscodeWebviewPanelProvider")
			const panels = WebviewProviderRegistry.getPanels()
			for (const provider of panels) {
				if (provider instanceof VscodeWebviewPanelProvider && provider.hasController() && provider.controller === this) {
					await provider.clearPanelState()
					break
				}
			}
		} catch {
			// Non-critical
		}
	}

	/**
	 * Syncs the editor tab title for the panel hosting this controller's task.
	 * Called when task description or focus chain progress changes.
	 *
	 * The title is always derived from {@link Task.getPanelTitle} so the focus
	 * chain progress suffix can never be dropped by a caller passing raw text.
	 */
	async syncPanelTitle(): Promise<void> {
		if (this.uiDetached || this.disposed || !this.task) {
			return
		}
		const resolvedTitle = this.task.getPanelTitle()
		try {
			const { WebviewProviderRegistry } = await import("@/core/webview/WebviewProviderRegistry")
			const { VscodeWebviewPanelProvider } = await import("@/hosts/vscode/VscodeWebviewPanelProvider")
			const panels = WebviewProviderRegistry.getPanels()
			for (const provider of panels) {
				if (provider instanceof VscodeWebviewPanelProvider && provider.hasController() && provider.controller === this) {
					provider.updateTitle(resolvedTitle)
					// The title is derived from the user's task text, so only its size is logged.
					Logger.debug(`[Controller] Panel title synced: chars=${resolvedTitle.length}`)
					break
				}
			}
		} catch (error) {
			Logger.warn(`[Controller] Failed to sync panel title:`, error)
		}
	}

	async cancelBackgroundCommand(): Promise<void> {
		const didCancel = await this.task?.cancelBackgroundCommand()
		if (!didCancel) {
			this.updateBackgroundCommandState(false)
		}
	}

	async handleAuthCallback(customToken: string, provider: string | null = null) {
		try {
			await this.authService.handleAuthCallback(customToken, provider ? provider : "google")

			const currentMode = this.stateManager.getGlobalSettingsKey("mode")
			const currentApiConfiguration = this.stateManager.getApiConfiguration()

			// Mark welcome view as completed since user has successfully logged in
			this.stateManager.setGlobalState("welcomeViewCompleted", true)

			await fetchRemoteConfig(this)

			if (this.task) {
				const activeProfile =
					currentMode === "plan" ? currentApiConfiguration.planModeProfile : currentApiConfiguration.actModeProfile
				if (activeProfile) {
					this.task.api = buildApiHandler({ ...currentApiConfiguration, ulid: this.task.ulid }, currentMode)
				}
			}

			await this.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to Cline",
			})
			// Even on login failure, we preserve any existing tokens
			// Only clear tokens on explicit logout
		}
	}

	async handleOcaAuthCallback(code: string, state: string) {
		try {
			await this.ocaAuthService.handleAuthCallback(code, state)

			const currentMode = this.stateManager.getGlobalSettingsKey("mode")
			const currentApiConfiguration = this.stateManager.getApiConfiguration()

			// Mark welcome view as completed since user has successfully logged in
			this.stateManager.setGlobalState("welcomeViewCompleted", true)

			if (this.task) {
				const activeProfile =
					currentMode === "plan" ? currentApiConfiguration.planModeProfile : currentApiConfiguration.actModeProfile
				if (activeProfile) {
					this.task.api = buildApiHandler({ ...currentApiConfiguration, ulid: this.task.ulid }, currentMode)
				}
			}

			await this.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to OCA",
			})
			// Even on login failure, we preserve any existing tokens
			// Only clear tokens on explicit logout
		}
	}

	async handleMcpOAuthCallback(serverHash: string, code: string, state: string | null) {
		try {
			await this.mcpHub.completeOAuth(serverHash, code, state)
			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Successfully authenticated MCP server`,
			})
		} catch (error) {
			Logger.error("Failed to complete MCP OAuth:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to authenticate MCP server`,
			})
		}
	}

	async handleTaskCreation(prompt: string) {
		await sendChatButtonClickedEvent(this)
		await this.initTask(prompt)
	}

	// MCP Marketplace
	private async fetchMcpMarketplaceFromApi(): Promise<McpMarketplaceCatalog> {
		const response = await axios.get(`${ClineEnv.config()?.mcpBaseUrl ?? ""}/marketplace`, {
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "dline-vscode-extension",
			},
			...getAxiosSettings(),
		})

		if (!response.data) {
			throw new Error("Invalid response from MCP marketplace API")
		}

		// Get allowlist from remote config
		const allowedMCPServers = this.stateManager.getRemoteConfigSettings().allowedMCPServers

		let items: McpMarketplaceItem[] = (response.data || []).map((item: McpMarketplaceItem) => ({
			...item,
			githubStars: item.githubStars ?? 0,
			downloadCount: item.downloadCount ?? 0,
			tags: item.tags ?? [],
		}))

		// Filter by allowlist if configured
		if (allowedMCPServers) {
			const allowedIds = new Set(allowedMCPServers.map((server) => server.id))
			items = items.filter((item: McpMarketplaceItem) => allowedIds.has(item.mcpId))
		}

		const catalog: McpMarketplaceCatalog = { items }

		// Store in cache file
		await writeMcpMarketplaceCatalogToCache(catalog)
		return catalog
	}

	async refreshMcpMarketplace(sendCatalogEvent: boolean): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const catalog = await this.fetchMcpMarketplaceFromApi()
			if (catalog && sendCatalogEvent) {
				await sendMcpMarketplaceCatalogEvent(this, catalog)
			}
			return catalog
		} catch (error) {
			Logger.error("Failed to refresh MCP marketplace:", error)
			return undefined
		}
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		let apiKey: string
		try {
			const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code }, getAxiosSettings())
			if (response.data?.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			Logger.error("Error exchanging code for API key:", error)
			throw error
		}

		const currentMode = this.stateManager.getGlobalSettingsKey("mode")
		const currentApiConfiguration = this.stateManager.getApiConfiguration()

		const orProfiles = findEnabledProfiles("openrouter")
		if (orProfiles.length > 0) {
			for (const p of orProfiles) {
				SecretsManager.setApiKey(p.id, apiKey, p.name)
			}
		}

		await this.postStateToWebview()
		if (this.task) {
			const activeProfile =
				currentMode === "plan" ? currentApiConfiguration.planModeProfile : currentApiConfiguration.actModeProfile
			if (activeProfile) {
				this.task.api = buildApiHandler({ ...currentApiConfiguration, ulid: this.task.ulid }, currentMode)
			}
		}
		// Dont send settingsButtonClicked because its bad ux if user is on welcome
	}

	// Requesty

	async handleRequestyCallback(code: string) {
		const currentMode = this.stateManager.getGlobalSettingsKey("mode")
		const currentApiConfiguration = this.stateManager.getApiConfiguration()

		const requestyProfiles = findEnabledProfiles("requesty")
		for (const p of requestyProfiles) {
			SecretsManager.setApiKey(p.id, code, p.name)
		}

		await this.postStateToWebview()
		if (this.task) {
			const activeProfile =
				currentMode === "plan" ? currentApiConfiguration.planModeProfile : currentApiConfiguration.actModeProfile
			if (activeProfile) {
				this.task.api = buildApiHandler({ ...currentApiConfiguration, ulid: this.task.ulid }, currentMode)
			}
		}
	}

	// Read OpenRouter models from the asynchronously loaded provider catalog.
	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		try {
			const registry = ModelRegistry.getInstance()
			await registry.waitForDeferredProviders()
			const models = registry.getProviderModels("openrouter")?.models
			return models && Object.keys(models).length > 0 ? appendClineStealthModels(models) : undefined
		} catch (error) {
			Logger.error("Error reading cached OpenRouter models:", error)
			return undefined
		}
	}

	// Hicap
	async handleHicapCallback(code: string) {
		const apiKey: string = code

		const currentMode = this.stateManager.getGlobalSettingsKey("mode")
		const currentApiConfiguration = this.stateManager.getApiConfiguration()

		const hcProfiles = findEnabledProfiles("hicap")
		if (hcProfiles.length > 0) {
			for (const p of hcProfiles) {
				SecretsManager.setApiKey(p.id, apiKey, p.name)
			}
		}

		await this.postStateToWebview()
		this.accountService
		if (this.task) {
			const activeProfile =
				currentMode === "plan" ? currentApiConfiguration.planModeProfile : currentApiConfiguration.actModeProfile
			if (activeProfile) {
				this.task.api = buildApiHandler({ ...currentApiConfiguration, ulid: this.task.ulid }, currentMode)
			}
		}
	}

	// Task history

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const history = this.stateManager.getGlobalStateKey("taskHistory")
		const historyItem = history.find((item) => item.id === id)
		if (historyItem) {
			const taskDirPath = path.join(await getDlineDocumentsPath(), "tasks", id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
			const contextHistoryFilePath = path.join(taskDirPath, GlobalFileNames.contextHistory)
			const taskMetadataFilePath = path.join(taskDirPath, GlobalFileNames.taskMetadata)
			const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (fileExists) {
				const apiConversationHistory = await readJsonl<Anthropic.MessageParam>(apiConversationHistoryFilePath)
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					contextHistoryFilePath,
					taskMetadataFilePath,
					apiConversationHistory,
				}
			}
		}
		// if we tried to get a task that doesn't exist, remove it from state
		// FIXME: this seems to happen sometimes when the json file doesn't save to disk for some reason
		await this.deleteTaskFromState(id)
		throw new Error("Task not found")
	}

	async exportTaskWithId(id: string) {
		const { taskDirPath } = await this.getTaskWithId(id)
		Logger.log(`[EXPORT] Opening task directory: ${taskDirPath}`)
		await open(taskDirPath)
	}

	async deleteTaskFromState(id: string) {
		// Persist deletion via TaskHistory instance (cross-process safe via transact + FileLock)
		await this.stateManager.taskHistory.softDelete(id)

		// Remove from in-memory cache
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		this.stateManager.setGlobalState("taskHistory", updatedTaskHistory)

		// Release file ownership in the global checkpoint registry
		const { WorkspaceFileRegistry } = await import("@integrations/checkpoints/WorkspaceFileRegistry")
		WorkspaceFileRegistry.getInstance().releaseTask(id)

		// Notify the webview that the task has been deleted
		await this.postStateToWebview()

		return updatedTaskHistory
	}

	/** Build and publish the latest non-stale extension state. */
	async postStateToWebview(options?: PostStateOptions): Promise<void> {
		if (this.uiDetached || this.disposed) {
			this.suppressedStatePostsAfterDetach++
			return
		}
		// Coalescing downstream of the build only saved delivery: every caller in
		// a burst still paid for a full state build whose result was then
		// discarded. Merging first makes the build itself happen once per window.
		if (!options?.immediate) {
			// buildState() is the only writer of the active task id, so deferring
			// it would leave task-scoped setting reads pointing at the previous
			// task for the whole window. An immediate publication builds right
			// away and needs no such compensation.
			this.stateManager.setActiveTaskId(this.task?.taskId)
			this.scheduleCoalescedStatePost()
			return
		}
		this.clearPendingStatePost()
		await this.publishState(options)
	}

	/** Build the current state once and hand it to delivery when still current. */
	private async publishState(options?: PostStateOptions): Promise<void> {
		const state = await this.getStateToPostToWebview()
		if (!this.isStateCurrent(state.stateRevision)) return
		await sendStateUpdate(this, state, this._accountUsage, options)
	}

	/** Open a merge window so a burst of ordinary updates builds state once. */
	private scheduleCoalescedStatePost(): void {
		if (this.pendingStatePostTimer) return
		this.pendingStatePostTimer = setTimeout(() => {
			this.pendingStatePostTimer = undefined
			if (!this.isUiAttached()) return
			// The window already absorbed the delay, so delivery must not queue
			// this behind a second debounce of the same length.
			void this.publishState({ immediate: true })
		}, STATE_POST_COALESCE_MS)
	}

	/**
	 * Project the task history for a state publication, reusing the last result.
	 *
	 * The entry cap bounds how many tasks are sent but not how many bytes:
	 * `HistoryItem.task` holds the verbatim task text, so the projection
	 * shortens it to an identifying prefix while the full text stays on disk.
	 * Sorting and projecting the whole list on every publication was pure
	 * repetition whenever the history itself had not changed.
	 */
	private projectTaskHistoryCached(
		taskHistory: readonly HistoryItem[] | undefined,
	): ReturnType<typeof projectTaskHistory>["items"] {
		const source = taskHistory ?? []
		const cached = this.taskHistoryProjectionCache
		if (cached && cached.source === source) return cached.items
		const items = projectTaskHistory(
			source
				.filter((item) => item.ts && item.task)
				.sort((a, b) => b.ts - a.ts)
				.slice(0, 100), // for now we're only getting the latest 100 tasks, but a better solution here is to only pass in 3 for recent task history, and then get the full task history on demand when going to the task history view (maybe with pagination?)
		).items
		this.taskHistoryProjectionCache = { source, items }
		return items
	}

	/** Drop a merge window that a newer immediate publication or detach replaces. */
	private clearPendingStatePost(): void {
		if (!this.pendingStatePostTimer) return
		clearTimeout(this.pendingStatePostTimer)
		this.pendingStatePostTimer = undefined
	}

	/** Build a monotonic extension state while preserving the public non-optional contract. */
	async getStateToPostToWebview(): Promise<ExtensionState> {
		if (this.uiDetached || this.disposed) this.stateBuildsAfterDetach++
		const revision = ++this.nextStateRevision
		const state = await this.buildState(revision)
		if (revision > this.latestStateRevision) {
			this.latestStateRevision = revision
		}
		return state
	}

	/** Report whether a completed asynchronous state build is still current. */
	isStateCurrent(revision: number): boolean {
		return revision >= this.latestStateRevision
	}

	/** Build one extension-state snapshot for a preallocated revision. */
	protected async buildState(revision: number): Promise<ExtensionState> {
		const startTime = performance.now()
		// Ensure per-task settings isolation: set active task before reading
		// any settings that depend on task-level overrides (apiConfiguration, mode, etc.).
		if (this.task?.taskId) {
			this.stateManager.setActiveTaskId(this.task.taskId)
		} else {
			this.stateManager.setActiveTaskId(undefined)
		}
		// Get API configuration from cache — must be AFTER setActiveTaskId
		// so that getSettingWithOverride() can read task-level profile overrides.
		const onboardingModels = getClineOnboardingModels()
		let apiConfiguration = this.stateManager.getApiConfiguration()

		// Override with task-level profile settings if available (multi-window isolation fix)
		if (this.task?.taskSm) {
			const taskPlanProfileId = this.task.taskSm.planModeProfileId
			const taskPlanProfile = this.task.taskSm.planModeProfile
			const taskActProfileId = this.task.taskSm.actModeProfileId
			const taskActProfile = this.task.taskSm.actModeProfile
			if (
				taskPlanProfileId !== undefined ||
				taskPlanProfile !== undefined ||
				taskActProfileId !== undefined ||
				taskActProfile !== undefined
			) {
				apiConfiguration = {
					...apiConfiguration,
					...(taskPlanProfileId !== undefined && { planModeProfileId: taskPlanProfileId }),
					...(taskPlanProfile !== undefined && { planModeProfile: taskPlanProfile }),
					...(taskActProfileId !== undefined && { actModeProfileId: taskActProfileId }),
					...(taskActProfile !== undefined && { actModeProfile: taskActProfile }),
				}
			}
		}
		const lastShownAnnouncementId = this.stateManager.getGlobalStateKey("lastShownAnnouncementId")
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")
		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		const preferredLanguage = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const chatInputSendShortcut = this.stateManager.getGlobalSettingsKey("chatInputSendShortcut")
		const mode = this.task?.taskSm?.mode ?? this.stateManager.getGlobalSettingsKey("mode")
		const strictPlanModeEnabled = this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled")
		const yoloModeToggled = this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")
		const autoCondenseTriggerPercent = this.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent")
		const autoCondenseMinReserveTokens = this.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens")
		const autoCondenseMaxReserveTokens = this.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens")
		const autoCondenseMaxContextTokens = this.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens")
		const subagentsEnabled = this.stateManager.getGlobalSettingsKey("subagentsEnabled")
		const userInfo = this.stateManager.getGlobalStateKey("userInfo")
		const mcpMarketplaceEnabled = this.stateManager.getGlobalStateKey("mcpMarketplaceEnabled")
		const mcpDisplayMode = this.stateManager.getGlobalStateKey("mcpDisplayMode")
		const usageReportingSetting = this.stateManager.getGlobalSettingsKey("usageReportingSetting")
		const errorReportingSetting = this.stateManager.getGlobalSettingsKey("errorReportingSetting")
		const planActSeparateModelsSetting = this.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
		const enableCheckpointsSetting = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
		const globalClineRulesToggles = this.stateManager.getGlobalSettingsKey("globalClineRulesToggles")
		const globalWorkflowToggles = this.stateManager.getGlobalSettingsKey("globalWorkflowToggles")
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles")
		const taskCapabilityToggles = parseTaskCapabilityToggles(this.task?.taskSm.taskCapabilityToggles)
		const localSkillsToggles = this.readLocalCapabilityToggles("skills")
		const remoteSkillsToggles = this.stateManager.getGlobalStateKey("remoteSkillsToggles")
		const remoteRulesToggles = this.stateManager.getGlobalStateKey("remoteRulesToggles")
		const remoteWorkflowToggles = this.stateManager.getGlobalStateKey("remoteWorkflowToggles")
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		const vscodeTerminalExecutionMode = this.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		const isNewUser = this.stateManager.getGlobalStateKey("isNewUser")
		// Can be undefined but is set to either true or false by the migration that runs on extension launch in extension.ts
		const welcomeViewCompleted = !!this.stateManager.getGlobalStateKey("welcomeViewCompleted")

		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		const mcpResponsesCollapsed = this.stateManager.getGlobalStateKey("mcpResponsesCollapsed")
		const terminalOutputLineLimit = this.stateManager.getGlobalSettingsKey("terminalOutputLineLimit")
		const terminalCommandTimeoutSeconds = this.stateManager.getGlobalSettingsKey("terminalCommandTimeoutSeconds")
		const terminalCommandHandoffSeconds = this.stateManager.getGlobalSettingsKey("terminalCommandHandoffSeconds")
		const maxConsecutiveMistakes = this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")
		const favoritedModelIds = this.stateManager.getGlobalStateKey("favoritedModelIds")
		const doubleCheckCompletionEnabled = this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled")
		const lazyTeammateModeEnabled = this.stateManager.getGlobalSettingsKey("lazyTeammateModeEnabled")
		const mcpEnabled = this.stateManager.getGlobalSettingsKey("mcpEnabled")
		const imageGenerationEnabled = this.stateManager.getCanonicalSettingsKey("imageGenerationEnabled")
		const showFeatureTips = this.stateManager.getGlobalSettingsKey("showFeatureTips")
		const showActiveTasksInEnvDetails = this.stateManager.getGlobalSettingsKey("showActiveTasksInEnvDetails")

		const localClineRulesToggles = this.readLocalCapabilityToggles("rules")
		const localWindsurfRulesToggles = this.readLocalCapabilityToggles("windsurfRules")
		const localCursorRulesToggles = this.readLocalCapabilityToggles("cursorRules")
		const localAgentsRulesToggles = this.readLocalCapabilityToggles("agentsRules")
		const workflowToggles = this.readLocalCapabilityToggles("workflows")

		const currentTaskItem = this.task?.taskId ? (taskHistory || []).find((item) => item.id === this.task?.taskId) : undefined
		// Read the message list once. The getter merges and sorts transient
		// entries on every access, so a second read costs another full pass over
		// a conversation that can hold tens of thousands of messages.
		const rawMessages = this.task?.messageStateHandler.clineMessages ?? []
		// Build a synthetic taskTitleMessage for backward compatibility with frontend
		const taskTitleMessage = rawMessages.find((m) => m.say === "task") ?? rawMessages.at(0)
		// Separate task header message from body messages. Read the header from the
		// in-memory message list instead of re-reading ui_messages.jsonl on every
		// state push: getTaskHeaderText() bypasses the jsonl cache and performs a
		// full fs.readFile + per-line JSON.parse, which dominated buildState() time
		// in long conversations (900-2500ms per push in field logs).
		const _taskHeaderText = taskTitleMessage?.text ?? ""
		// totalMessageCount now includes the task message (matching fetchMessage behavior)
		// so the frontend can detect when scrolled to the absolute top (index 0)
		const totalMessageCount = rawMessages.length
		// firstItemIndex is managed by fetchMessage; default to latest window on init
		const firstItemIndex = Math.max(0, totalMessageCount - 100)
		const checkpointManagerErrorMessage = this.task?.taskState.checkpointManagerErrorMessage
		// The entry cap below bounds how many tasks are sent but not how many
		// bytes: HistoryItem.task holds the verbatim task text, so a workspace
		// with long tasks rebroadcasts megabytes on every push. Project the text
		// down to an identifying prefix; the full text stays on disk.
		const processedTaskHistory = this.projectTaskHistoryCached(taskHistory)

		const latestAnnouncementId = getLatestAnnouncementId()
		const shouldShowAnnouncement = lastShownAnnouncementId !== latestAnnouncementId
		const platform = process.platform as Platform
		const distinctId = getDistinctId()
		const version = ExtensionRegistryInfo.version
		const clineConfig = ClineEnv.config()
		const environment = clineConfig?.environment
		// Deprecated compatibility field. Profile-targeted OAuth status is queried on demand by the Codex settings UI.
		const openAiCodexIsAuthenticated = false

		// Compute apiMetrics from all messages (not window slice).
		// These are passed through subscribeToState so the frontend
		// renders task header stats without depending on clineMessages.
		//
		// The aggregation is memoized against the message mutation revision by
		// its owner. Recomputing it here per publication re-serialized every
		// paired API request, whose text carries the whole request body, and
		// that dominated this build in long conversations.
		let aggregatedMetrics: ApiMetrics | undefined
		try {
			aggregatedMetrics = this.task?.messageStateHandler.readStateMetrics()
		} catch (error) {
			Logger.warn("Failed to aggregate api metrics:", error)
		}
		const { getApiMetrics, getLastTaskProgressText } = await import("@shared/getApiMetrics")
		const apiMetrics = {
			// Combining parses each paired request as a whole, so a single
			// malformed entry fails the aggregate outright. The per-message pass
			// isolates its parsing per entry, so falling back to it keeps the
			// remaining usage visible: reporting zero tokens for a long
			// conversation is a worse answer than an approximate total.
			...(aggregatedMetrics ?? getApiMetrics(rawMessages)),
			...this.task?.getApiRateSnapshot(),
		}
		const contextWindowIndicator = this.task?.getContextWindowIndicator()
		const lastApiReqTotalTokens = contextWindowIndicator
			? getContextWindowIndicatorTotalTokens(contextWindowIndicator)
			: undefined

		// If currentFocusChainChecklist is null, fall back to searching
		// the full message list (not the window slice) for task_progress.
		const checklistFromTaskState = this.task?.taskState.currentFocusChainChecklist || null
		const checklistForState = checklistFromTaskState || getLastTaskProgressText(rawMessages)

		const result: ExtensionState = {
			stateRevision: revision,
			modeSwitch: this.modeSwitchCoordinator.getSnapshot(),
			profileSwitch: this.profileSwitchCoordinator?.getSnapshot(),
			version,
			apiConfiguration,
			currentTaskItem,
			taskTitleMessage,
			totalMessageCount,
			firstItemIndex,
			apiMetrics,
			contextWindowIndicator,
			lastApiReqTotalTokens,
			promptCacheHealth: this.task?.getPromptCacheHealth(),
			promptFreshness: this.task?.getPromptFreshness(),
			currentFocusChainChecklist: checklistForState,
			// The history file is append-only and used to be projected whole on
			// every push, which is what made a long-running task rebroadcast a
			// multi-megabyte payload several times a second. The full file stays
			// on disk and is still opened directly from the panel.
			focusChainHistory: projectFocusChainHistory(this.task?.taskState.focusChainHistory).text,
			checkpointManagerErrorMessage,
			autoApprovalSettings,
			browserSettings,
			focusChainSettings,
			preferredLanguage,
			chatInputSendShortcut,
			mode,
			strictPlanModeEnabled,
			yoloModeToggled,
			useAutoCondense,
			autoCondenseTriggerPercent,
			autoCondenseMinReserveTokens,
			autoCondenseMaxReserveTokens,
			autoCondenseMaxContextTokens,
			subagentsEnabled,
			userInfo,
			mcpMarketplaceEnabled,
			mcpDisplayMode,
			usageReportingSetting,
			errorReportingSetting,
			planActSeparateModelsSetting,
			enableCheckpointsSetting: enableCheckpointsSetting ?? true,
			platform,
			environment,
			distinctId,
			globalClineRulesToggles: globalClineRulesToggles || {},
			localClineRulesToggles: localClineRulesToggles || {},
			localWindsurfRulesToggles: localWindsurfRulesToggles || {},
			localCursorRulesToggles: localCursorRulesToggles || {},
			localAgentsRulesToggles: localAgentsRulesToggles || {},
			localWorkflowToggles: workflowToggles || {},
			globalWorkflowToggles: globalWorkflowToggles || {},
			globalSkillsToggles: globalSkillsToggles || {},
			taskCapabilityToggles,
			localSkillsToggles: localSkillsToggles || {},
			remoteSkillsToggles: remoteSkillsToggles || {},
			remoteRulesToggles: remoteRulesToggles,
			remoteWorkflowToggles: remoteWorkflowToggles,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			vscodeTerminalExecutionMode: vscodeTerminalExecutionMode,
			defaultTerminalProfile,
			isNewUser,
			welcomeViewCompleted,
			onboardingModels,
			mcpResponsesCollapsed,
			terminalOutputLineLimit,
			terminalCommandTimeoutSeconds,
			terminalCommandHandoffSeconds,
			maxConsecutiveMistakes,
			customPrompt,
			taskHistory: processedTaskHistory,
			shouldShowAnnouncement,
			favoritedModelIds,
			providersVersion: ModelRegistry.getInstance().version,
			profileCatalogRevision: getProfileCatalogRevision(),
			backgroundCommandRunning: this.backgroundCommandRunning,
			backgroundCommandTaskId: this.backgroundCommandTaskId,
			// NEW: Add workspace information
			workspaceRoots: this.workspaceManager?.getRoots() ?? [],
			primaryRootIndex: this.workspaceManager?.getPrimaryIndex() ?? 0,
			isMultiRootWorkspace: (this.workspaceManager?.getRoots().length ?? 0) > 1,
			multiRootSetting: {
				user: this.stateManager.getGlobalStateKey("multiRootEnabled"),
				featureFlag: true, // Multi-root workspace is now always enabled
			},
			clineWebToolsEnabled: {
				user: this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled"),
				featureFlag: featureFlagsService.getWebtoolsEnabled(),
			},
			localWebSearchEngine: this.stateManager.getGlobalSettingsKey("localWebSearchEngine"),
			searxngSearchUrl: this.stateManager.getGlobalSettingsKey("searxngSearchUrl"),
			worktreesEnabled: {
				user: this.stateManager.getGlobalSettingsKey("worktreesEnabled"),
				featureFlag: featureFlagsService.getWorktreesEnabled(),
			},
			hooksEnabled: getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled")),
			remoteConfigSettings: this.stateManager.getRemoteConfigSettings(),
			nativeToolCallSetting: this.stateManager.getGlobalStateKey("nativeToolCallEnabled"),
			enableParallelToolCalling: this.stateManager.getGlobalSettingsKey("enableParallelToolCalling"),
			backgroundEditEnabled: this.stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
			optOutOfRemoteConfig: this.stateManager.getGlobalSettingsKey("optOutOfRemoteConfig"),
			doubleCheckCompletionEnabled,
			lazyTeammateModeEnabled,
			mcpEnabled,
			imageGenerationEnabled,
			showFeatureTips,
			showActiveTasksInEnvDetails,
			openAiCodexIsAuthenticated,
			/** Task lock status — computed on each state push so the frontend
			 *  can show a lock banner when the task is in read-only mode. */
			taskLockStatus: this.getTaskLockStatus(),
			/**
			 * Input the user queued while the task was busy; the task owns it.
			 * The projection is optional so a task stub without a queue still
			 * builds state instead of throwing.
			 */
			inputQueue: this.task?.getInputQueueSnapshot?.() ?? [],
			/** Complete interaction view projected only from canonical runtime state. */
			taskViewState: this.task
				? (() => {
						const runtimeState = this.task.getRuntimeState()
						if (this.task.isHistoryPreparationPending?.()) {
							return projectHistoryPreparingView(runtimeState)
						}
						const commandHandoffActivityId = this.task.getReadyBackgroundHandoffActivityId()
						return projectTaskView(runtimeState, {
							autoRetryActive: this.task.hasAutoRetrySequence(),
							autoRetryPending: this.task.hasPendingAutoRetry(),
							contextCompactionOperationId: this.task.getContextCompactionOperationId(),
							forceTruncateAvailable: this.task.isForceTruncateAvailable(),
							commandHandoffActivityId,
							commandHandoffRequested: commandHandoffActivityId
								? this.task.isBackgroundHandoffRequested(commandHandoffActivityId)
								: false,
						})
					})()
				: undefined,
		}

		const durationMs = Math.round(performance.now() - startTime)
		const logEveryStateBuild = process.env.E2E_TEST === "true" && process.env.DLINE_E2E_STATE_BUILD_TIMING === "true"
		if (durationMs >= 100 || logEveryStateBuild) {
			let activeTasks = 1
			try {
				const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
				activeTasks = OrchestratorController.getInstance().getControllerCount()
			} catch {
				// Unit and CLI contexts may not initialize the VS Code orchestrator.
			}
			Logger.debug(
				`[StateUpdate] build timing: taskId=${this.task?.taskId ?? "none"}, buildMs=${durationMs}, activeTasks=${activeTasks}`,
			)
		}
		return result
	}

	private async handleOpenAiCodexRuntimeMutation(event: OpenAiCodexRuntimeMutationEvent): Promise<void> {
		if (this.disposed) return
		const taskId = this.task?.taskId
		const apiConfig = this.stateManager.getApiConfigurationForTask(taskId)
		const mode = this.stateManager.getSettingsKeyForTask("mode", taskId) || "act"
		const selectedProfileReference =
			(mode === "plan" ? apiConfig.planModeProfileId : apiConfig.actModeProfileId) ??
			(mode === "plan" ? apiConfig.planModeProfile : apiConfig.actModeProfile)
		const selectedProfile = resolveProfileReference(readApiProfiles(), selectedProfileReference)
		if (selectedProfile.status === "invalid" || selectedProfile.profile.id !== event.profileId) return
		accountUsageCoordinator.deleteByPrefix(`${event.profileId}:`)
		this.restartAccountUsagePolling()
		await this.task?.rebuildApiHandler({ abortPrevious: true })
	}

	/** Poll account usage every 60 seconds and push to webview */
	private startAccountUsagePolling() {
		if (this.disposed || !this.accountUsagePollingEnabled || this.accountUsagePolling) {
			return
		}
		this.accountUsagePolling = true
		const generation = ++this.accountUsagePollGeneration
		this.scheduleAccountUsagePoll(generation, 0)
	}

	private scheduleAccountUsagePoll(generation: number, delayMs: number): void {
		if (!this.accountUsagePolling || generation !== this.accountUsagePollGeneration) {
			return
		}
		this.accountUsageTimer = setTimeout(() => {
			this.accountUsageTimer = undefined
			void this.pollAccountUsage(generation).finally(() => {
				this.scheduleAccountUsagePoll(generation, 60_000)
			})
		}, delayMs)
	}

	private async pollAccountUsage(generation: number): Promise<void> {
		const clearStaleUsage = async () => {
			if (generation !== this.accountUsagePollGeneration || !this._accountUsage) {
				return
			}
			this._accountUsage = undefined
			await sendAccountUsageUpdate(this, undefined)
		}
		try {
			const taskId = this.task?.taskId
			const apiConfig = this.stateManager.getApiConfigurationForTask(taskId)
			const mode = this.stateManager.getSettingsKeyForTask("mode", taskId) || "act"
			const profileName = mode === "plan" ? apiConfig.planModeProfile : apiConfig.actModeProfile
			const profileId = mode === "plan" ? apiConfig.planModeProfileId : apiConfig.actModeProfileId
			const profileReference = profileId ?? profileName
			const profileResolution = resolveProfileReference(readApiProfiles(), profileReference)
			if (profileResolution.status === "invalid") {
				throw new Error("Selected Profile is unavailable")
			}
			const profile = profileResolution.profile
			const profileSignature = createHash("sha256").update(JSON.stringify(profile)).digest("hex")
			const credentialRevision =
				profile.provider === "openai-codex" ? openAiCodexOAuthManager.getRuntimeRevision(profile.id) : 0
			const profileKey = `${profile.id}:${profileSignature}:${credentialRevision}`
			if (this.accountUsageProfileKey !== profileKey) {
				this._accountUsage = undefined
				this.accountUsageProfileKey = profileKey
				await sendAccountUsageUpdate(this, undefined)
			}
			const handler = buildApiHandler(apiConfig, mode)
			if (!handler.getAccountUsage) {
				await clearStaleUsage()
				return
			}
			const loadAccountUsage = handler.getAccountUsage.bind(handler)
			const getAccountUsage = async () => decorateProviderAccountUsage(profile, await loadAccountUsage())
			this.accountUsageHandler = handler
			let usage: AccountUsage | undefined
			try {
				usage = await accountUsageCoordinator.get(profileKey, getAccountUsage)
			} finally {
				if (this.accountUsageHandler === handler) {
					handler.abort?.()
					this.accountUsageHandler = undefined
				}
			}
			if (generation !== this.accountUsagePollGeneration || this.accountUsageProfileKey !== profileKey) {
				return
			}
			if (!usage) {
				await clearStaleUsage()
				return
			}
			if (JSON.stringify(this._accountUsage) === JSON.stringify(usage)) {
				return
			}
			this._accountUsage = usage
			Logger.debug("[UsagePoll] accountUsage updated")
			await sendAccountUsageUpdate(this, usage)
		} catch (e) {
			await clearStaleUsage()
			Logger.warn(`[UsagePoll] Failed: ${e}`)
		}
	}

	private stopAccountUsagePolling() {
		this.accountUsagePolling = false
		this.accountUsageHandler?.abort?.()
		this.accountUsageHandler = undefined
		this.accountUsagePollGeneration++
		if (this.accountUsageTimer) {
			clearTimeout(this.accountUsageTimer)
			this.accountUsageTimer = undefined
		}
	}

	/** Restart account usage polling with current profile. Called after profile switch. */
	public restartAccountUsagePolling() {
		this.stopAccountUsagePolling()
		const hadUsage = this._accountUsage !== undefined
		this._accountUsage = undefined
		this.accountUsageProfileKey = undefined
		if (hadUsage) {
			void sendAccountUsageUpdate(this, undefined)
		}
		this.startAccountUsagePolling()
	}

	/** Pause background balance requests while this controller's webview is hidden. */
	public setAccountUsagePollingEnabled(enabled: boolean): void {
		this.accountUsagePollingEnabled = enabled
		if (enabled) {
			this.startAccountUsagePolling()
		} else {
			this.stopAccountUsagePolling()
		}
	}

	/**
	 * Starts polling for lock availability when the current task is in
	 * read-only mode (locked by another instance). When the lock becomes
	 * available, automatically acquires it and activates the task.
	 *
	 * @param taskId The task ID to poll for
	 */
	private startLockPoll(taskId: string) {
		this.stopLockPoll()
		const generation = this.lockPollGeneration
		const isCurrentRound = () => generation === this.lockPollGeneration && !this.disposed && !this.taskLockAcquired
		this.lockPollTimer = setInterval(async () => {
			if (!isCurrentRound()) return
			try {
				const status = await this.lockService.checkTaskLock(taskId)
				if (status.isLocked && !status.isStale) return
				// A round that started before an unlock or takeover must not
				// acquire on top of it: clearInterval cannot cancel a callback
				// that is already suspended on an await.
				if (!isCurrentRound()) return

				const acquired = await this.lockService.acquireTaskLock(taskId)
				if (!acquired) return
				if (!isCurrentRound()) {
					// Ownership changed while acquiring, so this round has no
					// claim on the lock it just took.
					await this.lockService.releaseTaskLock(taskId)
					return
				}

				Logger.debug(`[Lock] Auto-acquired lock for task ${taskId} after polling`)
				await this.activateTaskAfterUnlock(taskId)
			} catch (error) {
				Logger.warn(`[Lock] Poll error for task ${taskId}:`, error)
			}
		}, 30000) // Poll every 30 seconds
	}

	/**
	 * Stops the lock polling timer and invalidates any round already running.
	 */
	private stopLockPoll() {
		this.lockPollGeneration++
		if (this.lockPollTimer) {
			clearInterval(this.lockPollTimer)
			this.lockPollTimer = undefined
		}
	}

	/**
	 * Take the task over after the unlock response has been sent.
	 *
	 * Acquiring the lock writes a new lock file, so it must not happen while
	 * the unlock request is still being answered: the caller would then be
	 * blocked by the very lock this instance just created. Scheduling the
	 * takeover keeps releasing and re-acquiring in separate turns.
	 *
	 * @param taskId The task ID that was unlocked
	 */
	scheduleTakeoverAfterUnlock(taskId: string): void {
		setTimeout(() => {
			void this.takeOverTaskAfterUnlock(taskId).catch((error) => {
				Logger.error(`[Lock] Failed to take over task ${taskId} after unlock:`, error)
			})
		}, 0)
	}

	/** Acquire the released lock and activate the task, or resume polling when it was taken. */
	private async takeOverTaskAfterUnlock(taskId: string): Promise<void> {
		if (this.disposed || this.taskLockAcquired) return

		const acquired = await this.lockService.acquireTaskLock(taskId)
		if (!acquired) {
			// Another instance won the released lock. Stay read-only and let the
			// existing poll pick the task up when it becomes available again.
			Logger.warn(`[Lock] Task ${taskId} was re-locked before this instance could take over`)
			await this.postStateToWebview()
			return
		}

		await this.activateTaskAfterUnlock(taskId)
	}

	/**
	 * Activate the task once this instance holds its lock.
	 * Transitions the task from read-only mode to full interactive mode,
	 * starts the lock heartbeat, and pushes updated state to the webview.
	 *
	 * @param taskId The task ID whose lock is now held by this instance
	 */
	async activateTaskAfterUnlock(taskId: string) {
		this.taskLockAcquired = true
		this.stopLockPoll()
		this.startLockHeartbeat(taskId)

		// Publish the stopped interaction state after the task becomes writable.
		if (this.task) {
			try {
				await this.task.prepareFromHistory()
			} catch (error) {
				Logger.error(`[Lock] Failed to prepare task ${taskId} after unlock:`, error)
			}
		}

		// Notify webview so the read-only banner is removed
		await this.postStateToWebview()
		Logger.debug(`[Lock] Task ${taskId} activated after force-unlock`)
	}

	/** Keep a single heartbeat alive for the lock this instance holds. */
	private startLockHeartbeat(taskId: string): void {
		if (this.lockHeartbeatTimer) {
			clearInterval(this.lockHeartbeatTimer)
		}
		this.lockHeartbeatTimer = setInterval(() => {
			this.lockService.touchTaskLock(taskId).catch(() => {})
		}, 60000)
	}

	/**
	 * Computes the current task lock status for the frontend.
	 * Returns undefined when the lock is acquired (normal operation)
	 * or when there is no active task.
	 *
	 * @returns TaskLockStatus if in read-only mode, undefined otherwise
	 */
	private getTaskLockStatus(): TaskLockStatus | undefined {
		if (!this.task?.taskId) {
			return undefined
		}
		// When lock is acquired, no banner needed
		if (this.taskLockAcquired) {
			return undefined
		}
		// Task is in read-only mode — return a placeholder status.
		// The actual lock details are checked asynchronously via the
		// checkTaskLock RPC when the frontend first renders the banner.
		return {
			isLocked: true,
			lockedBy: "",
			lockedAt: 0,
			isStale: false,
		} as TaskLockStatus
	}

	/** Serialize operations that may resume or remove the active Task instance. */
	async runTaskLifecycleOperation<T>(operation: (scope: TaskLifecycleScope) => Promise<T>): Promise<T> {
		return this.taskLifecycleMutex.withLock(async () => {
			// A deferred teardown still owns the previous task's locks, settings and
			// stores. Draining it here keeps every lifecycle operation ordered behind
			// the task it replaces, while the surface itself was already released.
			await this.pendingTaskTeardown
			return operation({
				clearTask: (options) => this.clearTaskWithinLifecycle(options),
			})
		})
	}

	/** Replace one source-owned Task with an independent successor on the same surface. */
	async startSuccessorTask(
		expectedTaskId: string,
		task: string,
		taskSettings: Partial<Settings>,
		initialUserContent: readonly ClineUserContent[],
	): Promise<string | undefined> {
		return this.runTaskLifecycleOperation(async (scope) => {
			if (this.task?.taskId !== expectedTaskId) return undefined
			await scope.clearTask({ suppressPostState: true })
			return this.initTask(task, undefined, undefined, undefined, taskSettings, {
				startInBackground: true,
				initialUserContent: [...initialUserContent],
				skipInitialClear: true,
			})
		})
	}

	async clearTask(options?: { clearPanelState?: boolean; preserveCompletedState?: boolean; deferTeardown?: boolean }) {
		return this.runTaskLifecycleOperation((scope) => scope.clearTask(options))
	}

	private async clearTaskWithinLifecycle(options?: {
		clearPanelState?: boolean
		preserveCompletedState?: boolean
		suppressPostState?: boolean
		deferTeardown?: boolean
	}) {
		const startedAt = performance.now()
		let stageStartedAt = startedAt
		const task = this.task
		const taskId = task?.taskId
		const logCloseStage = (phase: string, details = "") => {
			const now = performance.now()
			recordPerfPhase(
				PerfDomain.ControllerClose,
				"stage",
				now - stageStartedAt,
				{ stage: phase, elapsedMs: Math.round(now - startedAt) },
				{ taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[ControllerClosePerf] phase=${phase} taskId=${taskId ?? "none"} durationMs=${Math.round(now - stageStartedAt)} elapsedMs=${Math.round(now - startedAt)}${details ? ` ${details}` : ""}`,
				)
			}
			stageStartedAt = now
		}
		if (taskId && options?.clearPanelState) {
			await this.clearPanelStateIfNeeded()
			logCloseStage("panel_state_clear")
		}
		await Promise.all([
			this.contextTransitionEngine.reset("Task cleared during context transition."),
			this.profileTransitionEngine.reset("Task cleared during context transition."),
		])
		logCloseStage("context_transition_reset")
		if (task) {
			// Sync task mode to global state so slider works after task closed
			this.stateManager.setGlobalState("mode", task.taskSm.mode)
		}
		// Detach the surface before any durable teardown runs. The Webview decides
		// between the task view and the recent-tasks view purely from `this.task`,
		// so releasing the reference here is what returns the user to Recent; every
		// remaining step is durability work that no longer has a visible effect.
		this.task = undefined
		this.workspaceHistorySession = undefined
		this.restartAccountUsagePolling()
		if (!options?.suppressPostState) {
			await this.postStateToWebview({ immediate: true })
			logCloseStage("detached_state_publish")
		}

		const teardown = this.teardownDetachedTask(task, taskId, options?.preserveCompletedState === true, logCloseStage)
		if (options?.deferTeardown) {
			const pending = teardown.finally(() => {
				if (this.pendingTaskTeardown === pending) {
					this.pendingTaskTeardown = undefined
				}
			})
			this.pendingTaskTeardown = pending
			logCloseStage("teardown_deferred")
			return
		}
		await teardown
		logCloseStage("complete", `suppressPostState=${options?.suppressPostState === true}`)
	}

	/**
	 * Release every durable resource owned by a Task that is already detached.
	 *
	 * Nothing here changes what the user sees, so it may run after the surface has
	 * moved on. Failures are logged rather than rethrown: the caller may have
	 * returned already, and the next lifecycle operation still awaits this promise
	 * before it may create or resume another Task.
	 */
	private async teardownDetachedTask(
		task: Task | undefined,
		taskId: string | undefined,
		preserveCompletedState: boolean,
		logCloseStage: (phase: string, details?: string) => void,
	): Promise<void> {
		try {
			if (task) {
				// Clear task settings cache when task ends
				await this.stateManager.clearTaskSettings(taskId)
				logCloseStage("task_settings_clear")
			}
			await task?.terminate({ preserveCompletedState })
			logCloseStage("task_terminate", `preserveCompleted=${preserveCompletedState}`)
			// Stop lock heartbeat and polling only after terminate() completes, so a
			// task that is still flushing keeps its lock until its stores are closed.
			if (this.lockHeartbeatTimer) {
				clearInterval(this.lockHeartbeatTimer)
				this.lockHeartbeatTimer = undefined
			}
			this.stopLockPoll()
			this.taskLockAcquired = false
			// Release file lock so other instances can open the task
			if (taskId) {
				await this.lockService.releaseTaskLock(taskId).catch((e) => Logger.error("Failed to release lock:", e))
				logCloseStage("lock_release")
				const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
				OrchestratorController.getInstance().unregisterController(taskId)
				// Release file ownership in the global checkpoint registry
				const { WorkspaceFileRegistry } = await import("@integrations/checkpoints/WorkspaceFileRegistry")
				WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			}
		} catch (error) {
			Logger.error(`[Controller] Task teardown failed for ${taskId ?? "none"}:`, error)
		}
	}

	// Caching mechanism to keep track of webview messages + API conversation history per provider instance

	/*
	Now that we use retainContextWhenHidden, we don't have to store a cache of cline messages in the user's state, but we could to reduce memory footprint in long conversations.

	- We have to be careful of what state is shared between ClineProvider instances since there could be multiple instances of the extension running at once. For example when we cached cline messages using the same key, two instances of the extension could end up using the same key and overwriting each other's messages.
	- Some state does need to be shared between the instances, i.e. the API key--however there doesn't seem to be a good way to notify the other instances that the API key has changed.

	We need to use a unique identifier for each ClineProvider instance's message cache since we could be running several instances of the extension outside of just the sidebar i.e. in editor panels.

	// conversation history to send in API requests

	/*
	It seems that some API messages do not comply with vscode state requirements. Either the Anthropic library is manipulating these values somehow in the backend in a way that's creating cyclic references, or the API returns a function or a Symbol as part of the message content.
	VSCode docs about state: "The value must be JSON-stringifyable ... value �?A value. MUST not contain cyclic references."
	For now we'll store the conversation history in memory, and if we need to store in state directly we'd need to do a manual conversion to ensure proper json stringification.
	*/

	private resolveWorkspaceHistoryManager(workspacePath?: string): WorkspaceHistoryManager {
		if (!workspacePath && this.workspaceHistoryManager) return this.workspaceHistoryManager
		const resolvedWorkspacePath = workspacePath ?? this.workspaceManager?.getPrimaryRoot()?.path
		if (!resolvedWorkspacePath) {
			throw new Error("WorkspaceHistoryManager requires an initialized workspace path")
		}
		const manager = getWorkspaceHistoryManager(resolvedWorkspacePath, {
			readCache: () => [...(this.stateManager.getGlobalStateKey("taskHistory") ?? [])],
			writeCache: (history) => this.stateManager.setGlobalState("taskHistory", history),
			writer: this.stateManager.taskHistory,
			onError: (error) => Logger.error("[WorkspaceHistoryManager] Background persistence failed:", error),
		})
		// Cache regardless of how the manager was resolved. The metadata and
		// completion paths call this without an argument, so caching only the
		// explicit-path case left the field null and made the shutdown flush in
		// `clearTask` a silent no-op that dropped queued writes.
		this.workspaceHistoryManager = manager
		return manager
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		const session = this.workspaceHistorySession?.taskId === item.id ? this.workspaceHistorySession : undefined
		return this.resolveWorkspaceHistoryManager().publishMetadata(item, session)
	}

	/** Accept one canonical completion projection; physical History durability is manager-owned. */
	async persistTaskCompletionState(taskId: string, isCompleted: boolean, revision: number): Promise<boolean> {
		const session = this.workspaceHistorySession?.taskId === taskId ? this.workspaceHistorySession : undefined
		return this.resolveWorkspaceHistoryManager().publishCompletion({ taskId, isCompleted, revision }, session)
	}

	/**
	 * Durably persist many completion projections in one batch transaction and
	 * synchronize the controller cache. Used by the one-time backfill so a large
	 * history pays for at most one full-file rewrite instead of one per row.
	 */
	private async persistTaskCompletionStates(
		updates: readonly { taskId: string; isCompleted: boolean; revision: number }[],
	): Promise<number> {
		return await this.taskHistoryProjectionMutex.withLock(async () => {
			const applied = await this.stateManager.taskHistory.setCompletionStates(updates)
			if (applied.length > 0) this.syncTaskHistoryCache(applied)
			return applied.length
		})
	}

	/** Merge freshly persisted history rows into the cached global task history. */
	private syncTaskHistoryCache(rows: readonly HistoryItem[]): void {
		const history = [...(this.stateManager.getGlobalStateKey("taskHistory") ?? [])]
		for (const row of rows) {
			const existingItemIndex = history.findIndex((item) => item.id === row.id)
			if (existingItemIndex >= 0) {
				history[existingItemIndex] = row
			} else {
				history.push(row)
			}
		}
		this.stateManager.setGlobalState("taskHistory", history)
	}
}
