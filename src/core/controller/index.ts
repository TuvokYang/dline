import { createHash, randomUUID } from "node:crypto"
import { accountUsageCoordinator } from "@core/account-usage/AccountUsageCoordinator"
import { addDailyTokens, readDailyTokens, type TokenIncrement } from "@core/account-usage/daily-token-ledger"
import {
    allowsAccountUsagePolling,
    applyLocalDailyTokens,
    decideAccountUsageRead,
    decorateProviderAccountUsage,
    isSubscriptionUsage,
} from "@core/account-usage/provider-usage"
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
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { HookTaskStartContext } from "@core/hooks/TaskStartContextPort"
import { IgnoreController } from "@core/ignore/IgnoreController"
import { bindOpeningDocument, releaseOpeningOnceDurable } from "@core/input-semantics/OpeningDocumentBinding"
import { TaskLockService } from "@core/locks/TaskLockService"
import { resolveProfileReference } from "@core/profiles/profile-binding"
import { getProfileCatalogRevision } from "@core/profiles/profile-catalog-state"
import { settingsAffectPromptFreshness } from "@core/prompts/system-prompt-cache/PromptFreshnessProjection"
import * as SecretsManager from "@core/storage/secrets"
import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { type CapabilityKind, mergeScopedToggles, readScopedToggles } from "@core/storage/settings/capability-toggle-store"
import { detectWorkspaceRoots } from "@core/workspace/detection"
import { setupWorkspaceManager } from "@core/workspace/setup"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import { type OpenAiCodexRuntimeMutationEvent, openAiCodexOAuthManager } from "@integrations/openai-codex/oauth"
import { ClineAccountService } from "@services/account/ClineAccountService"
import { McpHub } from "@services/mcp/McpHub"
import type { ModelInfo } from "@shared/api"
import type { ChatContent } from "@shared/ChatContent"
import { resolveMaxParallelSubagents, resolveMaxParallelToolCalls } from "@shared/concurrency-limits"
import { type ContextWindowIndicatorSnapshot, getContextWindowIndicatorTotalTokens } from "@shared/context-window-indicator"
import type { ExtensionState, Platform, TaskHandoffSource, TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import type { ApiMetrics } from "@shared/getApiMetrics"
import type { HistoryItem } from "@shared/HistoryItem"
import type { McpMarketplaceCatalog, McpMarketplaceItem, McpServer } from "@shared/mcp"
import type { ModeSwitchRequestResult } from "@shared/mode-switch"
import type { ProfileSwitchRequestResult } from "@shared/profile-switch"
import { DispatchInteractionRequest, DispatchInteractionResponse, type TaskLockStatus } from "@shared/proto/dline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
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
import { cleanupStaleTaskTempFiles, getDlineDocumentsPath, getDlineDocumentsPathSync } from "@/core/storage/disk"
import {
    readPersistedTaskCompletion,
    TASK_COMPLETION_BACKFILL_DELAY_MS,
    TASK_COMPLETION_BACKFILL_GENERATION,
    TaskCompletionBackfill,
} from "@/core/storage/TaskCompletionBackfill"
import { resolveTaskApiProfileFresh } from "@/core/task/ApiProfileRecovery"
import { readHistoryContextWindowIndicator } from "@/core/task/HistoryContextWindow"
import { resolveTaskPanelTitle } from "@/core/task/TaskPanelTitle"
import { TaskStateManager } from "@/core/task/TaskStateManager"
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
import { isNativeToolCallingConfig } from "../../utils/model-utils"
import { ModelRegistry } from "../model-registry/ModelRegistry"
import { ApiConversation } from "../storage/ApiConversation"
import {
    ensureMcpServersDirectoryExists,
    ensureSettingsDirectoryExists,
    GlobalFileNames,
    writeMcpMarketplaceCatalogToCache,
} from "../storage/disk"
import { fetchRemoteConfig } from "../storage/remote-config/fetch"
import { clearRemoteConfig } from "../storage/remote-config/utils"
import { type PersistenceErrorEvent, StateManager } from "../storage/StateManager"
import { pruneTaskCommandLogs } from "../storage/task-temp"
import { UIMessage } from "../storage/UIMessage"
import type { ActiveTaskDescriptor } from "../task/active-tasks/ActiveTaskContextProvider"
import type { TaskActivityStore } from "../task/activity/TaskActivityStore"
import { TaskSessionCompositionService } from "../task/composition/TaskSessionCompositionService"
import type { NewTaskHandoff } from "../task/new-task/new-task-handoff"
import type { ActiveTaskSession, CheckpointRestoreFence } from "../task/session/ActiveTaskSession"
import { KernelTaskViewPort } from "../task/view/KernelTaskViewPort"
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
import { planExternalStateChange } from "./state/externalStateChangePlan"
import { projectFocusChainHistory } from "./state/focusChainHistoryProjection"
import { cleanupStateSubscriptions, sendAccountUsageUpdate, sendStatePatch, sendStateUpdate } from "./state/subscribeToState"
import { projectTaskHistory } from "./state/taskHistoryProjection"
import { awaitDispatchableDialog, resolveCompatibleHistoryAction } from "./task/awaitDispatchableDialog"
import { composeBackgroundHandoffAvailability } from "./task/BackgroundHandoffAvailability"
import { describeDialogState, describeDispatch } from "./task/describeInteractionDispatch"
import { dispatchInteraction } from "./task/dispatchInteraction"
import { HistoryDisplaySession } from "./task/HistoryDisplaySession"
import { inspectHistoryTaskLock, projectHistoryTaskLockStatus } from "./task/HistoryTaskLockPreflight"
import { measureHistoryReadinessStage } from "./task/history-readiness-telemetry"
import { prepareHistoryTaskForDisplay } from "./task/history-task-readiness"
import { ControllerTaskSessionHostFactory } from "./task/host/ControllerTaskSessionHostFactory"
import { ControllerTaskSessionPorts } from "./task/host/ControllerTaskSessionPorts"
import { ControllerTransitionCompactionPort } from "./task/host/ControllerTransitionCompactionPort"
import { OpeningHandoff } from "./task/OpeningHandoff"
import { type TaskOpening } from "./task/opened-task"
import { readOnlyTaskView } from "./task/readOnlyTaskView"
import { controllerTransitionDraftCarrier, projectTransitionDraft } from "./task/replyWithTransitionDraft"
import { selectTaskRateMetricsQuery, type TaskRateMetricsQueryFn } from "./task/TaskRateMetricsSource"
import { adaptCanonicalTaskView } from "./task/TaskViewMessageAdapter"
import { startTaskAfterSurface } from "./task/task-start-lifecycle"
import { sendChatButtonClickedEvent } from "./ui/subscribeToChatButtonClicked"
import { sendPartialMessageEvent } from "./ui/subscribeToPartialMessage"

/**
 * Merge window for ordinary state publications.
 *
 * Matches the delivery debounce in subscribeToState so moving coalescing ahead
 * of the build keeps the user-visible latency ceiling unchanged.
 */
const STATE_POST_COALESCE_MS = 50

/** Why a write is refused while another window owns the task this window shows. */
const READ_ONLY_TASK_ERROR = "Task is read-only in this window."

const ACCOUNT_USAGE_BINDING_SETTINGS = new Set([
    "mode",
    "planModeProfileId",
    "planModeProfile",
    "actModeProfileId",
    "actModeProfile",
])

type InitTaskOptions = {
    /** Preallocated identity used by the canonical spawn reservation. */
    taskId?: string
    onHistoryTaskPreparingToDisplay?: () => Promise<void>
    onHistoryTaskReadyToDisplay?: () => Promise<void>
    /** Context fragments for spawned or new tasks. Each entry becomes an independent text block for cache-friendly design. */
    context?: string[]
    /** Return after task-start admission while the agent loop continues in the background. */
    startInBackground?: boolean
    /** Complete identity-dependent setup before the task can issue its first API request. */
    beforeStart?: (taskId: string) => Promise<void> | void
    /** Observe a background task-start failure without rejecting the completed admission. */
    onBackgroundError?: (error: unknown, taskId: string) => Promise<void> | void
    /** Internal lifecycle transaction already removed the previous Task. */
    skipInitialClear?: boolean
    /** The New Task interaction this opening succeeds; projected so the Webview can recognise it. */
    handoffSource?: TaskHandoffSource
    /** Promote a lightweight historical display into the interactive Task runtime. */
    activateHistory?: boolean
    /**
     * Opening identity to adopt instead of a fresh one. A promoted history display
     * passes its own, so the Webview sees the same view continue rather than a new
     * opening that discards the shown messages and the reply being sent.
     */
    taskInstanceId?: string
    /** Why an existing task is opened; defaults to an ordinary resume. */
    openReason?: "resume" | "checkpoint_restore"
    /** Process-local directory classification fixed before the session registers. */
    taskKind?: "main" | "spawned"
    /** Structured meaning of the opening text; when present Core never re-reads `task`. */
    semanticInput?: import("@shared/input-semantics/document").SemanticInputDocument
}

type PostStateOptions = {
    immediate?: boolean
}

export type ControllerCloseReason =
    | "user_clear"
    | "controller_dispose"
    | "task_switch"
    | "checkpoint_restore"
    | "lock_lost"
    | "handoff"
    | "task_delete"
    | "state_reset"
    | "unknown"

type TaskClearWithinLifecycleOptions = {
    clearPanelState?: boolean
    preserveCompletedState?: boolean
    suppressPostState?: boolean
    deferTeardown?: boolean
    checkpointRestoreFence?: CheckpointRestoreFence
    closeReason?: ControllerCloseReason
}

type TaskClearOptions = TaskClearWithinLifecycleOptions & {
    /** Clear only while this opening is still the one shown. */
    expectedOpening?: TaskOpening
}

export type TaskLifecycleScope = {
    /** Clear the active task while already holding the controller lifecycle lock. */
    clearTask(options?: TaskClearWithinLifecycleOptions): Promise<void>
}

type TaskLifecycleOperationOptions = {
    /** False only for a visible close that must detach before older durable cleanup settles. */
    waitForPendingTeardown?: boolean
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

    task?: ActiveTaskSession
    private historyDisplaySession?: HistoryDisplaySession
    /**
     * Advanced when the shown conversation is renumbered under the same
     * opening, so the Webview replaces its window instead of merging pages by
     * positions that now address other rows.
     */
    private messageIndexSpace = 0
    /** The handoff that started one opening; any other opening ignores it. */
    private handoffOpening?: { readonly taskInstanceId: string; readonly source: TaskHandoffSource }
    /** Holds state publications while an opening of the task is replaced by another. */
    private readonly openingHandoff = new OpeningHandoff()
    /**
     * The Profile binding each history display started, settled true once it
     * rewrote the task's settings. The first frame does not wait for it, but a
     * promotion does: the promoted runtime reloads those settings from disk.
     */
    private readonly historyDisplayProfileBindings = new WeakMap<HistoryDisplaySession, Promise<boolean>>()
    /**
     * Task text known when the task was constructed, keyed by task so a stale
     * entry can never title another task. A background start writes the `task`
     * row after the first title sync, so this text titles the tab until then.
     */
    private initialPanelTitle?: { readonly taskId: string; readonly text: string }

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
    private pendingCheckpointRestore:
        | { readonly taskId: string; readonly fence: CheckpointRestoreFence; readonly editedText?: string }
        | undefined
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
    /** Counts publications started, so a dropped build can tell whether a newer one is on its way. */
    private publicationSequence = 0
    /** Pending coalescing window for non-immediate state publications. */
    private pendingStatePostTimer?: ReturnType<typeof setTimeout>
    /** Whether a latest-wins transient Task view patch is already queued. */
    private taskViewPatchScheduled = false
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
            this.task?.owners.prompt.invalidate("mcp_registry")
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
    private readonly lockTakeoverTimers = new Set<NodeJS.Timeout>()
    // Replaced on every heartbeat start, so a tick from an earlier lease cannot act
    private lockHeartbeatLease?: { readonly taskId: string }
    private lockHeartbeatPending?: Promise<void>
    // Whether the current task has an active lock
    private taskLockAcquired = false
    // Account usage data (refreshed every 60s, zero overhead on state push)
    private _accountUsage?: AccountUsage
    private accountUsageProfileKey?: string
    /**
     * Profile key whose usage was already read outside the timer.
     *
     * A provider that refuses polling still has one snapshot worth showing, so
     * the read happens once per Profile instead of on every tick.
     */
    private accountUsageSingleReadKey?: string
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

    /** Today's locally counted tokens for one Profile. */
    private readLocalDailyTokens(profileId: string): TokenIncrement {
        return readDailyTokens(this.stateManager.getGlobalStateKey("profileDailyTokenUsage"), profileId, new Date())
    }

    /**
     * Count one completed request against its Profile's daily totals.
     *
     * Subscription endpoints report percentages only, so this is where today's
     * token counts come from. The published snapshot is refreshed from the
     * ledger without reading the provider again, so the counts stay current
     * while the quota windows keep their last-read values.
     */
    async recordProfileTokenUsage(profileId: string, increment: TokenIncrement): Promise<void> {
        if (!profileId || (increment.inputTokens <= 0 && increment.outputTokens <= 0)) return
        const ledger = this.stateManager.getGlobalStateKey("profileDailyTokenUsage")
        this.stateManager.setGlobalState("profileDailyTokenUsage", addDailyTokens(ledger, profileId, increment, new Date()))
        const published = this._accountUsage
        // Balance providers report their own daily counts; only a subscription
        // snapshot carries counts that came from this ledger.
        if (!published || published.profileId !== profileId || !isSubscriptionUsage(published)) return
        const { dailyInputTokens: _input, dailyOutputTokens: _output, ...withoutLocalCounts } = published
        const refreshed = applyLocalDailyTokens(withoutLocalCounts, this.readLocalDailyTokens(profileId))
        this._accountUsage = refreshed
        await sendAccountUsageUpdate(this, refreshed)
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
                this.readLocalDailyTokens(target.profile.id),
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
                this.readLocalDailyTokens(target.profile.id),
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
                // An idle window sees a steady stream of these events from its own
                // bookkeeping, so what each source actually requires is decided
                // once, in one place, instead of being re-derived inline.
                const plan = planExternalStateChange(event.source, changedKeys)
                if (!plan.reconfigureComponents && !plan.publishState) return
                if (plan.reconfigureComponents) {
                    await this.configureGlobalComponents()
                }
                if (changedKeys.some((key) => ACCOUNT_USAGE_BINDING_SETTINGS.has(key))) {
                    this.restartAccountUsagePolling()
                }
                const configureMs = Math.round(performance.now() - startedAt)
                if (event.source === "settings" && this.task && settingsAffectPromptFreshness(event.commit.changedKeys)) {
                    const freshnessStartedAt = performance.now()
                    await this.task.owners.prompt.flush("settings")
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
            this.task?.owners.prompt.invalidate("mcp_registry")
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
        const result = this.task.owners.commands.configure(snapshot.terminal)
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
    /** Return the task identity owned by either the interactive runtime or lightweight history display. */
    getCurrentTaskId(): string | undefined {
        return this.currentOpening()?.taskId
    }

    /**
     * The opening this Controller currently shows: the interactive session or
     * the lightweight history display. Each opening carries its own instance id,
     * so reopening the same task yields a different opening and every RPC bound
     * to the previous one is recognisably stale.
     */
    currentOpening(): TaskOpening | undefined {
        return this.task ?? this.historyDisplaySession
    }

    /** Return the activity store owned by the exact visible task surface. */
    getCurrentTaskActivityStore(taskId: string): TaskActivityStore | undefined {
        if (this.task?.taskId === taskId) return this.task.owners.activities
        if (this.historyDisplaySession?.taskId === taskId) return this.historyDisplaySession.activityStore
        return undefined
    }

    /**
     * Whether the history display of `taskId` can become that task's runtime.
     *
     * A history surface owns no runtime, so a control that needs one (Retry on a
     * retained subagent) promotes the display first, as replying to it does. A
     * task another window holds stays read-only.
     */
    canPromoteHistoryDisplay(taskId: string): boolean {
        const display = this.historyDisplaySession
        return display?.taskId === taskId && !display.isLocked()
    }

    /**
     * Make `taskId` this Controller's runtime so an activity control can act on
     * it; false when the surface changed or the task belongs to another window.
     */
    async promoteHistoryDisplayForActivityControl(taskId: string): Promise<boolean> {
        if (this.task?.taskId === taskId) return true
        return this.runTaskLifecycleOperation(async () => {
            if (this.task?.taskId === taskId) return true
            const display = this.historyDisplaySession
            if (!display || !this.canPromoteHistoryDisplay(taskId)) return false
            try {
                await this.promoteHistoryDisplay(display)
            } catch (error) {
                Logger.error(`[HistoryDisplay] Failed to promote task ${taskId} for an activity control:`, error)
                return false
            }
            if (this.task?.taskId !== taskId) return false
            // The control acts on the new opening at once; the Webview must re-key
            // its activity stream to it first, not on a later coalesced state post.
            await this.postTaskViewPatchToWebview()
            return true
        })
    }

    /** Return whether this Controller already owns a visible task surface. */
    hasActiveTaskSurface(): boolean {
        return this.getCurrentTaskId() !== undefined
    }

    /** Return the current visible message sequence for state projection. */
    getCurrentTaskMessages(): readonly UiMessage[] {
        return this.task?.owners.messages.clineMessages ?? this.historyDisplaySession?.getMessages() ?? []
    }

    /** Durable message count, which exceeds the loaded window for a history display. */
    getCurrentTaskMessageCount(): number {
        return this.task?.owners.messages.clineMessages.length ?? this.historyDisplaySession?.getMessageCount() ?? 0
    }

    async fetchCurrentTaskMessages(
        referenceIndex: number,
        count: number,
    ): Promise<{ messages: UiMessage[]; totalCount: number; startIndex: number }> {
        const historyDisplay = this.historyDisplaySession
        if (historyDisplay) return await historyDisplay.fetchMessages(referenceIndex, count)

        const messages = [...(this.task?.owners.messages.clineMessages ?? [])]
        const totalCount = messages.length
        const pageSize = Math.max(0, Math.trunc(count))
        const startIndex =
            referenceIndex === -1
                ? Math.max(0, totalCount - pageSize)
                : Math.max(0, Math.min(Math.trunc(referenceIndex), totalCount))
        return { messages: messages.slice(startIndex, Math.min(startIndex + pageSize, totalCount)), totalCount, startIndex }
    }

    /** Return whether the current surface is a lightweight history display. */
    hasHistoryDisplaySession(): boolean {
        return this.historyDisplaySession !== undefined
    }

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

        await this.clearTask({ closeReason: "controller_dispose" })
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
            // Opening a task from History replaces one visible task with another:
            // the empty surface in between must not reach the Webview, or it shows
            // the home view until the history display publishes its first frame.
            await this.clearTask({
                ...(historyItem ? { suppressPostState: true } : {}),
                closeReason: "task_switch",
            })
            logInitStage("initial_clear")
        }

        if (historyItem && !options?.activateHistory) {
            return this.initHistoryDisplaySession(historyItem, options)
        }

        const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
        const vscodeTerminalExecutionMode = this.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
        const isNewUser = this.stateManager.getGlobalStateKey("isNewUser")
        const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")

        const NEW_USER_TASK_COUNT_THRESHOLD = 10

        // Check if the user has completed enough tasks to no longer be considered a "new user"
        if (isNewUser && !historyItem && taskHistory && taskHistory.length >= NEW_USER_TASK_COUNT_THRESHOLD) {
            this.stateManager.setGlobalState("isNewUser", false)
            await this.postStateToWebview()
        }

        // Reading the live Auto-Approve permission is sufficient. Creating a Task
        // must not rewrite the global settings document merely to bump a version;
        // that cross-process transaction can outlive provider admission by seconds.
        void autoApprovalSettings

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

        const taskId = historyItem?.id || options?.taskId || Date.now().toString()
        const workspaceHistoryManager = this.resolveWorkspaceHistoryManager(cwd)
        const workspaceHistorySession = workspaceHistoryManager.beginTask(taskId)
        this.workspaceHistorySession = workspaceHistorySession

        // Until the session takes ownership, close cannot find what this opening
        // holds, so a failure in between is undone here rather than leaving a
        // heartbeating lock that keeps every other window out of the task.
        try {
            // Acquire task lock via lock service
            this.taskLockAcquired = await this.lockService.acquireTaskLock(taskId)
            if (this.taskLockAcquired) {
                Logger.debug(`[Task ${taskId}] Task lock acquired`)
                this.startLockHeartbeat(taskId)
                await this.pruneOwnedCommandLogs(taskId)
                // Holding the lock means no other window writes here, so stale temp files are a crashed writer's.
                void cleanupStaleTaskTempFiles(taskId).catch((error) =>
                    Logger.warn(`[Task ${taskId}] Stale temp file cleanup failed:`, error),
                )
            } else {
                Logger.debug(`[Task ${taskId}] Task locked by another instance - read-only mode`)
                // Start polling for lock release in the background
                this.startLockPoll(taskId)
            }
            logInitStage("task_lock", taskId, `acquired=${this.taskLockAcquired}`)
            // A new task has no history to show read-only, and starting it without the
            // lock would make this window a second writer of a task another one owns.
            if (!this.taskLockAcquired && !historyItem) throw new Error(`Task ${taskId} is open in another window`)

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
            this.bindTaskProfileOnCreate(taskId)

            // If restoring from history and HistoryItem has provider info, inject it
            // as task-specific settings so the task resumes with the same provider.
            // Mode is persisted separately via setTaskSettings in togglePlanActMode
            // and restored by loadTaskSettings above �?do NOT override it from historyItem.
            const uiMessage = await UIMessage.open(taskId)
            // The chat store claims the task's messages.db writer on its first write;
            // it must not outlive an open that never hands it to a session.
            const apiConversation = await ApiConversation.open(taskId).catch(async (error: unknown) => {
                await uiMessage.close().catch(() => undefined)
                throw error
            })
            logInitStage("message_stores_open", taskId)

            const terminalExecutionMode = vscodeTerminalExecutionMode ?? "vscodeTerminal"
            const taskView = new KernelTaskViewPort({
                // CommitPipeline invokes this only after the canonical state is durable.
                publishCommitted: async () => this.postTaskViewPatchToWebview(),
                // Streaming projections are superseded by the newest projection in
                // the same microtask instead of rebuilding the full ExtensionState.
                publishTransient: () => this.scheduleTaskViewPatch(),
            })
            // This opening's identity. The session adopts it as its incarnation, so
            // every row, page and activity the session publishes is attributed to it.
            const opening: TaskOpening = { taskId, taskInstanceId: options?.taskInstanceId ?? randomUUID() }
            this.handoffOpening = options?.handoffSource
                ? { taskInstanceId: opening.taskInstanceId, source: options.handoffSource }
                : undefined
            this.task = await new TaskSessionCompositionService().open({
                taskId,
                taskIncarnationId: opening.taskInstanceId,
                openReason: historyItem ? (options?.openReason ?? "resume") : "new",
                collaboration: {
                    writable: this.taskLockAcquired,
                    summary: historyItem?.task ?? task ?? "",
                    kind: options?.taskKind ?? "main",
                    createdAt: new Date().toISOString(),
                },
                // Another window owns the task: recovered work waits for `task.open()`,
                // which runs only once this window acquires the lock.
                deferRestoredCommands: !this.taskLockAcquired,
                cwd,
                stateManager: this.stateManager,
                taskView,
                messages: {
                    uiMessage,
                    apiConversation,
                    taskIsFavorited: historyItem?.isFavorited,
                    legacyConversationHistoryDeletedRange: historyItem?.conversationHistoryDeletedRange,
                    updateTaskHistory: (item) => workspaceHistoryManager.publishMetadata(item, workspaceHistorySession),
                    publishTaskHistoryClose: () => workspaceHistoryManager.closeTask(workspaceHistorySession),
                    completion: {
                        initial:
                            historyItem?.isCompleted === undefined
                                ? undefined
                                : { isCompleted: historyItem.isCompleted, revision: historyItem.completionStateRevision ?? -1 },
                        persist: (update) => this.persistTaskCompletionState(update.taskId, update.isCompleted, update.revision),
                    },
                },
                prompt: {
                    ports: new ControllerTaskSessionPorts(this, opening),
                    ignoreController,
                    workspaceManager: this.workspaceManager,
                    terminalExecutionMode,
                    readCapabilityToggles: () =>
                        parseTaskCapabilityToggles(this.stateManager.getTaskCacheRef(taskId).taskCapabilityToggles) ??
                        this.getInheritedTaskCapabilityToggles(),
                    shouldUseNativeToolCalls: (providerInfo) =>
                        isNativeToolCallingConfig(
                            providerInfo,
                            this.stateManager.getGlobalStateKey("nativeToolCallEnabled") === true,
                        ),
                    resolveParallelToolCallingEnabled: (providerInfo) =>
                        this.stateManager.getGlobalSettingsKey("enableParallelToolCalling") === true &&
                        isNativeToolCallingConfig(
                            providerInfo,
                            this.stateManager.getGlobalStateKey("nativeToolCallEnabled") === true,
                        ),
                    getParentTaskId: async () => {
                        const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
                        return OrchestratorController.getInstance().getParentTaskId(taskId)
                    },
                },
                hostFactory: new ControllerTaskSessionHostFactory({
                    controller: this,
                    context: this.context,
                    stateManager: this.stateManager,
                    mcpHub: this.mcpHub,
                    ignoreController,
                    workspaceManager: this.workspaceManager,
                }),
                publishState: (publication) => this.postStateToWebview(publication),
                restoredContextWindowIndicator: historyItem
                    ? readHistoryContextWindowIndicator(historyItem.contextWindowIndicator, taskId)
                    : undefined,
            })
        } catch (error) {
            await this.rollbackUnownedOpening(taskId, () => workspaceHistoryManager.closeTask(workspaceHistorySession))
            throw error
        }
        logInitStage("task_construct", taskId)
        this.restartAccountUsagePolling()
        const taskInstance = this.task
        const initializedTaskId = taskInstance.taskId
        const initialTitleText = task ?? historyItem?.task
        this.initialPanelTitle = initialTitleText ? { taskId: initializedTaskId, text: initialTitleText } : undefined

        // Register this controller so active task discovery covers every initTask path.
        const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
        OrchestratorController.getInstance().registerController(initializedTaskId, this)

        void this.persistPanelStateIfNeeded(initializedTaskId)

        try {
            if (historyItem) {
                await options?.onHistoryTaskPreparingToDisplay?.()
                if (this.taskLockAcquired) {
                    await taskInstance.task.open()
                    await taskInstance.activateBackgroundIngress()
                }
                await options?.onHistoryTaskReadyToDisplay?.()
                logInitStage("history_prepare", initializedTaskId, `current=${this.task === taskInstance}`)
                if (this.task !== taskInstance) return initializedTaskId
            } else if (task || images || files) {
                const outcome = await startTaskAfterSurface({
                    taskId: initializedTaskId,
                    startInBackground: options?.startInBackground === true,
                    beforeStart: options?.beforeStart,
                    publishSurface: async () => {
                        // Queue the canonical surface before admission, but do not
                        // let a slow Webview consumer or a large History projection
                        // own provider latency. Delivery remains observed.
                        void this.postStateToWebview({ immediate: true }).catch((error: unknown) =>
                            Logger.warn(`[Task ${initializedTaskId}] Initial surface delivery failed:`, error),
                        )
                        logInitStage("initial_surface_publish", initializedTaskId)
                    },
                    isCurrent: () => this.task === taskInstance,
                    start: async () => {
                        const admissionStartedAt = performance.now()
                        const logAdmissionStage = (stage: string) => {
                            if (Logger.isDebugEnabled()) {
                                Logger.debug(
                                    `[TaskStartPerf] phase=${stage} taskId=${initializedTaskId} elapsedMs=${Math.round(performance.now() - admissionStartedAt)}`,
                                )
                            }
                        }
                        const hookContext = await this.collectTaskStartHookContext(taskInstance, task ?? "")
                        logAdmissionStage("hook_context")
                        // The composer staged into its draft before the task existed;
                        // admission only trusts the task's own resources.
                        const opening = options?.semanticInput
                            ? await bindOpeningDocument(options.semanticInput, initializedTaskId)
                            : undefined
                        const input = await taskInstance.inputs.materialize({
                            text: task,
                            images,
                            files,
                            ...(opening ? { semanticInput: opening.document } : {}),
                            context:
                                [...(options?.context ?? []), ...(hookContext ? [hookContext] : [])].join("\n\n") || undefined,
                            opensTask: true,
                        })
                        logAdmissionStage("input_materialized")
                        const started = await taskInstance.task.start(input)
                        logAdmissionStage("runtime_submitted")
                        if (opening) await releaseOpeningOnceDurable(opening, started, taskInstance.assembly.runtime)
                    },
                    onBackgroundError: async (error) => {
                        const message = error instanceof Error ? error.message : String(error)
                        Logger.error(`[Task ${initializedTaskId}] Background task start failed:`, error)
                        if (this.task === taskInstance) {
                            await taskInstance.owners.messages.addToClineMessages({
                                ts: Date.now(),
                                type: "say",
                                say: "error",
                                text: `Background task failed: ${message}`,
                            })
                            await this.postStateToWebview().catch((postError) => {
                                Logger.error(`[Task ${initializedTaskId}] Failed to post background task error state:`, postError)
                            })
                        }
                        await options?.onBackgroundError?.(error, initializedTaskId)
                    },
                })
                if (outcome === "stale") return initializedTaskId
            }
        } finally {
            // Polling is started once in the constructor and is a controller-
            // lifetime concern — it should NOT be restarted per-task to avoid
            // creating duplicate, un-clearable intervals.
        }

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

    /**
     * Describe this Controller's active task for another task's environment details.
     *
     * The description is derived from canonical session state rather than a
     * runtime object, so a cross-task reader never reaches into another task's
     * lifecycle to render a row.
     */
    describeActiveTask(): ActiveTaskDescriptor | undefined {
        const session = this.task
        if (!session) return undefined
        const taskMessage = session.owners.messages.clineMessages.find((message) => message.say === "task")
        return {
            taskId: session.taskId,
            summary: taskMessage?.text ?? "",
            phase: session.state().flow.phase,
            editedFiles: session.owners.files.getAllModifiedFiles(),
        }
    }

    /**
     * Run the workspace TaskStart hook and return the context it contributes.
     *
     * The result joins the same admitted first input as every other submission,
     * so the hook cannot bypass admission and a host without hooks needs no stub.
     * A hook failure must not silently drop the start: it is reported and the
     * task proceeds without the extra context.
     */
    private async collectTaskStartHookContext(session: ActiveTaskSession, initialTask: string): Promise<string | undefined> {
        try {
            const port = new HookTaskStartContext({
                stateManager: this.stateManager,
                messages: session.owners.messages,
                say: async (type, text) =>
                    session.owners.messages.addToClineMessages({
                        ts: Date.now(),
                        type: "say",
                        say: type as UiMessage["say"],
                        text,
                    }) as unknown as number,
                model: () => getHookModelContext(session.owners.api.current(), this.stateManager),
            })
            return await port.collect({
                taskId: session.taskId,
                ulid: session.owners.identity.taskIncarnationId,
                initialTask,
            })
        } catch (error) {
            Logger.error(`[TaskStart] Hook failed for task ${session.taskId}:`, error)
            return undefined
        }
    }

    /**
     * Bind a task opened from History to the Profile its stable ID resolves to,
     * as dev's Task constructor did, so a Profile renamed while the task was
     * closed resumes under its current name. Promotion reloads task settings
     * from disk, so the binding is flushed before it settles. Settles true once
     * the binding was written; it never rejects.
     */
    private async adoptHistoryDisplayProfileIdentity(taskId: string): Promise<boolean> {
        try {
            const settings = new TaskStateManager(taskId, this.stateManager)
            const mode = settings.mode
            const resolution = await resolveTaskApiProfileFresh(this.stateManager.getApiConfigurationForTask(taskId), mode)
            if (resolution.usedFallback || !resolution.resolvedProfileId || !resolution.resolvedProfile) return false
            settings.adoptResolvedProfileIdentity(mode, resolution.resolvedProfileId, resolution.resolvedProfile)
            await this.stateManager.flushPendingState()
            return true
        } catch (error) {
            Logger.warn(`[History] Failed to bind ${taskId} to its resolved Profile:`, error)
            return false
        }
    }

    private async initHistoryDisplaySession(historyItem: HistoryItem, options?: InitTaskOptions): Promise<string> {
        const session = new HistoryDisplaySession(historyItem)
        this.historyDisplaySession = session

        // A lightweight display still has to report the durable facts a user acts
        // on. Task settings carry the Profile this task is bound to, and the lock
        // file decides whether this surface is read-only. Skipping them made the
        // model switcher fall back to the global Profile and dropped the read-only
        // banner, even though another instance still held the task.
        //
        // Both are small independent reads, so they are started here and awaited
        // alongside the message window: resolving them in sequence before the
        // window would add their latency to the first visible frame. Neither
        // promise rejects: a lock that cannot be read counts as unlocked, and
        // unreadable settings fall back to the global Profile.
        const taskSettings = this.stateManager.loadTaskSettings(session.taskId).catch((error: unknown) => {
            Logger.warn(`[History] Failed to load task settings for ${session.taskId}:`, error)
        })
        const lockStatus = inspectHistoryTaskLock(this.lockService, session.taskId)
        const durableFacts = Promise.all([taskSettings, lockStatus])

        const isCurrent = () => this.historyDisplaySession === session
        const publishReadyHistory = async () => {
            if (!isCurrent()) return
            try {
                // The first frame that carries the task's messages; it must not wait for maintenance.
                await measureHistoryReadinessStage(
                    "history_message_surface",
                    { taskId: session.taskId, hasTaskLock: false, isCurrent },
                    () => this.postStateToWebview({ immediate: true }),
                )
                await options?.onHistoryTaskReadyToDisplay?.()
            } finally {
                // Activity IO blocks the host, so it waits for the message window
                // this frame makes the Webview request, bounded by a fallback.
                session.surfacePublished()
            }
        }
        const remainsCurrent = await prepareHistoryTaskForDisplay({
            taskId: session.taskId,
            displayHistory: async () => {
                const [, lock] = await durableFacts
                if (lock.foreignLock) session.markLocked(lock.foreignLock)
                const ownerless = Promise.resolve(lock.ownerless)
                // Only the owning surface may rewrite task settings. Resolving the
                // Profile and flushing the binding cost hundreds of milliseconds,
                // so the first frame does not wait for them: the header is redrawn
                // once the binding lands, and a promotion waits for it.
                const profileBinding = ownerless.then((owned) =>
                    owned ? this.adoptHistoryDisplayProfileIdentity(session.taskId) : false,
                )
                this.historyDisplayProfileBindings.set(session, profileBinding)
                void profileBinding
                    .then((bound) => (bound && this.historyDisplaySession === session ? this.postStateToWebview() : undefined))
                    .catch((error: unknown) =>
                        Logger.warn(`[History] Failed to redraw ${session.taskId} after its Profile binding:`, error),
                    )
                // Orphan recovery runs after the surface is shown; the rows it
                // settles are redrawn in place once it finishes.
                const onMaintained = async (rows: readonly UiMessage[]) => {
                    if (this.historyDisplaySession !== session) return
                    await Promise.all(rows.map((row) => sendPartialMessageEvent(this, convertClineMessageToProto(row), session)))
                    await this.postStateToWebview()
                }
                const [owned] = await Promise.all([ownerless, session.load({ ownerless, onMaintained })])
                if (this.historyDisplaySession !== session || owned) return
                // The surface no longer owns the lock a previous task held, so an
                // unlock must take the task over rather than find it already owned.
                this.taskLockAcquired = false
                this.startLockPoll(session.taskId)
            },
            // This surface owns no Task runtime, so there is never a canonical
            // history preparation to run. It is unrelated to the task lock.
            prepareFromHistory: async () => undefined,
            hasTaskLock: false,
            isCurrent,
            onPreparingToDisplay: options?.onHistoryTaskPreparingToDisplay,
            onReadyToDisplay: publishReadyHistory,
        })
        if (!remainsCurrent) return session.taskId

        await new Promise((resolve) => setTimeout(resolve, 0))
        if (this.historyDisplaySession !== session) return session.taskId
        void this.syncPanelTitle()
        void this.persistPanelStateIfNeeded(session.taskId)
        return session.taskId
    }

    /**
     * Promote the exact lightweight history interaction into the canonical Task runtime.
     *
     * The lifecycle lock only swaps surface ownership. Canonical readiness and
     * dispatch wait outside it so Close can invalidate this opening immediately.
     */
    async dispatchHistoryDisplayInteraction(
        request: DispatchInteractionRequest,
    ): Promise<DispatchInteractionResponse | undefined> {
        const display = this.historyDisplaySession
        if (!display) return undefined
        if (!display.accepts(request)) {
            Logger.warn(`[HistoryDisplay] Refused stale interaction for task ${display.taskId}: ${describeDispatch(request)}`)
            return DispatchInteractionResponse.create({ accepted: false, result: "stale_interaction" })
        }

        const promoted = await this.runTaskLifecycleOperation(async () => {
            if (this.historyDisplaySession !== display || !display.accepts(request)) {
                Logger.warn(
                    `[HistoryDisplay] Interaction became stale while promoting task ${display.taskId}: ${describeDispatch(request)}`,
                )
                return { response: DispatchInteractionResponse.create({ accepted: false, result: "stale_interaction" }) }
            }
            try {
                await this.promoteHistoryDisplay(display)
                const session = this.task
                if (!session) {
                    Logger.error(`[HistoryDisplay] Promotion produced no task session for ${display.taskId}`)
                    return { response: DispatchInteractionResponse.create({ accepted: false, result: "invalid_runtime_event" }) }
                }
                return { session }
            } catch (error) {
                Logger.error(`[HistoryDisplay] Failed to promote task ${display.taskId}:`, error)
                return { response: DispatchInteractionResponse.create({ accepted: false, result: "invalid_runtime_event" }) }
            }
        })
        if ("response" in promoted) return promoted.response

        const { session } = promoted
        try {
            const interaction = await awaitDispatchableDialog(session, {
                isCurrent: () => this.task === session,
            })
            if (this.task !== session) {
                return DispatchInteractionResponse.create({ accepted: false, result: "stale_interaction" })
            }
            const state = session.state()
            if (!interaction) {
                Logger.error(
                    `[HistoryDisplay] Promoted task ${session.taskId} has no dispatchable dialog: ${describeDialogState(state)}`,
                )
                return DispatchInteractionResponse.create({ accepted: false, result: "invalid_runtime_event" })
            }
            const actionId = resolveCompatibleHistoryAction(interaction, request.actionId)
            if (!actionId) {
                Logger.warn(
                    `[HistoryDisplay] Promoted task ${session.taskId} offers no compatible ${request.actionId}: ${describeDialogState(state)}`,
                )
                return DispatchInteractionResponse.create({ accepted: false, result: "stale_interaction" })
            }
            return await dispatchInteraction(
                this,
                DispatchInteractionRequest.create({
                    ...request,
                    actionId,
                    taskId: session.taskId,
                    taskInstanceId: session.taskInstanceId,
                    turnId: interaction.turnId,
                    interactionId: interaction.interactionId,
                    stateRevision: state.revision,
                }),
            )
        } catch (error) {
            Logger.error(`[HistoryDisplay] Failed to dispatch promoted interaction for task ${session.taskId}:`, error)
            return DispatchInteractionResponse.create({ accepted: false, result: "invalid_runtime_event" })
        }
    }

    /**
     * Replace the lightweight history display with the canonical runtime of the
     * same task. The caller holds the lifecycle lock and has checked that the
     * display is still current.
     */
    private async promoteHistoryDisplay(display: HistoryDisplaySession): Promise<void> {
        // No opening exists from the display's teardown until the runtime is
        // installed; a state published in between would show the task closed.
        await this.openingHandoff.run(
            async () => {
                this.historyDisplaySession = undefined
                // A read-only display may own a lock poll. initTask acquires the lock
                // itself, so leaving that round armed would let it take the same lock
                // concurrently and then activate a surface this promotion replaced.
                this.stopLockPoll()
                // Read before disposal closes the display's reader.
                const renumbers = !display.hasCanonicalMessageIndexes()
                // Wait only for a history-maintenance writer that already started.
                // Read-only hydration and Profile identity refresh continue outside
                // provider admission; both target the same task-local stores/cache.
                await display.disposeForPromotion()
                await this.initTask(undefined, undefined, undefined, display.historyItem, undefined, {
                    skipInitialClear: true,
                    activateHistory: true,
                    // Promotion continues the same view: keeping the opening identity keeps
                    // the Webview's message window and the draft being sent.
                    taskInstanceId: display.taskInstanceId,
                })
                // The runtime imported the legacy history the display read, so the
                // window it served is numbered differently from the runtime's rows.
                if (renumbers) this.messageIndexSpace++
            },
            () => this.postStateToWebview({ immediate: true }),
        )
    }

    /**
     * Bound the task's retained command logs once its lock is held.
     *
     * Chat rows and Activities keep clickable paths into this directory, so the
     * budget is enforced before the session writes new logs and never on a task
     * another window owns. Failure is reported and ignored: losing the prune is
     * not a reason to fail task startup.
     */
    private async pruneOwnedCommandLogs(taskId: string): Promise<void> {
        try {
            const result = await pruneTaskCommandLogs(taskId)
            if (result.deletedCount > 0) {
                Logger.info(
                    `[Task ${taskId}] Pruned command logs: deleted=${result.deletedCount} freedBytes=${result.freedBytes}`,
                )
            }
        } catch (error) {
            Logger.warn(`[Task ${taskId}] Failed to prune command logs:`, error)
        }
    }

    async reinitExistingTaskFromId(taskId: string) {
        const history = await this.getTaskWithId(taskId)
        if (history) {
            await this.initTask(undefined, undefined, undefined, history.historyItem)
        }
    }

    /**
     * Reopen a task whose conversation a chat restore just rewound.
     *
     * The task is opened as an interactive session rather than a history
     * display, because the user resumes it from the restored point, and it is
     * opened as a restore so the runtime plans a resume from the rewound state
     * instead of whatever dialog the discarded tail last ended in.
     */
    async reopenTaskForCheckpointRestore(taskId: string, fence: CheckpointRestoreFence, editedText?: string): Promise<void> {
        const active = this.task
        if (!active || active.taskId !== taskId || active.owners.identity.taskIncarnationId !== fence.taskIncarnationId) {
            throw new Error(`Checkpoint restore session changed for task ${taskId}`)
        }
        this.pendingCheckpointRestore = { taskId, fence, ...(editedText === undefined ? {} : { editedText }) }
    }

    /** Finish a staged chat restore only after the old checkpoint operation has returned. */
    async completeTaskCheckpointRestore(taskId: string): Promise<void> {
        const pending = this.pendingCheckpointRestore
        if (!pending || pending.taskId !== taskId) return
        this.pendingCheckpointRestore = undefined
        await this.runTaskLifecycleOperation(async (scope) => {
            const active = this.task
            if (
                !active ||
                active.taskId !== taskId ||
                active.owners.identity.taskIncarnationId !== pending.fence.taskIncarnationId
            ) {
                throw new Error(`Checkpoint restore session changed for task ${taskId}`)
            }
            const history = await this.getTaskWithId(taskId)
            await scope.clearTask({
                suppressPostState: true,
                checkpointRestoreFence: pending.fence,
                closeReason: "checkpoint_restore",
            })
            await this.initTask(undefined, undefined, undefined, history.historyItem, undefined, {
                activateHistory: true,
                openReason: "checkpoint_restore",
                skipInitialClear: true,
            })
            const session = this.task
            if (!session || session.taskId !== taskId) {
                throw new Error(`Checkpoint chat restore could not reopen task ${taskId}`)
            }
            if (pending.editedText !== undefined) {
                const interaction = await awaitDispatchableDialog(session, {
                    actionId: "resume",
                    isCurrent: () => this.task === session,
                })
                if (!interaction) throw new Error(`Checkpoint chat restore has no Resume interaction for task ${taskId}`)
                const state = session.state()
                const response = await dispatchInteraction(
                    this,
                    DispatchInteractionRequest.create({
                        taskId: session.taskId,
                        taskInstanceId: session.taskInstanceId,
                        turnId: interaction.turnId,
                        interactionId: interaction.interactionId,
                        actionId: "resume",
                        stateRevision: state.revision,
                        draft: { text: pending.editedText, images: [], files: [] },
                    }),
                )
                if (!response.accepted) {
                    throw new Error(`Checkpoint chat restore Resume was refused for task ${taskId}: ${response.result}`)
                }
            }
        })
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
            draftCarrier: controllerTransitionDraftCarrier(this),
            compaction: new ControllerTransitionCompactionPort({ getSession: () => this.task }),
            postState: () => this.postStateToWebview({ immediate: true }),
            createId: () => randomUUID(),
        })
    }

    /** Build the Mode-specific policy and expose the compatibility RPC adapter. */
    private createModeSwitchCoordinator(): ModeSwitchCoordinator {
        const policy = new ModeTransitionPolicy({
            profiles: {
                getSource: () => (this.task ? this.resolveModeProfile(this.task.owners.settings.mode) : undefined),
                resolve: (mode) => this.resolveModeProfile(mode),
            },
            pressure: {
                read: async () => this.getOccupiedContextTokens(),
            },
            commit: {
                validate: (operation) => this.validateModeSwitch(operation),
                commit: async (operation) => {
                    // Pinned once: the transition lease does not fence task replacement,
                    // so re-reading `this.task` after an await could switch another task.
                    const session = this.task
                    if (!session) throw new Error("Active task is unavailable.")
                    const sourceMode = session.owners.settings.mode
                    let rebuilt = false
                    session.owners.settings.setMode(operation.target.mode)
                    try {
                        // The frozen prompt and its tool projection are keyed by provider and
                        // model, not Mode; without an explicit refresh the next request would
                        // still carry the source Mode's instructions and tools. Request it
                        // before the draft is delivered, because that reply may start the next
                        // provider round immediately.
                        session.owners.prompt.requestRefresh("mode_switch")
                        await session.owners.api.rebuild({ abortPrevious: true })
                        rebuilt = true
                    } catch (error) {
                        await this.restoreSourceMode(session, sourceMode, rebuilt)
                        throw error
                    }
                    telemetryService.captureModeSwitch(session.owners.identity.taskIncarnationId, operation.target.mode)
                    this.restartAccountUsagePolling()
                    // The engine publishes the settled transition right after this commit,
                    // so the commit itself does not wait on view delivery.
                },
            },
            getTaskId: () => this.task?.taskId,
        })
        return new ModeSwitchCoordinator({ engine: this.contextTransitionEngine, policy })
    }

    /**
     * Put a task back on the Mode a failed switch started from.
     *
     * Settings are always restored so the persisted Mode matches the handler the
     * task keeps; the handler is rebuilt only when the switch had replaced it and
     * the task is still the one this Controller serves.
     */
    private async restoreSourceMode(session: ActiveTaskSession, sourceMode: Mode, rebuilt: boolean): Promise<void> {
        session.owners.settings.setMode(sourceMode)
        session.owners.prompt.requestRefresh("mode_switch")
        if (!rebuilt || this.task !== session) return
        try {
            await session.owners.api.rebuild({ abortPrevious: true })
        } catch (error) {
            Logger.error(
                `[ModeSwitch] ${session.taskId}: could not rebuild the ${sourceMode} handler after a failed switch: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    private getOccupiedContextTokens(): number {
        const indicator = shownContextWindowIndicator(this.task, this.historyDisplaySession)
        return indicator ? getContextWindowIndicatorTotalTokens(indicator) : 0
    }

    /** Build the Profile policy that rebinds handlers behind at most one advisory notice. */
    private createProfileSwitchCoordinator(): ProfileSwitchCoordinator {
        const policy = new ProfileTransitionPolicy({
            bindings: {
                getCurrentMode: () => this.task?.owners.settings.mode ?? "plan",
                getBinding: (mode) => this.resolveTaskProfileName(mode),
                resolveTarget: (profileId, profileName, mode) => this.resolveProfileTarget(profileId, profileName, mode),
            },
            occupied: {
                getOccupiedTokens: () => this.getOccupiedContextTokens(),
            },
            commit: {
                validate: (operation) => this.validateProfileSwitch(operation),
                commit: async (operation) => {
                    const session = this.task
                    if (!session) throw new Error("Active task is unavailable.")
                    const binding = { profileId: operation.targetProfileId, profileName: operation.targetProfile }
                    const previous = session.owners.settings.setProfileIdentityBindings(
                        Object.fromEntries(operation.targetModes.map((mode) => [mode, binding])),
                        { clearRuntimeOverrides: true },
                    )
                    let rebuilt = false
                    try {
                        await session.owners.api.rebuild({ abortPrevious: true })
                        rebuilt = true
                        // The switch is committed only once the binding is on disk, as dev
                        // did: History Resume and other windows read the task settings file.
                        await this.stateManager.flushPendingState()
                    } catch (error) {
                        // Neither the handler nor the bindings may claim a switch that did not commit.
                        session.owners.settings.restoreProfileState(previous)
                        if (rebuilt) await session.owners.api.rebuild({ abortPrevious: true })
                        throw error
                    }
                    // A running retry countdown retries a failure of the Profile the user
                    // just left; the failure goes back to them with Retry rather than being
                    // sent again on its own.
                    session.owners.providerRetry?.handBack()
                    await session.owners.interactions.dismissProviderFailure()
                    this.restartAccountUsagePolling()
                },
            },
            getTaskId: () => this.task?.taskId,
        })
        return new ProfileSwitchCoordinator({ engine: this.profileTransitionEngine, policy })
    }

    /**
     * Freeze the Profile a task starts on into its own settings.
     *
     * Mode and capability toggles are already captured here, and the Profile
     * belongs with them: without its own binding the task merely reads whichever
     * Profile is globally selected, so switching Profiles later rewrote history
     * and a task could resume on a Profile it never ran on.
     *
     * Only a task with no binding at all is seeded. A resumed task carries its
     * own, and overwriting it from global state is exactly the drift this
     * prevents.
     */
    private bindTaskProfileOnCreate(taskId: string): void {
        const cache = this.stateManager.getTaskCacheRef(taskId)
        if (cache.planModeProfileId ?? cache.planModeProfile ?? cache.actModeProfileId ?? cache.actModeProfile) return
        const configuration = this.stateManager.getApiConfigurationForTask(taskId)
        const bindings = [
            {
                id: "planModeProfileId",
                name: "planModeProfile",
                profileId: configuration.planModeProfileId,
                profileName: configuration.planModeProfile,
            },
            {
                id: "actModeProfileId",
                name: "actModeProfile",
                profileId: configuration.actModeProfileId,
                profileName: configuration.actModeProfile,
            },
        ] as const
        for (const binding of bindings) {
            if (binding.profileId !== undefined) this.stateManager.setTaskSettings(taskId, binding.id, binding.profileId)
            if (binding.profileName !== undefined) this.stateManager.setTaskSettings(taskId, binding.name, binding.profileName)
        }
    }

    /** Resolve the stable task-local Profile identity for one mode. */
    private resolveTaskProfileId(mode: Mode): string | undefined {
        if (!this.task) return undefined
        const config = this.stateManager.getApiConfigurationForTask(this.task.taskId)
        return mode === "plan"
            ? (this.task.owners.settings.planModeProfileId ?? config.planModeProfileId)
            : (this.task.owners.settings.actModeProfileId ?? config.actModeProfileId)
    }

    /** Resolve the effective task-local Profile name for one mode. */
    private resolveTaskProfileName(mode: Mode): string | undefined {
        if (!this.task) return undefined
        const config = this.stateManager.getApiConfigurationForTask(this.task.taskId)
        return mode === "plan"
            ? (this.task.owners.settings.planModeProfile ?? config.planModeProfile)
            : (this.task.owners.settings.actModeProfile ?? config.actModeProfile)
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
            ...(this.task.owners.settings.planModeProfileId !== undefined && {
                planModeProfileId: this.task.owners.settings.planModeProfileId,
            }),
            ...(this.task.owners.settings.planModeProfile !== undefined && {
                planModeProfile: this.task.owners.settings.planModeProfile,
            }),
            ...(this.task.owners.settings.actModeProfileId !== undefined && {
                actModeProfileId: this.task.owners.settings.actModeProfileId,
            }),
            ...(this.task.owners.settings.actModeProfile !== undefined && {
                actModeProfile: this.task.owners.settings.actModeProfile,
            }),
            ...(mode === "plan"
                ? { planModeProfileId: resolution.profileId, planModeProfile: resolution.profileName }
                : { actModeProfileId: resolution.profileId, actModeProfile: resolution.profileName }),
            ulid: this.task.owners.identity.taskIncarnationId,
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
            ulid: this.task.owners.identity.taskIncarnationId,
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
        const source = this.task ? this.resolveModeProfile(this.task.owners.settings.mode) : undefined
        return Boolean(
            this.task?.taskId === operation.taskId &&
                source?.mode === operation.source.mode &&
                source.profileId === operation.source.profileId &&
                source.contextWindow === operation.source.contextWindow,
        )
    }

    /** Validate every source binding captured before a Profile preflight. */
    private validateProfileSwitch(operation: ProfileSwitchOperation): boolean {
        if (this.task?.taskId !== operation.taskId || this.task.owners.settings.mode !== operation.activeMode) return false
        return operation.targetModes.every((mode) => this.resolveTaskProfileName(mode) === operation.sourceBindings[mode])
    }

    /** Reject Task-local runtime override changes while the active Task cannot safely replace its handler. */
    assertTaskRuntimeOverridesMutable(taskId: string): void {
        const task = this.task
        if (!task || task.taskId !== taskId) return

        const runtimeState = task.state()
        if (["initializing", "running", "halting"].includes(runtimeState.flow.phase)) {
            throw new Error("Task runtime overrides cannot change while a request is active.")
        }
        if (task.state().flow.compaction || task.owners.toolState.currentlySummarizing) {
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
        if (!this.task.writable) return { status: "rejected", error: READ_ONLY_TASK_ERROR }
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

        const display = this.historyDisplaySession
        if (!this.task && display) return this.commitHistoryDisplayProfile(display, resolution, uniqueModes)

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
        if (!this.task.writable) return { status: "rejected", error: READ_ONLY_TASK_ERROR }

        return this.profileSwitchCoordinator.request({
            taskId: this.task.taskId,
            targetProfileId: resolution.profileId,
            targetProfile: resolution.profileName,
            targetModes: uniqueModes,
            chatContent,
        })
    }

    /**
     * Bind the task a read-only history panel shows to the selected Profile.
     *
     * Dev resumes a reopened task as a live Task, so the switch lands on that
     * task's binding and never on global state. The display session has no live
     * Task, but the panel's switcher and the task it promotes to on send both
     * read the task's own binding, so the same write keeps the windows
     * independent. The binding is saved before reporting success because
     * promotion reloads task settings from disk.
     */
    private async commitHistoryDisplayProfile(
        display: HistoryDisplaySession,
        resolution: { readonly profileId: string; readonly profileName: string },
        modes: readonly Mode[],
    ): Promise<ProfileSwitchRequestResult> {
        if (display.isLocked()) return { status: "rejected", error: READ_ONLY_TASK_ERROR }
        // The first frame no longer waits for the task's own Profile binding, so
        // the switcher is usable while that binding is still being adopted. The
        // user's choice is written after it lands; otherwise the late adoption
        // would overwrite the choice and the task would promote on the old Profile.
        await this.historyDisplayProfileBindings.get(display)
        const taskSettings = new TaskStateManager(display.taskId, this.stateManager)
        const binding = { profileId: resolution.profileId, profileName: resolution.profileName }
        const bindings: Partial<Record<Mode, typeof binding>> = {}
        for (const mode of modes) bindings[mode] = binding
        const previous = taskSettings.setProfileIdentityBindings(bindings, { clearRuntimeOverrides: true })
        try {
            await this.stateManager.flushPendingState()
        } catch (error) {
            taskSettings.restoreProfileState(previous)
            return { status: "rejected", error: error instanceof Error ? error.message : String(error) }
        }
        this.restartAccountUsagePolling()
        await this.postStateToWebview({ immediate: true })
        return { status: "switched", operationId: randomUUID() }
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
        this.task.owners.settings.setMode("act")
        await this.task.owners.api.rebuild({ abortPrevious: true })
        telemetryService.captureModeSwitch(this.task.owners.identity.taskIncarnationId, "act")
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
            const result = await this.task.task.cancel(randomUUID())
            if (result.kind === "rejected") {
                Logger.warn(`Controller.cancelTask: runtime rejected cancellation (${result.diagnostic.code})`)
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
     * The title is always derived from {@link resolveTaskPanelTitle} so the focus
     * chain progress suffix can never be dropped by a caller passing raw text.
     */
    async syncPanelTitle(): Promise<void> {
        if (this.uiDetached || this.disposed || !this.getCurrentTaskId()) {
            return
        }
        const session = this.task
        const resolvedTitle = resolveTaskPanelTitle({
            taskRow: session?.owners.messages.clineMessages.find((message) => message.say === "task")?.text,
            initialTask: session && this.initialPanelTitle?.taskId === session.taskId ? this.initialPanelTitle.text : undefined,
            historyTask: this.historyDisplaySession?.historyItem.task,
            checklist: session?.owners.toolState.currentFocusChainChecklist ?? null,
        })
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
        const didCancel = await this.task?.owners.commands.cancelBackgroundCommand()
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
                    await this.task.owners.api.rebuild({ abortPrevious: true })
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
                    await this.task.owners.api.rebuild({ abortPrevious: true })
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
                await this.task.owners.api.rebuild({ abortPrevious: true })
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
                await this.task.owners.api.rebuild({ abortPrevious: true })
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
                await this.task.owners.api.rebuild({ abortPrevious: true })
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
    }> {
        const history = this.stateManager.getGlobalStateKey("taskHistory")
        const historyItem = history.find((item) => item.id === id)
        if (historyItem) {
            const taskDirPath = path.join(await getDlineDocumentsPath(), "tasks", id)
            const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
            const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
            const contextHistoryFilePath = path.join(taskDirPath, GlobalFileNames.contextHistory)
            const taskMetadataFilePath = path.join(taskDirPath, GlobalFileNames.taskMetadata)
            // A task exists while its directory does; its conversation lives in the task journal.
            if (await fileExistsAtPath(taskDirPath)) {
                return {
                    historyItem,
                    taskDirPath,
                    apiConversationHistoryFilePath,
                    uiMessagesFilePath,
                    contextHistoryFilePath,
                    taskMetadataFilePath,
                }
            }
        }
        // A history entry without a task directory has nothing left to open.
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
            this.stateManager.setActiveTaskId(this.getCurrentTaskId())
            this.scheduleCoalescedStatePost()
            return
        }
        this.clearPendingStatePost()
        await this.publishState(options)
    }

    /** Queue one latest-wins patch for a burst of transient Task view changes. */
    private scheduleTaskViewPatch(): void {
        if (this.taskViewPatchScheduled) return
        this.taskViewPatchScheduled = true
        queueMicrotask(() => {
            this.taskViewPatchScheduled = false
            if (!this.isUiAttached()) return
            this.postTaskViewPatchToWebview().catch((error: unknown) => {
                Logger.error("[Controller] Transient Task view publication failed:", error)
            })
        })
    }

    /** Publish the interaction-critical Task view without paying for a full ExtensionState build. */
    async postTaskViewPatchToWebview(): Promise<void> {
        if (this.uiDetached || this.disposed || !this.getCurrentTaskId()) {
            this.suppressedStatePostsAfterDetach++
            return
        }
        this.stateManager.setActiveTaskId(this.getCurrentTaskId())
        const stateRevision = ++this.nextStateRevision
        this.latestStateRevision = Math.max(this.latestStateRevision, stateRevision)
        await sendStatePatch(
            this,
            {
                stateRevision,
                taskViewState: this.projectCurrentTaskViewState(),
            },
            this._accountUsage,
        )
    }

    /**
     * Build the current state once and hand it to delivery when still current.
     *
     * A build is dropped when a later one finished first. Unary state reads
     * (getLatestState, getProcessInfo) build state too but never deliver it to
     * the subscription, so a publication they overtake must publish again:
     * once an interaction is revealed the task commits nothing more, and the
     * revealed dialog would otherwise never reach the webview.
     */
    private async publishState(options?: PostStateOptions): Promise<void> {
        if (this.openingHandoff.holds(this.currentOpening() !== undefined)) return
        const publication = ++this.publicationSequence
        const state = await this.getStateToPostToWebview()
        // The build follows the opening, so one that started before a handoff
        // can finish inside it with no task.
        if (this.openingHandoff.holds(this.currentOpening() !== undefined)) return
        if (!this.isStateCurrent(state.stateRevision)) {
            if (publication === this.publicationSequence) this.scheduleCoalescedStatePost()
            return
        }
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
            this.publishState({ immediate: true }).catch((error: unknown) => {
                Logger.error("[Controller] Coalesced state publication failed:", error)
            })
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

    /**
     * The rate history query for the task shown in this panel, running or viewed from History.
     * @returns undefined when no shown task matches the requested id.
     */
    resolveTaskRateMetricsQuery(taskId: string): TaskRateMetricsQueryFn | undefined {
        return selectTaskRateMetricsQuery(taskId, this.task, this.historyDisplaySession)
    }

    /**
     * Project the active canonical Task state at the Controller presentation boundary.
     *
     * A dialog is only dispatchable once its anchor row is found, so a caller
     * that omits the messages would publish a view whose input is disabled and
     * whose interaction is absent. Defaulting to the task's own rows keeps the
     * interaction-only patch equivalent to the full state build; the parameter
     * remains for callers that already materialized the same window.
     *
     * Every view names the opening it belongs to; the Webview keys its message
     * window, pages and activity streams by that opening.
     */
    private projectCurrentTaskViewState(messages?: readonly UiMessage[]): TaskViewState | undefined {
        const historyDisplay = this.historyDisplaySession
        if (historyDisplay) return { ...historyDisplay.getViewState(), taskInstanceId: historyDisplay.taskInstanceId }
        const session = this.task
        if (!session) return undefined
        const rows = messages ?? this.getCurrentTaskMessages()
        const view = adaptCanonicalTaskView(
            session.projectView(),
            rows,
            composeBackgroundHandoffAvailability(session.owners.commands, session.owners.activities),
            session.owners.providerRetry?.phase ?? "idle",
            session.owners.compactionRecovery?.truncationOffered() === true,
        )
        // Another window owns the task: show it, but offer nothing that would write.
        const owned = session.writable ? view : readOnlyTaskView(view)
        const handoff = this.handoffOpening
        return {
            ...owned,
            taskInstanceId: session.taskInstanceId,
            ...(handoff && handoff.taskInstanceId === session.taskInstanceId ? { handoffSource: handoff.source } : {}),
        }
    }

    /** Build a monotonic extension state while preserving the public non-optional contract. */
    async getStateToPostToWebview(): Promise<ExtensionState> {
        if (this.uiDetached || this.disposed) this.stateBuildsAfterDetach++
        const revision = ++this.nextStateRevision
        // A build that straddles an opening switch would mix two openings' state.
        let owner = this.currentOpening()
        let state = await this.buildState(revision)
        while (owner !== this.currentOpening() && !this.disposed && !this.uiDetached) {
            owner = this.currentOpening()
            state = await this.buildState(revision)
        }
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
        const surfaceTaskId = this.getCurrentTaskId()
        if (surfaceTaskId) {
            this.stateManager.setActiveTaskId(surfaceTaskId)
        } else {
            this.stateManager.setActiveTaskId(undefined)
        }
        // Get API configuration from cache — must be AFTER setActiveTaskId
        // so that getSettingWithOverride() can read task-level profile overrides.
        const onboardingModels = getClineOnboardingModels()
        let apiConfiguration = this.stateManager.getApiConfiguration()

        // Override with task-level profile settings if available (multi-window isolation fix)
        if (this.task?.owners.settings) {
            const taskPlanProfileId = this.task.owners.settings.planModeProfileId
            const taskPlanProfile = this.task.owners.settings.planModeProfile
            const taskActProfileId = this.task.owners.settings.actModeProfileId
            const taskActProfile = this.task.owners.settings.actModeProfile
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
        const mode =
            this.task?.owners.settings.mode ??
            this.historyDisplaySession?.historyItem.mode ??
            this.stateManager.getGlobalSettingsKey("mode")
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
        const taskCapabilityToggles = parseTaskCapabilityToggles(this.task?.owners.settings.taskCapabilityToggles)
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
        const mcpToolsOnDemandEnabled = this.stateManager.getGlobalSettingsKey("mcpToolsOnDemandEnabled")
        const imageGenerationEnabled = this.stateManager.getCanonicalSettingsKey("imageGenerationEnabled")
        const showFeatureTips = this.stateManager.getGlobalSettingsKey("showFeatureTips")
        const showActiveTasksInEnvDetails = this.stateManager.getGlobalSettingsKey("showActiveTasksInEnvDetails")

        const localClineRulesToggles = this.readLocalCapabilityToggles("rules")
        const localWindsurfRulesToggles = this.readLocalCapabilityToggles("windsurfRules")
        const localCursorRulesToggles = this.readLocalCapabilityToggles("cursorRules")
        const localAgentsRulesToggles = this.readLocalCapabilityToggles("agentsRules")
        const workflowToggles = this.readLocalCapabilityToggles("workflows")

        const currentTaskItem = surfaceTaskId ? (taskHistory || []).find((item) => item.id === surfaceTaskId) : undefined
        // Read the message list once. The getter merges and sorts transient
        // entries on every access, so a second read costs another full pass over
        // a conversation that can hold tens of thousands of messages.
        const rawMessages = [...this.getCurrentTaskMessages()]
        // The title is presentation metadata, never a Task identity.
        // A history display retains only the latest message window, so its first
        // durable message is read separately rather than forcing a full history load.
        const taskTitleMessage =
            this.historyDisplaySession?.getTaskTitleMessage() ?? rawMessages.find((m) => m.say === "task") ?? rawMessages.at(0)
        // Separate task header message from body messages. Read the header from the
        // in-memory message list instead of re-reading ui_messages.jsonl on every
        // state push: getTaskHeaderText() bypasses the jsonl cache and performs a
        // full fs.readFile + per-line JSON.parse, which dominated buildState() time
        // in long conversations (900-2500ms per push in field logs).
        const _taskHeaderText = taskTitleMessage?.text ?? ""
        // totalMessageCount now includes the task message (matching fetchMessage behavior)
        // so the frontend can detect when scrolled to the absolute top (index 0)
        const totalMessageCount = this.getCurrentTaskMessageCount()
        // firstItemIndex is managed by fetchMessage; the history display already
        // holds the latest bounded window rather than the complete file.
        const firstItemIndex = Math.max(0, totalMessageCount - rawMessages.length)
        const checkpointManagerErrorMessage = this.historyDisplaySession?.historyItem.checkpointManagerErrorMessage
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
        const historyItem = this.historyDisplaySession?.historyItem
        if (historyItem) {
            aggregatedMetrics = {
                totalTokensIn: historyItem.tokensIn,
                totalTokensOut: historyItem.tokensOut,
                totalCacheWrites: historyItem.cacheWrites,
                totalCacheReads: historyItem.cacheReads,
                totalCost: historyItem.totalCost,
                cacheHitRate: historyItem.cacheHitRate,
                currency: historyItem.currency,
            }
        } else {
            try {
                aggregatedMetrics = this.task?.owners.messages.readStateMetrics()
            } catch (error) {
                Logger.warn("Failed to aggregate api metrics:", error)
            }
        }
        const { getApiMetrics, getLastApiReqTotalTokens, getLastTaskProgressText } = await import("@shared/getApiMetrics")
        // Combining parses each paired request as a whole, so a single
        // malformed entry fails the aggregate outright. The per-message pass
        // isolates its parsing per entry, so falling back to it keeps the
        // remaining usage visible: reporting zero tokens for a long
        // conversation is a worse answer than an approximate total.
        const usageTotals = aggregatedMetrics ?? getApiMetrics(rawMessages)
        const rateSnapshot = this.task?.owners.apiRateSnapshot?.() ?? this.historyDisplaySession?.getRateSnapshot() ?? {}
        const apiMetrics = {
            ...usageTotals,
            ...rateSnapshot,
            // The rows price every request, including the ones a provider did not
            // price, and add subagent usage; the provider-round store only holds
            // reported cost. Cost therefore stays with the rows, as in task history.
            totalCost: usageTotals.totalCost,
            currency: usageTotals.currency ?? rateSnapshot.currency,
        }
        const contextWindowIndicator = shownContextWindowIndicator(this.task, this.historyDisplaySession)
        const lastApiReqTotalTokens = contextWindowIndicator
            ? getContextWindowIndicatorTotalTokens(contextWindowIndicator)
            : getLastApiReqTotalTokens(rawMessages) || undefined

        // If currentFocusChainChecklist is null, fall back to searching
        // the full message list (not the window slice) for task_progress.
        const checklistFromTaskState = this.task?.owners.toolState.currentFocusChainChecklist || null
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
            messageWindowRevision: this.task?.owners.messages.messageWindowMutationRevision ?? 0,
            messageIndexSpace: this.messageIndexSpace,
            firstItemIndex,
            apiMetrics,
            contextWindowIndicator,
            lastApiReqTotalTokens,
            promptCacheHealth: this.task?.owners.promptCache.getSnapshot(),
            promptFreshness: this.task?.owners.prompt.getFreshness(),
            currentFocusChainChecklist: checklistForState,
            // The history file is append-only and used to be projected whole on
            // every push, which is what made a long-running task rebroadcast a
            // multi-megabyte payload several times a second. The full file stays
            // on disk and is still opened directly from the panel.
            focusChainHistory: projectFocusChainHistory(
                this.task?.owners.toolState.focusChainHistory ?? this.historyDisplaySession?.getFocusChainHistory() ?? undefined,
            ).text,
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
            // Clamped but not toggle-coerced: the projection carries the ceiling
            // the user configured, and the runtime applies the toggle when it
            // builds the pool.
            maxParallelToolCalls: resolveMaxParallelToolCalls(
                this.stateManager.getGlobalSettingsKey("maxParallelToolCalls"),
                true,
            ),
            maxParallelSubagents: resolveMaxParallelSubagents(this.stateManager.getGlobalSettingsKey("maxParallelSubagents")),
            backgroundEditEnabled: this.stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
            optOutOfRemoteConfig: this.stateManager.getGlobalSettingsKey("optOutOfRemoteConfig"),
            doubleCheckCompletionEnabled,
            lazyTeammateModeEnabled,
            mcpEnabled,
            mcpToolsOnDemandEnabled,
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
            inputQueue: this.task
                ? [...(await this.task.inputQueue.project())]
                : [...(this.historyDisplaySession?.getInputQueue() ?? [])],
            transitionDraft: this.task ? await projectTransitionDraft(this.task) : undefined,
            /** Complete interaction view projected only from canonical runtime state. */
            taskViewState: this.projectCurrentTaskViewState(rawMessages),
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
                `[StateUpdate] build timing: taskId=${surfaceTaskId ?? "none"}, buildMs=${durationMs}, activeTasks=${activeTasks}`,
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
        await this.task?.owners.api.rebuild({ abortPrevious: true })
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
            const loadAccountUsage = handler.getAccountUsage?.bind(handler)
            if (!loadAccountUsage || decideAccountUsageRead(handler, profileKey, this.accountUsageSingleReadKey) === "skip") {
                handler.abort?.()
                // Only a provider that cannot report usage at all invalidates the
                // published snapshot; a skipped repeat must keep showing the one
                // reading this Profile already produced.
                if (!loadAccountUsage) await clearStaleUsage()
                return
            }
            const getAccountUsage = async () =>
                decorateProviderAccountUsage(profile, await loadAccountUsage(), this.readLocalDailyTokens(profile.id))
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
            // Marked only once a reading actually arrived. Marking before the
            // request would turn a first failure, or a view hidden mid-request,
            // into a Profile that is never read again.
            if (!allowsAccountUsagePolling(handler)) this.accountUsageSingleReadKey = profileKey
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
        // A restart follows a Profile or credential change, so the one allowed
        // read is owed again even to a provider that refuses the timer.
        this.accountUsageSingleReadKey = undefined
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
        // Bound to the opening that started polling, so a close or reopen in
        // between can never be taken over by a stale round.
        const owner = this.currentOpening()
        this.lockPollTimer = setInterval(() => {
            void this.runTaskLifecycleOperation(async (scope) => {
                if (generation !== this.lockPollGeneration || this.currentOpening() !== owner || this.disposed) return
                if (!owner || owner.taskId !== taskId || this.taskLockAcquired) return
                // Only a released or stale lock is worth a takeover attempt.
                const status = await this.lockService.checkTaskLock(taskId)
                if (status.isLocked && !status.isStale) return
                await this.takeOverTaskAfterUnlock(owner, scope)
            }).catch((error) => Logger.warn(`[Lock] Poll error for task ${taskId}:`, error))
        }, 30000)
    }

    /**
     * Stops the lock polling timer and invalidates any round already running.
     */
    private stopLockPoll() {
        this.lockPollGeneration++
        for (const timer of this.lockTakeoverTimers) clearTimeout(timer)
        this.lockTakeoverTimers.clear()
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
        const owner = this.currentOpening()
        if (!owner || owner.taskId !== taskId) return
        const timer = setTimeout(() => {
            this.lockTakeoverTimers.delete(timer)
            void this.runTaskLifecycleOperation((scope) => this.takeOverTaskAfterUnlock(owner, scope)).catch((error) => {
                Logger.error(`[Lock] Failed to take over task ${taskId} after unlock:`, error)
            })
        }, 0)
        this.lockTakeoverTimers.add(timer)
    }

    /**
     * Acquire the released lock and activate the opening, or keep polling when
     * another instance took it first. Called only inside the Task lifecycle
     * lane, so a close or reopen cannot interleave with the takeover.
     */
    private async takeOverTaskAfterUnlock(owner: TaskOpening, scope: TaskLifecycleScope): Promise<void> {
        if (this.disposed || this.currentOpening() !== owner || this.taskLockAcquired) return
        const taskId = owner.taskId
        if (this.task?.taskId === taskId && this.task.upgradeImportPending) {
            await this.reopenForUpgradeImport(taskId, scope)
            return
        }
        const acquired = await this.lockService.acquireTaskLock(taskId)
        if (!acquired) {
            // Another instance won the released lock. Stay read-only and let the
            // existing poll pick the task up when it becomes available again.
            Logger.warn(`[Lock] Task ${taskId} was re-locked before this instance could take over`)
            await this.postStateToWebview()
            return
        }
        if (this.disposed || this.currentOpening() !== owner) {
            await this.releaseOwnedTaskLock(taskId)
            return
        }
        this.taskLockAcquired = true
        this.stopLockPoll()
        this.startLockHeartbeat(taskId)
        // Holding the lock means no other window writes here, so stale temp files are a crashed writer's.
        void cleanupStaleTaskTempFiles(taskId).catch((error) =>
            Logger.warn(`[Task ${taskId}] Stale temp file cleanup failed:`, error),
        )

        // A lightweight history display owns the read-only projection itself, so
        // clearing the lock has to reach the session too. Without this the banner
        // and the disabled footer survive an unlock that already succeeded.
        const historyDisplay = this.historyDisplaySession
        if (historyDisplay?.taskId === taskId) {
            historyDisplay.markUnlocked()
        }

        // Publish the stopped interaction state after the task becomes writable.
        if (this.task) {
            try {
                this.task.activateCollaboration()
                await this.task.task.open()
                await this.task.activateBackgroundIngress()
            } catch (error) {
                Logger.error(`[Lock] Failed to prepare task ${taskId} after unlock:`, error)
            }
        }

        // Notify webview so the read-only banner is removed
        await this.postStateToWebview()
        Logger.debug(`[Lock] Task ${taskId} activated after force-unlock`)
    }

    /**
     * Reopen a session that hydrated without the history an earlier version left.
     *
     * Opening it in place would let its first write close the import off for
     * good. Reopening runs the import before the kernel reads the stores, and
     * reads every store fresh. initTask takes the lock itself; if another window
     * wins it, the task opens read-only again and the poll resumes.
     *
     * A takeover runs from a timer with no caller to report to, so a failed
     * reopen is shown to the user rather than leaving an emptied chat behind.
     * The handoff publishes the resulting state once, whether the lookup or the
     * reopen failed.
     */
    private async reopenForUpgradeImport(taskId: string, scope: TaskLifecycleScope): Promise<void> {
        Logger.info(`[Lock] Reopening task ${taskId} to import data from an earlier version`)
        try {
            // The same task stays on screen; the Webview must not see it close in between.
            await this.openingHandoff.run(
                async () => {
                    const history = await this.getTaskWithId(taskId)
                    await scope.clearTask({ suppressPostState: true, closeReason: "task_switch" })
                    await this.initTask(undefined, undefined, undefined, history.historyItem, undefined, {
                        activateHistory: true,
                        skipInitialClear: true,
                    })
                },
                () => this.postStateToWebview({ immediate: true }),
            )
        } catch (error) {
            HostProvider.window.showMessage({
                type: ShowMessageType.ERROR,
                message: `Could not reopen the task to import its earlier conversation: ${error instanceof Error ? error.message : String(error)}`,
            })
            throw error
        }
    }

    /**
     * Release what an opening acquired before a session owned it: the poll, the
     * heartbeat and the lock, the task settings cache and the workspace history
     * slot. A cleanup failure is logged so the opening's own error still reaches
     * the caller.
     */
    private async rollbackUnownedOpening(taskId: string, closeHistory: () => void): Promise<void> {
        this.stopLockPoll()
        this.workspaceHistorySession = undefined
        try {
            closeHistory()
            await this.stopLockHeartbeat(taskId)
            if (this.taskLockAcquired) {
                this.taskLockAcquired = false
                await this.releaseOwnedTaskLock(taskId)
            }
            await this.stateManager.clearTaskSettings(taskId)
        } catch (cleanupError) {
            Logger.error(`[Task ${taskId}] Failed to roll back an opening that did not complete`, cleanupError)
        }
    }

    /**
     * Keep the lock this instance holds fresh until teardown drains it.
     *
     * The lease is bound to the task id, not to a session object: the lock is
     * acquired before the interactive session exists, and an unlocked history
     * display holds it without one.
     */
    private startLockHeartbeat(taskId: string): void {
        if (this.lockHeartbeatTimer) clearInterval(this.lockHeartbeatTimer)
        const lease = { taskId }
        this.lockHeartbeatLease = lease
        this.lockHeartbeatTimer = setInterval(() => {
            if (this.lockHeartbeatLease !== lease || this.lockHeartbeatPending) return
            const pending = this.lockService
                .touchTaskLock(taskId)
                .then((held) => {
                    const opening = this.currentOpening()
                    if (held || this.lockHeartbeatLease !== lease || opening?.taskId !== taskId) return
                    // Another instance owns the lock now, so this opening must stop writing.
                    Logger.warn(`[Lock] Ownership lost for task ${taskId}`)
                    void this.clearTask({ expectedOpening: opening, closeReason: "lock_lost" }).catch((error) =>
                        Logger.error("[Lock] Failed to close lock-lost task:", error),
                    )
                })
                .catch((error) => Logger.warn(`[Lock] Heartbeat failed for task ${taskId}:`, error))
            this.lockHeartbeatPending = pending
            void pending.finally(() => {
                if (this.lockHeartbeatPending === pending) this.lockHeartbeatPending = undefined
            })
        }, 60000)
    }

    /** Stop the heartbeat for this task and drain an in-flight touch before the lock is released. */
    private async stopLockHeartbeat(taskId: string): Promise<void> {
        if (this.lockHeartbeatLease?.taskId !== taskId) return
        this.lockHeartbeatLease = undefined
        if (this.lockHeartbeatTimer) clearInterval(this.lockHeartbeatTimer)
        this.lockHeartbeatTimer = undefined
        await this.lockHeartbeatPending
    }

    private async releaseOwnedTaskLock(taskId: string): Promise<void> {
        const status = await this.lockService.checkTaskLock(taskId)
        if (status.isLocked && status.lockedBy === this.lockService.instanceAddress) {
            await this.lockService.releaseTaskLock(taskId)
        }
    }

    /**
     * Computes the current task lock status for the frontend.
     * Returns undefined when the lock is acquired (normal operation)
     * or when there is no active task.
     *
     * @returns TaskLockStatus if in read-only mode, undefined otherwise
     */
    private getTaskLockStatus(): TaskLockStatus | undefined {
        const historyLock = projectHistoryTaskLockStatus(this.historyDisplaySession)
        if (historyLock) return historyLock
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
    async runTaskLifecycleOperation<T>(
        operation: (scope: TaskLifecycleScope) => Promise<T>,
        options: TaskLifecycleOperationOptions = {},
    ): Promise<T> {
        return this.taskLifecycleMutex.withLock(async () => {
            // Writers still drain the previous task before taking ownership. A user
            // close may skip only this admission wait so its visible surface can detach.
            if (options.waitForPendingTeardown !== false) await this.pendingTaskTeardown
            return operation({
                clearTask: (options) => this.clearTaskWithinLifecycle(options),
            })
        })
    }

    /**
     * Replace one source-owned Task with an independent successor on the same surface.
     *
     * The successor opens the way a spawned task does, from the handed-over task
     * and context alone; nothing else of the source conversation travels with
     * it. Bound to the exact opening that asked for it: the same task closed and
     * reopened in between is a different opening and is left alone.
     */
    async startSuccessorTask(
        source: TaskOpening,
        handoff: Pick<NewTaskHandoff, "task" | "context" | "taskSettings" | "source">,
    ): Promise<string | undefined> {
        return this.runTaskLifecycleOperation(async (scope) => {
            if (!this.isCurrentOpening(source)) return undefined
            await scope.clearTask({ suppressPostState: true, closeReason: "handoff" })
            return this.initTask(handoff.task, undefined, undefined, undefined, handoff.taskSettings, {
                context: [handoff.context],
                startInBackground: true,
                skipInitialClear: true,
                handoffSource: { taskId: source.taskId, interactionId: handoff.source.dlineTid },
            })
        })
    }

    async clearTask(options?: TaskClearOptions) {
        return this.runTaskLifecycleOperation(
            (scope) => {
                if (options?.expectedOpening && !this.isCurrentOpening(options.expectedOpening)) return Promise.resolve()
                return scope.clearTask(options)
            },
            { waitForPendingTeardown: options?.closeReason !== "user_clear" },
        )
    }

    private isCurrentOpening(opening: TaskOpening): boolean {
        const current = this.currentOpening()
        return current?.taskId === opening.taskId && current.taskInstanceId === opening.taskInstanceId
    }

    private async clearTaskWithinLifecycle(options?: TaskClearWithinLifecycleOptions) {
        const startedAt = performance.now()
        let stageStartedAt = startedAt
        const task = this.task
        const historyDisplay = this.historyDisplaySession
        const taskId = task?.taskId ?? historyDisplay?.taskId
        // An unlocked history display holds the task lock without an interactive session.
        const holdsLock = this.taskLockAcquired
        const closeReason = options?.closeReason ?? "unknown"
        const logCloseStage = (phase: string, details = "") => {
            const now = performance.now()
            recordPerfPhase(
                PerfDomain.ControllerClose,
                "stage",
                now - stageStartedAt,
                {
                    stage: phase,
                    elapsedMs: Math.round(now - startedAt),
                    closeReason,
                    hadTask: task !== undefined,
                    heldLock: holdsLock,
                    deferredTeardown: options?.deferTeardown === true,
                    preserveCompletedState: options?.preserveCompletedState === true,
                },
                { taskId },
            )
            if (Logger.isDebugEnabled()) {
                Logger.debug(
                    `[ControllerClosePerf] phase=${phase} closeReason=${closeReason} taskId=${taskId ?? "none"} durationMs=${Math.round(now - stageStartedAt)} elapsedMs=${Math.round(now - startedAt)}${details ? ` ${details}` : ""}`,
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
            this.stateManager.setGlobalState("mode", task.owners.settings.mode)
        }
        // Detach the surface before any durable teardown runs. The Webview decides
        // between the task view and the recent-tasks view purely from `this.task`,
        // so releasing the reference here is what returns the user to Recent; every
        // remaining step is durability work that no longer has a visible effect.
        task?.beginClose()
        task?.owners.prompt.beginDispose()
        this.task = undefined
        this.historyDisplaySession = undefined
        // A poll round must not take over a task this surface no longer shows.
        this.stopLockPoll()
        this.workspaceHistorySession = undefined
        this.restartAccountUsagePolling()
        if (!options?.suppressPostState) {
            await this.postStateToWebview({ immediate: true })
            logCloseStage("detached_state_publish")
        }

        const previousTeardown = this.pendingTaskTeardown
        const releaseDetached = async () => {
            await Promise.all([
                historyDisplay?.dispose(),
                task || holdsLock
                    ? this.teardownDetachedTask(
                          task,
                          taskId,
                          options?.preserveCompletedState === true,
                          logCloseStage,
                          options?.checkpointRestoreFence,
                      )
                    : undefined,
            ])
        }
        const teardown = previousTeardown
            ? previousTeardown.then(releaseDetached, async (previousError) => {
                  try {
                      await releaseDetached()
                  } catch (currentError) {
                      throw new AggregateError([previousError, currentError], "Multiple task teardowns failed")
                  }
                  throw previousError
              })
            : releaseDetached()
        const pending = teardown.then(() => {
            if (this.pendingTaskTeardown === pending) this.pendingTaskTeardown = undefined
        })
        this.pendingTaskTeardown = pending
        // Keep a rejected drain as the next lifecycle operation's admission barrier.
        // The close surface may already have returned, but failure cannot authorize a new writer.
        void pending.catch(() => undefined)
        if (options?.deferTeardown) {
            logCloseStage("teardown_deferred")
            return
        }
        await pending
        logCloseStage("complete", `suppressPostState=${options?.suppressPostState === true}`)
    }

    /**
     * Release every durable resource owned by a Task that is already detached.
     *
     * Nothing here changes what the user sees, so it may run after the surface has
     * moved on. The close surface may have returned, but the next lifecycle operation
     * still awaits this drain. A failed drain retains the admission barrier rather
     * than silently admitting a replacement over unclosed resources.
     */
    private async teardownDetachedTask(
        task: ActiveTaskSession | undefined,
        taskId: string | undefined,
        preserveCompletedState: boolean,
        logCloseStage: (phase: string, details?: string) => void,
        checkpointRestoreFence?: CheckpointRestoreFence,
    ): Promise<void> {
        try {
            if (task) {
                // Clear task settings cache when task ends
                await this.stateManager.clearTaskSettings(taskId)
                logCloseStage("task_settings_clear")
                if (checkpointRestoreFence) await task.disposeAfterCheckpointRestore(checkpointRestoreFence)
                else await task.dispose(randomUUID())
                logCloseStage(
                    checkpointRestoreFence ? "task_checkpoint_release" : "task_terminate",
                    `preserveCompleted=${preserveCompletedState}`,
                )
            }
            if (!taskId) return
            // Stop the lock heartbeat only after dispose() completes, so a task that
            // is still flushing keeps its lock until its stores are closed.
            await this.stopLockHeartbeat(taskId)
            this.taskLockAcquired = false
            // Release file lock so other instances can open the task. Only a lock
            // this instance owns is released; a read-only opening holds none.
            await this.releaseOwnedTaskLock(taskId)
            logCloseStage("lock_release")
            const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
            const orchestrator = OrchestratorController.getInstance()
            if (orchestrator.getController(taskId) === this) {
                orchestrator.unregisterController(taskId)
                // Release file ownership in the global checkpoint registry
                const { WorkspaceFileRegistry } = await import("@integrations/checkpoints/WorkspaceFileRegistry")
                WorkspaceFileRegistry.getInstance().releaseTask(taskId)
            }
        } catch (error) {
            Logger.error(`[Controller] Task teardown failed for ${taskId ?? "none"}:`, error)
            // A failed drain stays the next lifecycle operation's admission barrier:
            // neither a checkpoint reopen nor a new opening may become a second
            // writer over stores or a task lock that were not released.
            throw error
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

/** The running task's figure, or the one a stopped task last showed while only its history is open. */
function shownContextWindowIndicator(
    task: ActiveTaskSession | undefined,
    historyDisplay: HistoryDisplaySession | undefined,
): ContextWindowIndicatorSnapshot | undefined {
    return task?.owners.toolState.contextWindowIndicator ?? historyDisplay?.getContextWindowIndicator()
}
