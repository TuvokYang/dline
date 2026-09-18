import { ApiHandler, ApiProviderInfo, buildApiHandlerFromProfile, resolveProviderFromProfile } from "@core/api"
import { recordProviderAdapterInput, recordProviderAdapterOutput } from "@core/api/debug/api-conversation-log"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import { createIdentityFactory } from "@core/api/transform/block-identity"
import { ApiStream } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { AssistantMessageContent, parseAssistantMessageV2, TextStreamContent, ToolUse } from "@core/assistant-message"
import { ContextManager } from "@core/context/context-management/ContextManager"
import {
	type CanonicalMessageRange,
	projectCompactionContext,
	readCompletedCompactionCards,
} from "@core/context/context-management/compaction-context-projection"
import { createCompactionConversationRange } from "@core/context/context-management/compaction-conversation-range"
import {
	type CompactionProviderDiagnosticSnapshot,
	createCompactionProviderDiagnosticSnapshot,
	findCompactionProviderFirstDivergence,
	hashCompactionDiagnosticValue,
	isCompactionDevDiagnosticsEnabled,
} from "@core/context/context-management/compaction-dev-diagnostics"
import { CompactionPassBudgetError } from "@core/context/context-management/compaction-pass-budget-error"
import { elapsedCompactionMs } from "@core/context/context-management/compaction-phase-timing"
import { CompactionRetryPolicy } from "@core/context/context-management/compaction-retry-policy"
import { isDeterministicToolPairingError } from "@core/context/context-management/compaction-retryability"
import { resolveCompactionWindowBudget } from "@core/context/context-management/compaction-window-budget"
import { projectContextCompactionBoundary } from "@core/context/context-management/context-compaction-boundary"
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling"
import {
	collectContextWindowRequestPressures,
	getContextTokens,
	getLatestReliableContextWindowTokens,
	readContextTokens,
	resolveOccupiedContextWindowTokens,
} from "@core/context/context-management/context-pressure"
import {
	type ContextWindowProjection,
	estimateContextWindowCandidate,
	resolveContextWindowProjection,
} from "@core/context/context-management/context-window-projection"
import {
	COMPACTION_CLOSURE_RESERVE_TOKENS,
	type CompactTriggerOptions,
	computeCompactTrigger,
	computeSummarizeBudget,
	getContextWindowInfo,
	MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
	resolveCompactTriggerPolicy,
	shouldCompactProjectedUsage,
} from "@core/context/context-management/context-window-utils"
import {
	getCompactionUserText,
	hasManualCompactionIntent,
	projectCompactionRequestContent,
	projectCompletedCompactionResult,
	shouldContinueCompactionFitting,
	shouldRestoreDeferredTurn,
} from "@core/context/context-management/current-turn-compaction"
import { buildSummaryRefitGuidance } from "@core/context/context-management/summary-refit"
import { decideTargetWindowFitting } from "@core/context/context-management/TargetWindowFittingService"
import {
	areCompactionPassIdentitiesEqual,
	buildCompactionPassHistory,
	buildTargetCandidateHistory,
	getCompactionPassIdentity,
	type TargetWindowFittingState,
} from "@core/context/context-management/target-window-fitting"
import { EnvironmentContextTracker } from "@core/context/context-tracking/EnvironmentContextTracker"
import { FileContextTracker, type RecentlyModifiedFilesSnapshot } from "@core/context/context-tracking/FileContextTracker"
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"
import {
	getGlobalClineRules,
	getLocalClineRules,
	refreshClineRulesToggles,
} from "@core/context/instructions/user-instructions/agent-rules"
import {
	getLocalAgentsRules,
	getLocalCursorRules,
	getLocalWindsurfRules,
	refreshExternalRulesToggles,
} from "@core/context/instructions/user-instructions/external-rules"
import { findEnabledProfileByName } from "@core/controller/file/getApiProfiles"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import * as NotificationHook from "@core/hooks/notification-hook"
import { executePreCompactHookWithCleanup, HookCancellationError, HookExecution } from "@core/hooks/precompact-executor"
import { IgnoreController } from "@core/ignore/IgnoreController"
import { resolveAvailableImageModelId } from "@core/image-generation/runtime"
import { parseMentions } from "@core/mentions"
import { CommandPermissionController } from "@core/permissions"
import { summarizeTask } from "@core/prompts/contextManagement"
import { ToolPromptGenerator } from "@core/prompts/generators/ToolPromptGenerator"
import { getPrompt } from "@core/prompts/i18n"
import { PromptProfile } from "@core/prompts/profiles/types"
import { formatResponse } from "@core/prompts/responses"
import { type ResolvedPromptRuntime, resolveFrozenPromptRuntime } from "@core/prompts/system-prompt-cache/FrozenPromptRuntime"
import { parseSlashCommands } from "@core/slash-commands"
import {
	ensureRulesDirectoryExists,
	ensureTaskDirectoryExists,
	GlobalFileNames,
	getSkillsDirectoriesForScan,
	getSubagentsScanDirectories,
	getWorkflowsScanDirectories,
} from "@core/storage/disk"
import { TaskLegacyStorageCleaner } from "@core/storage/TaskLegacyStorageCleaner"
import type { FrozenSystemPromptCache, SystemPromptRefreshReason } from "@core/storage/task-context-types"
import { TaskActivityPersistence } from "@core/task/activity/TaskActivityPersistence"
import { TaskActivityStore } from "@core/task/activity/TaskActivityStore"
import { ensureApiMessages, ensureUserContent } from "@core/task/api-context"
import {
	ContextCompactionPresentation,
	type ContextCompactionPresentationSnapshot,
} from "@core/task/ContextCompactionPresentation"
import {
	type ContextCompactionPassReview,
	type ContextCompactionReprojection,
	ContextCompactionSession,
	type ContextCompactionSessionEvent,
	type ContextCompactionSessionInput,
	type ContextCompactionSessionResult,
	type ContextCompactionTransitionState,
} from "@core/task/ContextCompactionSession"
import { ContextWindowIndicator, isSameContextWindowIndicatorLineage } from "@core/task/ContextWindowIndicator"
import { ContextWindowReceivingTracker } from "@core/task/ContextWindowReceivingTracker"
import { type CompactionProviderInput, CompactionRequestReplay } from "@core/task/compaction/CompactionRequestReplay"
import { normalizeCompactionResponse } from "@core/task/compaction/CompactionResponseNormalizer"
import { getHighContextPressureWarning, showContextUsage } from "@core/task/environment-context"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ModeSwitchCompaction } from "@core/task/ModeSwitchCompaction"
import { projectModeSwitchContinuation } from "@core/task/mode-switch-continuation"
import { OrdinaryRequestInputReplay } from "@core/task/OrdinaryRequestInputReplay"
import { calculateApiRequestTiming } from "@core/task/performance/api-request-timing"
import { createRequestApiScope, type RequestApiScope, resolveRequestWebSearchRoutingPlan } from "@core/task/RequestApiScope"
import { TaskRequestUsageTracker } from "@core/task/TaskRequestUsageTracker"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { buildCheckpointManager, shouldUseMultiRoot } from "@integrations/checkpoints/factory"
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer"
import { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import { ICheckpointManager } from "@integrations/checkpoints/types"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { formatContentBlockToMarkdown } from "@integrations/misc/export-markdown"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import type {
	CommandCancellationResult,
	ITerminalManager,
	TerminalManagerConfiguration,
	TerminalManagerConfigurationResult,
} from "@integrations/terminal/types"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { listFiles } from "@services/glob/list-files"
import { McpHub } from "@services/mcp/McpHub"
import { ApiConfiguration, DEFAULT_API_PROVIDER } from "@shared/api"
import { findLast, findLastIndex } from "@shared/array"
import type { ChatContent } from "@shared/ChatContent"
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import {
	type ContextWindowIndicatorLineage,
	type ContextWindowIndicatorSnapshot,
	getContextWindowIndicatorTotalTokens,
} from "@shared/context-window-indicator"
import {
	ClineApiReqCancelReason,
	ClineApiReqInfo,
	ClineAsk,
	ClineMessage,
	ClineSay,
	type ClineSayTool,
	type CommandStatus,
} from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages"
import { USER_CONTENT_TAGS } from "@shared/messages/constants"
import type { PromptCacheHealthSnapshot } from "@shared/PromptCacheHealth"
import type { PromptFreshnessSnapshot } from "@shared/PromptFreshness"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { bindProviderAttemptScope } from "@shared/provider-attempt-observer"
import { PROFILE_PROVIDER_KEYS } from "@shared/providers/profile-model-info"
import { resolvePromptProfile } from "@shared/resolve-prompt-profile"
import type { Mode } from "@shared/storage/types"
import { DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS, DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS } from "@shared/terminal-settings"
import { ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES, READ_ONLY_TOOLS } from "@shared/tools"
import { ClineAskResponse } from "@shared/WebviewMessage"
import { isLocalModel, isNativeToolCallingConfig, isParallelToolCallingEnabled } from "@utils/model-utils"
import { arePathsEqual, getDesktopDir } from "@utils/path"
import { filterExistingFiles } from "@utils/tabFiltering"
import cloneDeep from "clone-deep"
import fs from "fs/promises"
import Mutex from "p-mutex"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { ulid } from "ulid"
import type { SystemPromptContext } from "@/core/prompts/system-prompt"
import {
	PromptFreshnessInvalidationCoordinator,
	type PromptFreshnessInvalidationSource,
} from "@/core/prompts/system-prompt-cache/PromptFreshnessInvalidationCoordinator"
import { SystemPromptCacheService } from "@/core/prompts/system-prompt-cache/SystemPromptCacheService"
import {
	getWorkspacePromptInputWatcherRegistry,
	type PromptInputWatcherSubscription,
} from "@/core/prompts/system-prompt-cache/WorkspacePromptInputWatcherRegistry"
import { HostProvider } from "@/hosts/host-provider"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import {
	type CommandExecutionOptions,
	type CommandExecutionOutcome,
	CommandExecutor,
	CommandExecutorCallbacks,
	FullCommandExecutorConfig,
	StandaloneTerminalManager,
} from "@/integrations/terminal"
import { ClineErrorType, ErrorService } from "@/services/error"
import { telemetryService } from "@/services/telemetry"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { ClineClient } from "@/shared/cline"
import {
	ClineAssistantContent,
	ClineAssistantToolUseBlock,
	ClineContent,
	ClineImageContentBlock,
	ClineMessageModelInfo,
	type ClineReasoningDetailParam,
	ClineStorageMessage,
	ClineTextContentBlock,
	ClineToolResponseContent,
	ClineUserContent,
	ClineUserToolResultContentBlock,
} from "@/shared/messages"
import { ShowMessageType } from "@/shared/proto/dline/host"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { Logger } from "@/shared/services/Logger"
import { Session } from "@/shared/services/Session"
import {
	createTaskCapabilityToggles,
	emptyTaskCapabilityToggles,
	parseTaskCapabilityToggles,
	reconcileTaskCapabilityToggles,
	serializeTaskCapabilityToggles,
	type TaskCapabilityToggles,
} from "@/shared/TaskCapabilityToggles"
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder"
import { ensureLocalClineDirExists } from "../context/instructions/user-instructions/rule-helpers"
import { discoverAvailableSkills } from "../context/instructions/user-instructions/skills"
import { refreshWorkflowToggles } from "../context/instructions/user-instructions/workflows"
import { Controller } from "../controller"
import { refreshSkills } from "../controller/file/refreshSkills"
import { refreshSubagents } from "../controller/file/refreshSubagents"
import { executeHook } from "../hooks/hook-executor"
import { OrchestratorController } from "../orchestrator/OrchestratorController"
import { StateManager } from "../storage/StateManager"
import {
	type ApiProfileValidity,
	createUnavailableApiHandler,
	resolveTaskApiProfile,
	resolveTaskApiProfileFresh,
	validateApiProfileCredentials,
} from "./ApiProfileRecovery"
import { buildActiveTasksSection } from "./active-tasks/ActiveTaskContextProvider"
import { isTurnEndingToolName, orderTurnEndingContentBlocks, orderTurnEndingNativeToolBlocks } from "./assistant-message-order"
import { getRetryDelay, getStreamRetryDecision, MAX_AUTO_RETRY_ATTEMPTS } from "./auto-retry"
import { BlockPhase } from "./BlockPhaseMachine"
import { buildTaskBackgroundEnvironmentSection, buildTaskBackgroundResults } from "./background/BackgroundContextInjector"
import {
	estimateContextWindowIndicatorSegments,
	projectAuthoritativeContextWindowIndicatorSegments,
} from "./ContextWindowIndicatorProjection"
import { detectAvailableCliTools } from "./cli-tool-detector"
import { buildMistakeLimitContinuationContent } from "./continuation/MistakeLimitContinuation"
import { ToolCommandLedger } from "./executors/tool/ToolCommandLedger"
import { createToolDomainRunner } from "./executors/tool/ToolDomainResources"
import type { UserFacingSurface } from "./executors/tool/ToolDomainSurface"
import { dispatchToolExecutionEffect } from "./executors/tool/ToolEffectDispatcher"
import { ToolExecutionDomain } from "./executors/tool/ToolExecutionDomain"
import { TurnDriver } from "./executors/tool/TurnDriver"
import { TurnToolScheduler } from "./executors/tool/TurnToolScheduler"
import { FocusChainManager } from "./focus-chain"
import { formatFocusChainTaskProgressSection } from "./focus-chain/file-utils"
import { HistoryResumeMaintenance } from "./history/HistoryResumeMaintenance"
import { TaskCompletionProjector } from "./history/TaskCompletionProjector"
import type { QueuedInputEntry } from "./input-queue/InputQueue"
import { InputQueueCoordinator } from "./input-queue/InputQueueCoordinator"
import type { QueueDelivery } from "./input-queue/InputQueueDelivery"
import type { InputQueueMutation, InputQueueMutationResult } from "./input-queue/InputQueueMutation"
import { hostedWebApprovalApiIndex, requestHostedWebApproval } from "./interaction/HostedWebApproval"
import type { InteractionKind } from "./interaction/Interaction"
import { isInteractionCancellationError } from "./interaction/InteractionCancellationError"
import { type DetachedInteractionContinuationContext, InteractionCoordinator } from "./interaction/InteractionCoordinator"
import { getInteraction } from "./interaction/InteractionRegistry"
import type { InteractionDraft } from "./interaction/InteractionResponse"
import {
	getPresentationCadenceMs,
	isPresentationSchedulingDisabled,
	isRemoteWorkspaceEnvironment,
	type TaskLatencyTrigger,
} from "./latency"
import { MessageChannel } from "./MessageChannel"
import { MessageStateHandler } from "./message-state"
import { deriveNewTaskFeedbackContinuation } from "./new-task/new-task-continuation"
import { buildNewTaskFeedbackContent, findLatestNewTaskFeedback } from "./new-task/new-task-feedback"
import { createNewTaskHandoff } from "./new-task/new-task-handoff"
import { TaskTurnTelemetry } from "./observability/task-turn-telemetry"
import type { ApiRateMetricsQuery, ApiRateMetricsQueryResult } from "./performance/api-rate-metrics-types"
import type { ApiRateSnapshot } from "./performance/api-rate-tracker"
import { ApiRequestRoundLifecycle } from "./performance/api-request-round-lifecycle"
import { TaskApiRequestRoundRepository } from "./performance/api-request-round-repository"
import { ApiRequestRoundTracker } from "./performance/api-request-round-tracker"
import { ApiResponseExecutionLifecycle } from "./performance/api-response-execution-lifecycle"
import { TaskApiResponseExecutionRepository } from "./performance/api-response-execution-repository"
import type { ApiResponseExecutionToolSummary } from "./performance/api-response-execution-types"
import type { ProviderRequestRoundAdmission, ProviderRequestRoundPort } from "./performance/provider-request-round-port"
import { TaskApiRateMetricsRepository } from "./performance/task-api-rate-metrics-repository"
import { isTaskRateMetricsLoopActive, TaskApiRateMetricsService } from "./performance/task-api-rate-metrics-service"
import { TaskRateMetricsQueryService } from "./performance/task-rate-metrics-query-service"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "./performance/task-rate-metrics-types"
import type { PresentationPriority } from "./presentation-types"
import { PromptCacheHealthTracker } from "./prompt-cache/PromptCacheHealthTracker"
import { RestoreHandler } from "./RestoreHandler"
import { ReasoningIndicator } from "./reasoning-indicator"
import { repairPersistedEncryptedReasoning } from "./reasoning-retention"
import { ResumeCoordinator } from "./resume/ResumeCoordinator"
import { type ResumeInput, selectResumeUiTail } from "./resume/ResumeInput"
import { projectResumeOrdinaryInput } from "./resume/ResumeInteractionContinuation"
import { createResumeContinuationText } from "./resume/ResumeProvenance"
import { collectResumeTurnContent } from "./resume/ResumeToolResult"
import type { SnapshotDurability } from "./runtime/TaskEffect"
import type { ProjectionEffectOrigin, TaskEffectPorts } from "./runtime/TaskEffectRunner"
import type { TaskEvent } from "./runtime/TaskEvent"
import { type TaskDispatchResult, TaskRuntime } from "./runtime/TaskRuntime"
import { TaskRuntimeProjectionScheduler } from "./runtime/TaskRuntimeProjectionScheduler"
import { createTaskRuntimeState, type TaskRuntimeState } from "./runtime/TaskRuntimeState"
import { StreamChunkCoordinator } from "./StreamChunkCoordinator"
import { StreamResponseHandler } from "./StreamResponseHandler"
import { shouldRunTaskCancelHook } from "./TaskCancelPolicy"
import { TaskController } from "./TaskController"
import { formatTaskPanelTitle } from "./TaskPanelTitle"
import { TaskPhase } from "./TaskPhase"
import { type PresentationFlushContext, TaskPresentationScheduler } from "./TaskPresentationScheduler"
import { createSnapshot, hydrateSnapshot, normalizeLegacyTaskSnapshot, type TaskSnapshot } from "./TaskSnapshot"
import { renameTaskSnapshotWithRetry, TaskSnapshotPersistence } from "./TaskSnapshotPersistence"
import { TaskState } from "./TaskState"
import { TaskStateManager } from "./TaskStateManager"
import { withTerminateTimeout } from "./TaskTerminateTimeout"
import { ToolExecutor } from "./ToolExecutor"
import { getAdvertisedNativeToolNames } from "./tools/NativeToolAdmission"
import { updateApiReqMsg } from "./utils"
import { buildUserFeedbackContent } from "./utils/buildUserFeedbackContent"
import { processUserContentTags } from "./utils/processUserContentTags"

export type ToolResponse = ClineToolResponseContent

type TaskParams = {
	controller: Controller
	mcpHub: McpHub
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	persistTaskCompletionState: (taskId: string, isCompleted: boolean, revision: number) => Promise<boolean>
	publishTaskHistoryClose: () => void
	postStateToWebview: (options?: { immediate?: boolean }) => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	cancelTask: () => Promise<void>
	shellIntegrationTimeout: number
	terminalReuseEnabled: boolean
	terminalOutputLineLimit: number
	defaultTerminalProfile: string
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	cwd: string
	/** Workspace-level exclusion rules owned by the Controller. */
	ignoreController: IgnoreController
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	task?: string
	images?: string[]
	files?: string[]
	historyItem?: HistoryItem
	taskId: string
	uiMessage?: import("../storage/UIMessage").UIMessage
	apiConversation?: import("../storage/ApiConversation").ApiConversation
}

type ResumeTaskFromHistoryOptions = {
	onReadyToDisplay?: () => Promise<void>
	isCurrent?: () => boolean
}

type AskOptions = {
	onAskVisible?: (askTs: number) => Promise<void> | void
	/** If provided, update the existing ask message with this ts instead of creating a new partial */
	existingTs?: number
	/** Called when a new partial ask message is created with a new ts */
	onTsCreated?: (ts: number) => void
	/** ts of the associated command message (for command_output) */
	commandTs?: number
}

type ApiRequestTransactionOptions = {
	/** Runs after the user message is durable and before canonical API admission. */
	beforeApiRequestStarted?: () => Promise<void>
	/** Reuse accounting already recorded by an interrupted pre-request gate. */
	reuseRequestAccounting?: boolean
	/** Reuse one fully processed user message already durable at this history index. */
	persistedRequestApiIndex?: number
	/** Preserve the runtime request identity when compaction changes physical history indices. */
	logicalApiIndex?: number
	/** Enter compaction after the complete unsent ordinary candidate crosses the final guard. */
	forceCompaction?: boolean
}

/**
 * Grant a task's own UI capability to its tool domain.
 *
 * The main task is the one assembly that legitimately reaches the user, so the
 * grant is a thin delegation to the members that already own presentation. A
 * subagent is assembled with a denied surface instead, which removes the
 * capability by type rather than by overriding individual callbacks.
 */
function createTaskUserFacingSurface(task: Task): UserFacingSurface {
	return {
		kind: "user_facing",
		ask: (type, payload, partial) => task.ask(type as ClineAsk, payload, partial),
		say: async (type, payload, partial) => {
			await task.say(type as ClineSay, payload, undefined, undefined, partial)
		},
		openInteraction: (request) => task.ask((request as { type: ClineAsk }).type, undefined, false),
		diff: () => task.getDiffSurface(),
	}
}

/** Fail fast if dormant runtime effects are dispatched before flow migration. */
function unavailableRuntimePort(port: keyof TaskEffectPorts): never {
	throw new Error(`Task runtime effect port is not active before flow migration: ${port}`)
}

/** Create explicit runtime infrastructure ports for the migrated task transactions. */
function createInteractionPorts(
	postView: TaskEffectPorts["postView"],
	persistSnapshot: TaskEffectPorts["persistSnapshot"],
	cancelRuntime: TaskEffectPorts["cancelRuntime"],
	prepareResume: TaskEffectPorts["prepareResume"],
	startApi: TaskEffectPorts["startApi"],
	executeTool: TaskEffectPorts["executeTool"],
	appendSay: TaskEffectPorts["appendSay"],
	appendAsk: TaskEffectPorts["appendAsk"],
	startNewTask: TaskEffectPorts["startNewTask"],
	startSuccessorTask: NonNullable<TaskEffectPorts["startSuccessorTask"]>,
): TaskEffectPorts {
	return {
		postView,
		persistSnapshot,
		cancelRuntime,
		prepareResume,
		startApi,
		executeTool,
		appendSay,
		appendAsk,
		startNewTask,
		startSuccessorTask,
	}
}

/**
 * What a task knew about itself when a response arrived with no ask listening.
 *
 * The conversation position and runtime phase are the two facts that separate
 * a response racing an ask that had not finished opening its window from input
 * typed while the task was simply working. Without them the log names only the
 * symptom and leaves the mismatch to be inferred from surrounding timestamps.
 */
export interface UnroutedAskResponseContext {
	taskId: string
	response: ClineAskResponse
	text?: string
	images?: string[]
	files?: string[]
	/** Conversation length, or -1 when the task could not report one. */
	messageCount: number
	phase: string
}

/**
 * Renders the diagnostic for a response that no ask was listening for.
 *
 * Kept free of task state so it stays callable from the anomalous path and
 * from tests without standing up a task.
 */
export function formatUnroutedAskResponse(context: UnroutedAskResponseContext): string {
	return (
		`[Task ${context.taskId}] Ask response arrived while no ask was listening; refused: ` +
		`response=${context.response}, hasText=${Boolean(context.text)}, images=${context.images?.length ?? 0}, ` +
		`files=${context.files?.length ?? 0}, messages=${context.messageCount}, phase=${context.phase}`
	)
}

export class Task {
	// Core task variables
	readonly taskId: string
	readonly ulid: string
	private readonly taskTelemetry: TaskTurnTelemetry
	/** Task text captured at construction; used before the "task" message exists. */
	private readonly initialTaskTitle?: string
	private taskIsFavorited?: boolean
	private cwd: string
	private taskInitializationStartTime: number

	taskState: TaskState
	taskController: TaskController
	private taskRuntime: TaskRuntime
	private readonly completionProjector: TaskCompletionProjector
	private interactionCoordinator: InteractionCoordinator
	private resumeCoordinator: ResumeCoordinator
	private readonly historyResumeMaintenance: HistoryResumeMaintenance
	private historyPreparationPending = false
	private controllerDetached = false
	private readonly restoredFromHistory: boolean
	private latestOrdinaryCompactionDiagnostic?: CompactionProviderDiagnosticSnapshot

	// ONE mutex for ALL state modifications to prevent race conditions
	private stateMutex = new Mutex()

	/**
	 * Execute function with exclusive lock on all task state
	 * Use this for ANY state modification to prevent races
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	/**
	 * Atomically set active hook execution with mutex protection
	 * Prevents TOCTOU races when setting hook execution state
	 * PUBLIC: Exposed for ToolExecutor to use
	 */
	public async setActiveHookExecution(hookExecution: NonNullable<typeof this.taskState.activeHookExecution>): Promise<void> {
		await this.withStateLock(() => {
			this.taskState.activeHookExecution = hookExecution
		})
	}

	/**
	 * Atomically clear active hook execution with mutex protection
	 * Prevents TOCTOU races when clearing hook execution state
	 * PUBLIC: Exposed for ToolExecutor to use
	 */
	public async clearActiveHookExecution(): Promise<void> {
		await this.withStateLock(() => {
			this.taskState.activeHookExecution = undefined
		})
	}

	/**
	 * Atomically read active hook execution state with mutex protection
	 * Returns a snapshot of the current state to prevent TOCTOU races
	 * PUBLIC: Exposed for ToolExecutor to use
	 */
	public async getActiveHookExecution(): Promise<typeof this.taskState.activeHookExecution> {
		return await this.withStateLock(() => {
			return this.taskState.activeHookExecution
		})
	}

	// Core dependencies
	private controller: Controller
	private mcpHub: McpHub
	private _mcpNotificationCb?: (serverName: string, level: string, message: string) => Promise<void>

	// Service handlers
	api: ApiHandler
	terminalManager: ITerminalManager
	private urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	contextManager: ContextManager
	private readonly modeSwitchCompaction = new ModeSwitchCompaction()
	private readonly contextCompactionSession: ContextCompactionSession
	private taskHeaderCompactionSettlement?: Promise<void>
	private readonly contextCompactionPresentation = new ContextCompactionPresentation()
	private readonly taskLegacyStorageCleaner = new TaskLegacyStorageCleaner()
	private readonly contextWindowIndicator: ContextWindowIndicator
	private contextWindowEnvironmentRefreshTimer?: ReturnType<typeof setInterval>
	private contextWindowEnvironmentRefreshInFlight = false
	private readonly contextCompactionFailureReasons = new Map<string, string>()
	private readonly contextCompactionRetryProgress = new Map<string, { retryAttempt: number; maxRetryAttempts: number }>()
	private diffViewProvider: DiffViewProvider
	public checkpointManager?: ICheckpointManager
	private initialCheckpointCommitPromise?: Promise<string | undefined>
	/**
	 * Serializes only checkpoint-hash writes that have already entered the message
	 * store boundary. Baseline Git work may outlive the Task, but terminate marks the
	 * Task aborted first and waits this chain before closing the store.
	 */
	private checkpointHashPersistenceChain: Promise<void> = Promise.resolve()
	private ignoreController: IgnoreController
	private commandPermissionController: CommandPermissionController
	private toolExecutor: ToolExecutor
	readonly activityStore: TaskActivityStore
	/**
	 * Whether the task is using native tool calls.
	 * This is used to determine how we would format response.
	 * Example: We don't add noToolsUsed response when native tool call is used
	 * because of the expected format from the tool calls is different.
	 */
	private useNativeToolCalls = false
	private streamHandler: StreamResponseHandler
	private readonly identityFactory = createIdentityFactory()
	private readonly explicitInstructionRegistry = new ExplicitInstructionRegistry()
	private readonly compactionRequestReplay = new CompactionRequestReplay()
	private readonly compactionRetryPolicy = new CompactionRetryPolicy(MAX_AUTO_RETRY_ATTEMPTS)

	private terminalExecutionMode: "vscodeTerminal" | "backgroundExec"

	// Metadata tracking
	private fileContextTracker: FileContextTracker
	private taskFileTracker: TaskFileTracker
	private modelContextTracker: ModelContextTracker
	private environmentContextTracker: EnvironmentContextTracker

	// Focus Chain
	private FocusChainManager?: FocusChainManager

	// Callbacks
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private postStateToWebview: (options?: { immediate?: boolean }) => Promise<void>
	private reinitExistingTaskFromId: (taskId: string) => Promise<void>
	private cancelTask: () => Promise<void>

	// Cache service
	private stateManager: StateManager
	public taskSm: TaskStateManager

	// Message and conversation state
	messageStateHandler: MessageStateHandler

	// Workspace manager
	workspaceManager?: WorkspaceRootManager

	// Command executor for running shell commands (extracted from executeCommandTool)
	private commandExecutor!: CommandExecutor
	private isRemoteWorkspaceEnvironment = false
	private remoteWorkspaceDetectionSettled = false
	private readonly remoteWorkspaceDetectionPromise: Promise<void>
	private readonly presentationScheduler: TaskPresentationScheduler
	private pendingReasoningText?: string
	private readonly snapshotPersistence: TaskSnapshotPersistence
	private readonly projectionScheduler: TaskRuntimeProjectionScheduler
	/**
	 * The tool execution domain and the ledger that correlates its events.
	 *
	 * The domain reports every outcome as an event, while the EXECUTE_TOOL port
	 * must still settle when the block finishes, so the ledger bridges the two
	 * without letting the domain learn that anyone is waiting on it.
	 */
	private readonly toolDomainLedger = new ToolCommandLedger()
	private toolDomain?: ToolExecutionDomain
	private readonly turnToolScheduler = new TurnToolScheduler({
		readConfiguredLimit: () => this.stateManager.getGlobalSettingsKey("maxParallelToolCalls"),
		isParallelToolCallingEnabled: () => this.isParallelToolCallingEnabled(),
		onBlockCancelled: async (dlineTid) => {
			this.toolExecutor?.discardPreparedAdmission(dlineTid)
			const turnId = this.taskRuntime.getState().turn?.turnId
			if (turnId) await this.dispatchRuntime({ type: "BLOCK_EXECUTION_CANCELLED", turnId, dlineTid })
		},
		onBlockSkipped: async (dlineTid) => {
			this.toolExecutor?.discardPreparedAdmission(dlineTid)
			const turnId = this.taskRuntime.getState().turn?.turnId
			if (turnId) await this.dispatchRuntime({ type: "BLOCK_EXECUTION_SKIPPED", turnId, dlineTid })
		},
	})
	private readonly turnDriver = new TurnDriver({
		task: {
			getTaskId: () => this.taskId,
			isAborted: () => this.taskState.abort,
			isCurrentTask: () => this.controller.task?.taskId === this.taskId,
			getAssistantMessageContent: () => this.taskState.assistantMessageContent,
			getAssistantApiIndex: () => this.messageStateHandler.apiConversationHistory.length - 1,
			buildTurn: (assistantApiIndex, autoApprove) => {
				this.taskController.buildTurn(
					this.taskState.assistantMessageContent.map((block) => ({
						...block,
						conversationHistoryIndex: assistantApiIndex,
					})),
					autoApprove,
				)
				return this.taskController.getBlocks()
			},
			isParallelToolCallingEnabled: () => this.isParallelToolCallingEnabled(),
			getPendingUserMessageContent: () => this.taskState.userMessageContent,
			markPartialToolComplete: (ts) => this.taskState.partialToolLifecycleByTs.set(ts, "complete-done"),
			recordToolCall: (functionId, toolName) => Session.get().updateToolCall(functionId, toolName),
			markUserMessageContentReady: () => {
				this.taskState.userMessageContentReady = true
			},
			applyCompactionFit: (input) => {
				if (
					this.taskState.currentlySummarizing &&
					this.taskState.isInternalContextCompactionRequest &&
					!this.taskState.targetWindowFittingState
				) {
					this.taskState.compactionFittingRequired = shouldContinueCompactionFitting(input)
				}
			},
		},
		runtime: {
			getState: () => this.taskRuntime.getState(),
			dispatch: (event) => this.dispatchRuntime(event),
		},
		block: {
			prepareAdmission: (tool) => this.toolExecutor.prepareAdmission(tool),
			commitInterruptedResult: (tool, reason) => this.toolExecutor.commitInterruptedToolResult(tool, reason),
			awaitInitialCheckpoint: (toolName) => this.awaitInitialCheckpointBeforeToolSideEffects(toolName),
		},
		approval: {
			request: async (tool, presentation) => {
				const kind = this.getApprovalInteractionKind(presentation.ask)
				const state = this.taskRuntime.getState()
				if (!kind || !state.turn || !tool.dline_tid) {
					throw new Error(`Approval presentation cannot be mapped to a canonical interaction: tool=${tool.name}`)
				}
				const outcome = await this.interactionCoordinator.open({
					turnId: state.turn.turnId,
					interactionId: tool.dline_tid,
					kind,
					presentation: presentation.body,
					existingTs: tool.ts,
				})
				this.toolExecutor.recordAdmissionOutcome(tool, outcome)
				return outcome
			},
		},
		scheduler: this.turnToolScheduler,
		provider: {
			registerExecution: (admission, registration) => {
				this.activeProviderExecutionTurns.set(admission, registration)
				for (const interactionId of registration.turnEndInteractionIds) {
					this.turnEndProviderExecutions.set(interactionId, {
						turnId: registration.turnId,
						toolCount: registration.toolCount,
						admission,
					})
				}
			},
		},
		postCommit: {
			takeDirective: (dlineTid) => this.toolExecutor.takePostCommitDirective(dlineTid),
			startSuccessor: async (directive) => {
				const approvedSource = { functionId: directive.functionId, dlineTid: directive.dlineTid }
				const feedback = findLatestNewTaskFeedback({
					apiHistory: this.messageStateHandler.apiConversationHistory,
					uiHistory: this.messageStateHandler.clineMessages,
					approvedSource,
				})
				const initialUserContent = await buildNewTaskFeedbackContent(feedback)
				const successor = await this.taskRuntime.dispatchAtAdmission({
					type: "TASK_SUCCESSOR_REQUESTED",
					handoff: createNewTaskHandoff(directive, this.taskSm, initialUserContent),
				})
				if (!successor.accepted) {
					throw new Error(`Task successor rejected: ${successor.error?.code ?? "invalid_runtime_event"}`)
				}
			},
		},
	})
	private readonly systemPromptCacheService: SystemPromptCacheService
	private readonly promptFreshnessInvalidationCoordinator: PromptFreshnessInvalidationCoordinator
	private promptInputWatcherSubscription?: PromptInputWatcherSubscription
	private promptInputFileWatcherInitialization?: Promise<void>
	private promptFreshnessDisposed = false
	private latestTaskSnapshot?: TaskSnapshot
	/**
	 * Retained user input awaiting delivery; owned by the user, not the runtime.
	 *
	 * The queue, its serializer, its persistence bookkeeping and its in-flight
	 * batch are one state machine, so they live together rather than as
	 * separate fields here. The task supplies only what the coordinator cannot
	 * do itself: writing snapshots, publishing the projection, and handing a
	 * batch to the turn or the round it belongs to.
	 */
	private readonly inputQueueCoordinator = new InputQueueCoordinator({
		persistQueue: () => this.persistInputQueue(),
		publishProjection: () => this.postStateToWebview(),
		answerTurnEnd: (delivery) => this.answerTurnEndWithQueuedInput(delivery),
		stageToolRoundInput: (delivery) => this.stageToolRoundQueuedInput(delivery),
		presentDeliveredInput: (delivery) => this.presentDeliveredQueuedInput(delivery),
	})
	/**
	 * The durable turn-end interaction currently waiting for an answer.
	 *
	 * Recorded when the waiter is installed so a queue delivery, which is
	 * driven by the coordinator rather than by this call site, knows which
	 * interaction it would be answering.
	 */
	private awaitingQueuedInputInteraction?: { turnId: string; interactionId: string }
	private pendingSystemPromptRefreshReason?: SystemPromptRefreshReason
	/** Execution projection belonging to the current Provider response; prompt rebuilding never reads this field. */
	private activeProviderInputRuntime?: ResolvedPromptRuntime
	private readonly promptCacheHealth: PromptCacheHealthTracker
	private readonly apiRateMetricsService: TaskApiRateMetricsService
	private readonly apiRequestRoundLifecycle: ApiRequestRoundLifecycle
	private readonly taskRateMetricsQueryService: TaskRateMetricsQueryService
	private readonly ordinaryProviderRequestRounds = new Map<number, ProviderRequestRoundAdmission>()
	private readonly activeProviderExecutionTurns = new Map<
		ProviderRequestRoundAdmission,
		{ turnId: string; toolCount: number; turnEndInteractionIds: readonly string[] }
	>()
	private readonly turnEndProviderExecutions = new Map<
		string,
		{ turnId: string; toolCount: number; admission: ProviderRequestRoundAdmission }
	>()
	private nextAuxiliaryProviderRoundApiIndex = 0
	private apiRateMetricsInitialization?: Promise<void>
	private pendingBackgroundResultIds?: { subagentIds: string[]; commandIds: string[] }
	private pendingBackgroundCommandLineCounts?: Array<{ id: string; lineCount: number }>
	private pendingRecentlyModifiedFilesSnapshot?: RecentlyModifiedFilesSnapshot
	private readonly ordinaryRequestInputReplay = new OrdinaryRequestInputReplay()
	private readonly ordinaryContextIndicatorLineageByApiIndex = new Map<number, ContextWindowIndicatorLineage>()
	private readonly ordinaryContextIndicatorReceivingByApiIndex = new Map<number, ContextWindowReceivingTracker>()
	private readonly contextCompactionIndicatorReceivingByAttemptId = new Map<string, ContextWindowReceivingTracker>()
	/** One cancellable automatic-retry wait, exposed to the Webview Retry action. */
	private pendingAutoRetry?: {
		settle: (allowed: boolean, publish?: boolean) => void
	}
	/** Remains true across the timer and every request in one automatic retry sequence. */
	private autoRetrySequenceActive = false
	/** Stops automatic scheduling after the user takes ownership through Retry. */
	private manualRetryTakeoverActive = false
	private readonly presentationSchedulingDisabled = isPresentationSchedulingDisabled()
	restoreHandler!: RestoreHandler

	constructor(params: TaskParams) {
		const {
			controller,
			mcpHub,
			updateTaskHistory,
			persistTaskCompletionState,
			publishTaskHistoryClose,
			postStateToWebview,
			reinitExistingTaskFromId,
			cancelTask,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			terminalOutputLineLimit,
			defaultTerminalProfile,
			vscodeTerminalExecutionMode,
			cwd,
			ignoreController,
			stateManager,
			workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			uiMessage,
			apiConversation,
		} = params

		this.taskInitializationStartTime = performance.now()
		this.restoredFromHistory = historyItem !== undefined
		this.taskState = new TaskState()
		this.remoteWorkspaceDetectionPromise = HostProvider.env
			.getHostVersion({})
			.then((hostVersion) => {
				this.isRemoteWorkspaceEnvironment = isRemoteWorkspaceEnvironment(hostVersion)
			})
			.catch((error: unknown) => {
				Logger.warn(`[Task ${taskId}] Failed to detect remote workspace state: ${String(error)}`)
			})
			.finally(() => {
				this.remoteWorkspaceDetectionSettled = true
			})
		this.controller = controller
		this.mcpHub = mcpHub
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = async (options) => {
			if (this.controllerDetached) return
			await postStateToWebview(options)
		}
		this.apiRateMetricsService = new TaskApiRateMetricsService({
			repository: new TaskApiRateMetricsRepository({ taskId }),
			taskId,
			onChanged: () => {
				void this.postStateToWebview().catch((error) => {
					Logger.debug(`[Task ${this.taskId}] Failed to publish API rate metrics: ${error}`)
				})
			},
		})
		const apiRequestRoundRepository = new TaskApiRequestRoundRepository({
			taskId,
			legacySource: historyItem ? uiMessage : undefined,
		})
		const apiResponseExecutionRepository = new TaskApiResponseExecutionRepository({ taskId })
		const apiResponseExecutionLifecycle = new ApiResponseExecutionLifecycle({
			taskId,
			repository: apiResponseExecutionRepository,
			onChanged: () => {
				void this.postStateToWebview().catch((error) => {
					Logger.debug(`[Task ${this.taskId}] Failed to publish API response execution metrics: ${error}`)
				})
			},
		})
		this.apiRequestRoundLifecycle = new ApiRequestRoundLifecycle(
			new ApiRequestRoundTracker({
				taskId,
				repository: apiRequestRoundRepository,
				onChanged: () => {
					void this.postStateToWebview().catch((error) => {
						Logger.debug(`[Task ${this.taskId}] Failed to publish API request round metrics: ${error}`)
					})
				},
			}),
			apiResponseExecutionLifecycle,
		)
		this.taskRateMetricsQueryService = new TaskRateMetricsQueryService({
			activeMetrics: this.apiRateMetricsService,
			roundRepository: apiRequestRoundRepository,
			executionRepository: apiResponseExecutionRepository,
			waitForRoundPersistence: () => this.apiRequestRoundLifecycle.waitForRoundPersistence(),
			waitForExecutionPersistence: () => this.apiRequestRoundLifecycle.waitForExecutionPersistence(),
			isExecutionDegraded: () => this.apiRequestRoundLifecycle.getExecutionSnapshot().degraded,
			taskId,
		})
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		// Workspace-scoped and owned by the Controller: a Task must not create or
		// dispose these rules, or sibling Tasks would each rebuild the same watchers.
		this.ignoreController = ignoreController
		this.commandPermissionController = new CommandPermissionController()
		// Determine terminal execution mode and create appropriate terminal manager
		this.terminalExecutionMode = vscodeTerminalExecutionMode || "vscodeTerminal"

		const windowsProcessTreeProvider = HostProvider.get().windowsProcessTreeProvider
		// When backgroundExec mode is selected, use StandaloneTerminalManager for hidden execution
		// Otherwise, use the HostProvider's terminal manager (VSCode terminal in VSCode, standalone in CLI)
		if (this.terminalExecutionMode === "backgroundExec") {
			// Import StandaloneTerminalManager for background execution
			this.terminalManager = new StandaloneTerminalManager(windowsProcessTreeProvider)
			Logger.info(`[Task ${taskId}] Using StandaloneTerminalManager for backgroundExec mode`)
		} else {
			// Use the host-provided terminal manager (VSCode terminal in VSCode environment)
			this.terminalManager = HostProvider.get().createTerminalManager()
			Logger.info(`[Task ${taskId}] Using HostProvider terminal manager for vscodeTerminal mode`)
		}
		const terminalConfiguration: TerminalManagerConfiguration = {
			shellIntegrationTimeout,
			terminalReuseEnabled: terminalReuseEnabled ?? true,
			terminalOutputLineLimit,
			defaultTerminalProfile,
		}

		this.urlContentFetcher = new UrlContentFetcher()
		this.browserSession = new BrowserSession(stateManager)
		this.contextManager = new ContextManager()
		this.streamHandler = new StreamResponseHandler(() => this.genMessageTs())
		this.cwd = cwd
		this.stateManager = stateManager
		this.taskSm = new TaskStateManager(taskId, stateManager)
		this.workspaceManager = workspaceManager

		// DiffViewProvider opens Diff Editor during edits while FileEditProvider performs
		// edits in the background without stealing user's editor's focus.
		const backgroundEditEnabled = this.stateManager.getGlobalSettingsKey("backgroundEditEnabled")
		this.diffViewProvider = backgroundEditEnabled ? new FileEditProvider() : HostProvider.get().createDiffViewProvider()

		this.taskId = taskId
		this.completionProjector = new TaskCompletionProjector({
			taskId,
			...(historyItem?.completionStateRevision !== undefined
				? {
						initial: {
							isCompleted: historyItem.isCompleted === true,
							revision: historyItem.completionStateRevision,
						},
					}
				: {}),
			persist: ({ taskId: projectionTaskId, isCompleted, revision }) =>
				persistTaskCompletionState(projectionTaskId, isCompleted, revision),
		})
		this.promptCacheHealth = new PromptCacheHealthTracker(taskId, Logger)
		this.activityStore = new TaskActivityStore(taskId, new TaskActivityPersistence(taskId))
		this.taskRuntime = new TaskRuntime(
			createTaskRuntimeState({ taskId: this.taskId }),
			createInteractionPorts(
				async (state, durability, origin) => this.publishRuntimeTaskView(state, durability, origin),
				async (state, durability, origin) => this.emitStateSnapshot(createSnapshot(state), durability, origin),
				async () => this.abortExecution(),
				async () => {
					if (this.controllerDetached) return
					this.taskState.resetOperationCancellation()
					this.taskState.abort = false
					this.taskState.autoRetryAttempts = 0
				},
				async (effect) => {
					if (this.controllerDetached) return
					this.taskState.resetOperationCancellation()
					this.taskState.abort = false
					const hasRetryDraft = Boolean(
						effect.draft?.text?.trim() || effect.draft?.images?.length || effect.draft?.files?.length,
					)
					if (hasRetryDraft) this.ordinaryRequestInputReplay.clear()
					const replayHistoryIndex = this.compactionRequestReplay.getHistoryIndex(effect.apiIndex)
					if (effect.persistedRequest || replayHistoryIndex !== undefined) {
						const persistedRequestApiIndex = replayHistoryIndex ?? effect.apiIndex
						const persisted = this.messageStateHandler.apiConversationHistory[persistedRequestApiIndex]
						if (persisted?.role !== "user" || !Array.isArray(persisted.content)) {
							throw new Error(
								`Persisted API request is missing at logicalApiIndex=${effect.apiIndex}, historyIndex=${persistedRequestApiIndex}`,
							)
						}
						await this.recursivelyMakeClineRequests(persisted.content as ClineContent[], false, {
							reuseRequestAccounting: true,
							persistedRequestApiIndex,
							logicalApiIndex: effect.apiIndex,
						})
						return
					}
					if (effect.draft) {
						this.taskState.autoRetryAttempts = 0
					}
					if (effect.contentTransform === "mistake_limit") {
						this.resetMistakeLimitState()
					}
					const runtimeState = this.taskRuntime.getState()
					const retryBaseContent = effect.retryContent?.length ? cloneDeep(effect.retryContent) : undefined
					const normalizedRetryContent =
						retryBaseContent && runtimeState.turn
							? [
									...collectResumeTurnContent({
										blocks: runtimeState.turn.blocks,
										assistantApiIndex: runtimeState.turn.assistantApiIndex,
										apiHistory: this.messageStateHandler.apiConversationHistory,
										uiHistory: this.messageStateHandler.clineMessages,
										pendingContent: retryBaseContent,
										synthesizeMissing: "all",
									}),
									...retryBaseContent.filter((item) => item.type !== "tool_result"),
								]
							: retryBaseContent
					const retryFeedbackContent = normalizedRetryContent
						? await buildUserFeedbackContent(effect.draft?.text, effect.draft?.images, effect.draft?.files)
						: []
					const content =
						effect.contentTransform === "mistake_limit"
							? await buildMistakeLimitContinuationContent({
									turn: runtimeState.turn,
									apiHistory: this.messageStateHandler.apiConversationHistory,
									uiHistory: this.messageStateHandler.clineMessages,
									pendingContent: this.taskState.userMessageContent,
									feedback: {
										text: effect.draft?.text,
										images: effect.draft?.images,
										files: effect.draft?.files,
									},
								})
							: normalizedRetryContent
								? [...normalizedRetryContent, ...retryFeedbackContent]
								: await this.buildResumeApiContent(effect.draft)
					await this.recursivelyMakeClineRequests(content, false, {
						reuseRequestAccounting:
							effect.contentTransform === "mistake_limit" || Boolean(effect.retryContent?.length),
					})
				},
				(effect) =>
					dispatchToolExecutionEffect(effect, {
						track: (commandId) => this.toolDomainLedger.track(commandId),
						dispatch: (command) => this.getToolDomain().handle(command),
					}),
				async (effect) => {
					if (effect.interactionId) {
						await this.taskController.channel.presentSay(
							effect.taskSay,
							effect.presentation,
							effect.images,
							effect.files,
							effect.interactionId,
							effect.userInputKind,
							effect.queuedInputMode,
						)
						if (effect.feedbackAcknowledgment) {
							this.taskState.ackedFeedback = {
								response: effect.feedbackAcknowledgment,
								text: effect.feedbackAcknowledgmentText ?? effect.presentation,
								images: effect.images,
								files: effect.files,
							}
						}
						return
					}
					await this.taskController.say(effect.taskSay, effect.presentation, effect.images, effect.files)
				},
				async (effect) => ({
					uiMessageTs: await this.taskController.channel.presentAsk(
						effect.taskAsk as ClineAsk,
						effect.presentation,
						effect.existingTs,
						effect.interactionId,
					),
				}),
				async () => {
					// The footer "Start New Task" action must close the current task and return to
					// the RECENT welcome screen instead of immediately launching a replacement task,
					// so the user can review history and explicitly start a new task from there.
					await this.controller.clearTask({ clearPanelState: true, preserveCompletedState: true })
				},
				async (effect) => {
					const committed = await this.taskRuntime.dispatch({
						type: "TASK_SUCCESSOR_START_COMMITTED",
						source: effect.handoff.source,
					})
					if (!committed.accepted) {
						throw new Error(`Task successor commit rejected: ${committed.error?.code ?? "invalid_runtime_event"}`)
					}
					await Promise.all([
						this.flushTaskSnapshot(),
						this.messageStateHandler.flushApiConversationHistory(),
						this.messageStateHandler.flushUiMessages(),
					])
					await this.controller.startSuccessorTask(
						this.taskId,
						effect.handoff.context,
						effect.handoff.taskSettings,
						effect.handoff.initialUserContent,
					)
				},
			),
		)
		this.interactionCoordinator = new InteractionCoordinator(this.taskRuntime, {
			isPersistedApiRequest: (apiIndex) => {
				const message = this.messageStateHandler.apiConversationHistory[apiIndex]
				return message?.role === "user" && Array.isArray(message.content)
			},
			resolveLegacyRetryContent: (apiIndex, interactionId) =>
				this.resolveLegacyEphemeralRetryContent(apiIndex, interactionId),
			onAwaitingUserDurable: ({ turnId, interactionId }) => {
				this.completeProviderExecutionAtAwaitingUser(turnId, interactionId)
				// The interaction is durable and its waiter is installed, so retained
				// input can now answer it as an ordinary user response.
				// Record which interaction is waiting so the delivery, which is
				// driven by the coordinator, knows what it would be answering.
				this.awaitingQueuedInputInteraction = { turnId, interactionId }
				void this.inputQueueCoordinator.deliverAtTurnEnd()
			},
		})
		this.interactionCoordinator.registerDetachedContinuation((context) => this.continueRestoredInteraction(context))
		this.resumeCoordinator = new ResumeCoordinator({
			load: async () => this.loadResumeInput(),
			presentInteraction: async (result) => this.presentSynthesizedHistoryInteraction(result.snapshot),
			persist: async (result) => {
				// Routed through the persistence chain rather than writing
				// directly: a direct write races every other snapshot write,
				// and the queue field it carries could overwrite one that a
				// concurrent transaction had already committed.
				this.snapshotPersistence.schedule({ ...result.snapshot })
				await this.snapshotPersistence.flushNow()
				await this.syncTaskCompletionProjection(result.snapshot)
			},
			reportPersistenceFailure: (error) => {
				Logger.warn(
					`[Task ${this.taskId}] Historical interaction persistence failed; the stopped state will be reconstructed on reopen:`,
					error,
				)
			},
			hydrate: async (result) => {
				this.taskRuntime.restore(hydrateSnapshot(result.snapshot))
				this.syncRetainedMachines()
			},
			publishView: async () => {
				this.historyPreparationPending = false
				await this.controller.postTaskViewPatchToWebview()
			},
		})
		this.systemPromptCacheService = new SystemPromptCacheService({ taskId: this.taskId })
		this.promptFreshnessInvalidationCoordinator = new PromptFreshnessInvalidationCoordinator({
			taskId: this.taskId,
			reevaluate: () => this.reevaluatePromptFreshness(),
			publishState: () => this.postStateToWebview({ immediate: true }),
		})
		this.taskTelemetry = new TaskTurnTelemetry(
			this.taskId,
			() => this.taskRuntime.getState(),
			() => this.getApiRateSnapshot(),
		)
		this.taskRuntime.setCommitObserver((event, state) => this.taskTelemetry.committed(event, state))
		this.snapshotPersistence = new TaskSnapshotPersistence({
			writeSnapshot: this.writeTaskSnapshot.bind(this),
			onSnapshot: (stage, snapshot, error) => this.taskTelemetry.snapshot(stage, snapshot, error),
		})
		this.projectionScheduler = new TaskRuntimeProjectionScheduler({
			ports: {
				postView: () => this.postStateToWebview(),
				scheduleSnapshot: (snapshot) => this.snapshotPersistence.schedule(snapshot),
				flushSnapshot: () => this.snapshotPersistence.flushNow(),
				// A coalesced projection has already returned to the runtime, so its
				// failure is dispatched as the effect that scheduled it rather than
				// being blamed on whichever transition happens to run next.
				onDeferredFailure: ({ origin, effectType, error }) => {
					void this.taskRuntime
						.dispatch({
							type: "EFFECT_FAILED",
							effectId: origin.effectId,
							effectType,
							originRevision: origin.originRevision,
							message: error instanceof Error ? error.message : String(error),
						})
						.catch((dispatchError: unknown) => {
							Logger.warn(`[Task ${taskId}] Failed to report deferred projection failure: ${dispatchError}`)
						})
				},
			},
		})

		// Initialize taskId first
		if (historyItem) {
			this.ulid = historyItem.ulid ?? ulid()
			this.taskIsFavorited = historyItem.isFavorited
			this.taskState.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			if (historyItem.checkpointManagerErrorMessage) {
				this.taskState.checkpointManagerErrorMessage = historyItem.checkpointManagerErrorMessage
			}
		} else if (task || images || files) {
			this.ulid = ulid()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}
		this.taskTelemetry.registerAlias(this.ulid)
		this.initialTaskTitle = task ?? historyItem?.task

		this.messageStateHandler = new MessageStateHandler({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			taskIsFavorited: this.taskIsFavorited,
			updateTaskHistory: this.updateTaskHistory,
			publishTaskHistoryClose,
			uiMessage,
			apiConversation,
		})
		this.historyResumeMaintenance = new HistoryResumeMaintenance({
			cleanupLegacyStorage: () => this.cleanLegacyTaskStorage(),
			repairEncryptedReasoning: () => this.repairPersistedEncryptedReasoning(),
			recoverInterruptedActivities: () => this.activityStore.recoverInterruptedActivities(),
			patchInterruptedCommandCards: (activityIds) => this.patchInterruptedCommandCards(activityIds),
			refreshTaskMetadata: () => this.messageStateHandler.updateTaskHistory(),
			refreshContextIndicator: () => this.refreshStableContextWindowIndicator({ reestimateDurable: true }),
			reportFailure: (stage, error) => {
				Logger.warn(`[Task ${this.taskId}] Historical maintenance failed during ${stage}:`, error)
			},
		})

		// Create MessageChannel (message engine) and TaskController (central hub)
		const channel = new MessageChannel({
			pushMessage: (msg) => {
				if (this.controllerDetached) return
				return sendPartialMessageEvent(this.controller, convertClineMessageToProto(msg))
			},
			syncState: async () => {
				await this.postStateToWebview()
			},
			messageStateHandler: this.messageStateHandler,
			taskState: this.taskState,
			getProviderInfo: () => {
				const info = this.getCurrentProviderInfo()
				return { providerId: info.providerId, modelId: info.model.id, mode: info.mode }
			},
			genTs: () => this.genMessageTs(),
			recordAskLifecycle: (record) => {
				const elapsed = record.elapsedMs === undefined ? "" : ` elapsedMs=${record.elapsedMs}`
				const reason = record.reason === undefined ? "" : ` reason=${record.reason}`
				Logger.debug(
					`[Task ${this.taskId}] askLifecycle event=${record.event} ask=${record.ask} ts=${record.askTs}${elapsed}${reason}`,
				)
			},
		})
		this.taskController = new TaskController(channel)
		this.contextCompactionSession = this.createContextCompactionSession()

		// Initialize context trackers
		this.fileContextTracker = new FileContextTracker(controller, this.taskId)
		this.taskFileTracker = new TaskFileTracker(this.taskId)
		this.modelContextTracker = new ModelContextTracker(this.taskId)
		this.environmentContextTracker = new EnvironmentContextTracker(this.taskId)

		// Initialize focus chain manager only if enabled
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		if (focusChainSettings.enabled) {
			this.FocusChainManager = new FocusChainManager({
				taskId: this.taskId,
				taskState: this.taskState,
				getMode: () => this.getMode(),
				stateManager: this.stateManager,
				postStateToWebview: this.postStateToWebview,
				say: this.say.bind(this),
				focusChainSettings: focusChainSettings,
			})
		}

		// Initialize resume/restore handlers
		this.restoreHandler = new RestoreHandler({
			taskState: this.taskState,
			controller: this.taskController,
			messageStateHandler: this.messageStateHandler,
			checkpointManager: this.checkpointManager,
			presentAssistantMessage: this.presentAssistantMessage.bind(this),
			recursivelyMakeClineRequests: this.recursivelyMakeClineRequests.bind(this),
			postStateToWebview: this.postStateToWebview,
			prepareAdmission: (block) => {
				if (!this.toolExecutor) throw new Error("ToolExecutor is unavailable during pending-tool restore")
				return this.toolExecutor.prepareAdmission(block)
			},
		})

		// Check for multiroot workspace and warn about checkpoints
		const isMultiRootWorkspace = this.workspaceManager && this.workspaceManager.getRoots().length > 1
		const checkpointsEnabled = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")

		if (isMultiRootWorkspace && checkpointsEnabled) {
			// Set checkpoint manager error message to display warning in TaskHeader
			this.taskState.checkpointManagerErrorMessage = "Checkpoints are not currently supported in multi-root workspaces."
		}

		// Initialize checkpoint manager based on workspace configuration
		if (!isMultiRootWorkspace) {
			try {
				this.checkpointManager = buildCheckpointManager({
					taskId: this.taskId,
					controller: this.controller,
					messageStateHandler: this.messageStateHandler,
					fileContextTracker: this.fileContextTracker,
					contextManager: this.contextManager,
					diffViewProvider: this.diffViewProvider,
					taskState: this.taskState,
					taskFileTracker: this.taskFileTracker,
					workspaceManager: this.workspaceManager,
					updateTaskHistory: this.updateTaskHistory,
					say: this.say.bind(this),
					cancelTask: this.cancelTask,
					restoreChatRuntime: (input) => this.restoreCheckpointChatRuntime(input),
					postStateToWebview: this.postStateToWebview,
					initialConversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					initialCheckpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
					stateManager: this.stateManager,
				})

				// If multi-root, kick off non-blocking initialization
				// Unreachable for now, leaving in for future multi-root checkpoint support
				if (
					shouldUseMultiRoot({
						workspaceManager: this.workspaceManager,
						enableCheckpoints: this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
						stateManager: this.stateManager,
					})
				) {
					this.checkpointManager.initialize?.().catch((error: Error) => {
						Logger.error("Failed to initialize multi-root checkpoint manager:", error)
						this.taskState.checkpointManagerErrorMessage = error?.message || String(error)
					})
				}
			} catch (error) {
				Logger.error("Failed to initialize checkpoint manager:", error)
				if (this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Failed to initialize checkpoint manager: ${errorMessage}`,
					})
				}
			}
		}

		// Prepare effective API configuration
		const apiConfiguration = this.stateManager.getApiConfigurationForTask(taskId)
		const mode = this.taskSm.mode

		// Existing history bindings always win; global profiles initialize only
		// genuinely new tasks whose task-local bindings are absent.
		if (!historyItem && this.taskSm.planModeProfile === undefined && apiConfiguration.planModeProfile) {
			if (apiConfiguration.planModeProfileId) {
				this.taskSm.adoptResolvedProfileIdentity(
					"plan",
					apiConfiguration.planModeProfileId,
					apiConfiguration.planModeProfile,
				)
			} else {
				this.taskSm.setPlanModeProfile(apiConfiguration.planModeProfile)
			}
		}
		if (!historyItem && this.taskSm.actModeProfile === undefined && apiConfiguration.actModeProfile) {
			if (apiConfiguration.actModeProfileId) {
				this.taskSm.adoptResolvedProfileIdentity(
					"act",
					apiConfiguration.actModeProfileId,
					apiConfiguration.actModeProfile,
				)
			} else {
				this.taskSm.setActModeProfile(apiConfiguration.actModeProfile)
			}
		}

		const effectiveApiConfiguration: ApiConfiguration = {
			...apiConfiguration,
			...(this.taskSm.planModeProfileId !== undefined && { planModeProfileId: this.taskSm.planModeProfileId }),
			...(this.taskSm.planModeProfile !== undefined && { planModeProfile: this.taskSm.planModeProfile }),
			...(this.taskSm.actModeProfileId !== undefined && { actModeProfileId: this.taskSm.actModeProfileId }),
			...(this.taskSm.actModeProfile !== undefined && { actModeProfile: this.taskSm.actModeProfile }),
			ulid: this.ulid,
			onStreamEstimatedTokens: (tokens) => this.apiRateMetricsService.recordEstimatedTokens(tokens),
			onRetryAttempt: async (attempt: number, maxRetries: number, delay: number, error: unknown) => {
				const clineMessages = this.messageStateHandler.clineMessages
				const lastApiReqStartedIndex = findLastIndex(clineMessages, (m) => m.say === "api_req_started")
				if (lastApiReqStartedIndex !== -1) {
					try {
						const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[lastApiReqStartedIndex].text || "{}")
						currentApiReqInfo.retryStatus = {
							attempt: attempt, // attempt is already 1-indexed from retry.ts
							maxAttempts: maxRetries, // total attempts
							delaySec: Math.round(delay / 1000),
							errorSnippet: error instanceof Error ? `${error.message.substring(0, 50)}...` : undefined,
						}
						// Clear previous cancelReason and streamingFailedMessage if we are retrying
						delete currentApiReqInfo.cancelReason
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateClineMessage(lastApiReqStartedIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})

						// Post the updated state to the webview so the UI reflects the retry attempt
						await this.postStateToWebview().catch((e) =>
							Logger.error("Error posting state to webview in onRetryAttempt:", e),
						)
					} catch (e) {
						Logger.error(`[Task ${this.taskId}] Error updating api_req_started with retryStatus:`, e)
					}
				}
			},
		}
		const profileResolution = resolveTaskApiProfile(effectiveApiConfiguration, mode, historyItem?.providerId)
		const currentProfile =
			mode === "plan" ? profileResolution.configuration.planModeProfile : profileResolution.configuration.actModeProfile
		const currentProvider = resolveProviderFromProfile(currentProfile) || historyItem?.providerId || DEFAULT_API_PROVIDER
		if (profileResolution.usedFallback) {
			Logger.warn(
				`[Task ${this.taskId}] Task API profile is unavailable; using session fallback "${profileResolution.resolvedProfile}" without changing the persisted binding.`,
			)
		}

		// Keep history readable even when no profile can be resolved. Continuing the task
		// fails at the provider boundary with an actionable diagnostic.
		this.api =
			profileResolution.error || !profileResolution.resolvedApiProfile
				? createUnavailableApiHandler(profileResolution.error ?? "Profile not valid: resolved Profile is unavailable.")
				: buildApiHandlerFromProfile(profileResolution.configuration, mode, profileResolution.resolvedApiProfile)
		if (!profileResolution.usedFallback && profileResolution.resolvedProfileId && profileResolution.resolvedProfile) {
			this.taskSm.adoptResolvedProfileIdentity(mode, profileResolution.resolvedProfileId, profileResolution.resolvedProfile)
		}
		const currentProfileRecord = findEnabledProfileByName(currentProfile)
		const { contextWindow: initialContextWindow } = getContextWindowInfo(this.api)
		const initialDurableContextTokens = getLatestReliableContextWindowTokens(this.getContextWindowRequestPressures())
		this.contextWindowIndicator = new ContextWindowIndicator({
			taskId: this.taskId,
			durableContextTokens: initialDurableContextTokens,
			environmentTokens: 0,
			contextWindow: initialContextWindow,
			profileId: currentProfileRecord?.id,
			profileName: currentProfileRecord?.name ?? currentProfile,
			mode,
		})
		this.taskState.contextWindowIndicator = this.contextWindowIndicator.getSnapshot()

		// Set ulid on browserSession for telemetry tracking
		this.browserSession.setUlid(this.ulid)

		// Note: Task initialization (startTask/displayHistory/resumeFromHistory) is now called
		// from Controller.initTask() AFTER the task instance is fully assigned.
		// This prevents race conditions where hooks run before controller.task is ready.

		// Set up focus chain file watcher + load history (async, runs in background) only if focus chain is enabled
		if (this.FocusChainManager) {
			this.FocusChainManager.setupFocusChainFileWatcher()
				.then(() => this.syncPanelTitleFromState())
				.catch((error) => {
					Logger.error(`[Task ${this.taskId}] Failed to setup focus chain file watcher:`, error)
				})
			this.FocusChainManager.readFocusChainHistory()
				.then(async (history) => {
					if (history) {
						this.taskState.focusChainHistory = history
						await this.postStateToWebview()
					}
				})
				.catch((error) => {
					Logger.error(`[Task ${this.taskId}] Failed to load focus chain history:`, error)
				})
		}

		// initialize telemetry

		// Extract domain of the provider endpoint if using OpenAI Compatible provider.
		// Provider-specific baseUrl is now sourced from profile resolver at runtime.
		// Domain extraction is deferred — telemetry will record "unknown" for openai-compatible.
		let openAiCompatibleDomain: string | undefined
		if (currentProvider === "openai") {
			openAiCompatibleDomain = undefined
		}

		if (historyItem) {
			// Open task from history
			telemetryService.captureTaskRestarted(this.ulid, currentProvider, openAiCompatibleDomain)
		} else {
			// New task started
			telemetryService.captureTaskCreated(this.ulid, currentProvider, openAiCompatibleDomain)
		}

		// Initialize command executor with config and callbacks
		const commandExecutorConfig: FullCommandExecutorConfig = {
			cwd: this.cwd,
			workspaceRoots: this.workspaceManager?.getRoots().map((root) => root.path) ?? [this.cwd],
			terminalConfiguration,
			terminalExecutionMode: this.terminalExecutionMode,
			terminalCommandHandoffSeconds:
				this.stateManager.getGlobalSettingsKey("terminalCommandHandoffSeconds") ??
				DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS,
			terminalManager: this.terminalManager,
			windowsProcessTreeProvider,
			taskId: this.taskId,
			ulid: this.ulid,
		}

		const commandExecutorCallbacks: CommandExecutorCallbacks = {
			say: this.say.bind(this) as CommandExecutorCallbacks["say"],
			ask: async (type: string, text?: string, partial?: boolean, options?: { commandTs?: number }) => {
				const result = await this.ask(type as ClineAsk, text, partial, options)
				return {
					response: result.response,
					text: result.text,
					images: result.images,
					files: result.files,
				}
			},
			resolvePendingAsk: (response) => {
				void this.handleWebviewAskResponse(response as ClineAskResponse)
			},
			updateBackgroundCommandState: (isRunning: boolean) =>
				this.controller.updateBackgroundCommandState(isRunning, this.taskId),
			onHandoffAvailabilityChanged: () => {
				void this.postStateToWebview({ immediate: true })
			},
			updateClineMessage: async (
				index: number,
				updates: {
					text?: string
					exitCode?: number
					commandStatus?: CommandStatus
					logPath?: string
					activityId?: string
				},
			) => {
				await this.messageStateHandler.updateClineMessage(index, updates)
				// Notify frontend so the sliding window reflects updated fields (e.g. commandStatus, exitCode)
				const updatedMessage = this.messageStateHandler.clineMessages[index]
				if (updatedMessage) {
					await sendPartialMessageEvent(this.controller, convertClineMessageToProto(updatedMessage))
				}
			},
			getClineMessages: () => this.messageStateHandler.clineMessages as Array<{ ask?: string; say?: string }>,
			addToUserMessageContent: (content: { type: string; text: string }) => {
				// Cast to ClineTextContentBlock which is compatible with ClineContent
				this.taskState.userMessageContent.push({ type: "text", text: content.text } as ClineTextContentBlock)
			},
			markWorkspaceScanRequired: () => this.taskFileTracker.markWorkspaceScanRequired(),
			createCommandActivity: ({ activityId, command, timeoutSeconds, executionMode, cancellationOwner, cancel }) => {
				this.activityStore.create({
					activityId,
					kind: "command",
					executionMode,
					cancellationOwner,
					title: command.split(/\r?\n/, 1)[0].slice(0, 240) || "Command",
					detail: command,
					timeoutSeconds,
					cancel,
				})
			},
			updateCommandActivity: (activityId, patch) => {
				const { lineCount, ...activityPatch } = patch
				this.activityStore.update(activityId, {
					...activityPatch,
					metrics: lineCount === undefined ? undefined : { lineCount },
				})
			},
			appendCommandActivityOutput: (activityId, text) => this.activityStore.appendOutput(activityId, text),
		}

		this.commandExecutor = new CommandExecutor(commandExecutorConfig, commandExecutorCallbacks)

		// Note: the scheduler's getDelayMs reads this.isRemoteWorkspaceEnvironment which is
		// populated asynchronously by remoteWorkspaceDetectionPromise. The promise is awaited
		// before streaming begins (in recursivelyMakeClineRequests) so the cadence is always
		// correct by the time the first flush is scheduled.
		this.presentationScheduler = new TaskPresentationScheduler({
			flush: async (context) => {
				try {
					await this.flushPendingReasoningMessage(context)
					await this.presentAssistantMessage(context)
				} catch (error) {
					if (this.taskState.abort && error instanceof Error && error.message === "Dline instance aborted") {
						Logger.debug(`[Task ${taskId}] presentAssistantMessage flush skipped after abort: ${error.message}`)
					} else {
						const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
						Logger.error(`[Task ${taskId}] presentAssistantMessage flush failed: ${detail}`)
					}
					throw error
				}
			},
			getDelayMs: (priority) => {
				if (!this.remoteWorkspaceDetectionSettled) {
					// This should never fire in production because recursivelyMakeClineRequests
					// awaits remoteWorkspaceDetectionPromise before the first flush is scheduled.
					// If it does fire, we fall back to the local cadence (safe default).
					Logger.warn(
						`[Task ${taskId}] getDelayMs called before remote workspace detection settled ÃƒÂ¢Ã¢â€?using local cadence as fallback`,
					)
				}
				return getPresentationCadenceMs(this.isRemoteWorkspaceEnvironment, priority)
			},
			onFlushError: (error) => Logger.debug(`[Task] Failed scheduled presentation flush: ${error}`),
		})

		this.toolExecutor = new ToolExecutor(
			this.taskState,
			this.taskController,
			this.messageStateHandler,
			this.api,
			this.urlContentFetcher,
			this.browserSession,
			this.diffViewProvider,
			this.mcpHub,
			this.fileContextTracker,
			this.taskFileTracker,
			this.ignoreController,
			this.commandPermissionController,
			this.contextManager,
			this.stateManager,
			() => this.getMode(),
			() => this.getTaskCapabilityToggles(),
			this.identityFactory,
			this.activityStore,
			this.createProviderRequestRoundPort(),
			cwd,
			this.taskId,
			this.ulid,
			this.terminalExecutionMode,
			this.workspaceManager,
			isMultiRootEnabled(this.stateManager),
			{
				open: (request) =>
					this.interactionCoordinator.open({
						...request,
						turnId: this.taskRuntime.getState().turn?.turnId ?? request.turnId,
					}),
				complete: (request) =>
					this.interactionCoordinator.complete({
						...request,
						turnId: this.taskRuntime.getState().turn?.turnId ?? request.turnId,
					}),
				say: async (request) => {
					await this.say(
						request.taskSay,
						request.presentation,
						request.images,
						request.files,
						false,
						request.existingTs,
					)
				},
			},
			{
				isCurrent: (passIdentity, authorizationAttemptId) =>
					this.compactionRequestReplay.isCurrentAuthorizationAttempt(passIdentity, authorizationAttemptId),
			},
			this.say.bind(this),
			this.ask.bind(this),
			this.saveCheckpointCallback.bind(this),
			this.sayAndCreateMissingParamError.bind(this),
			this.executeCommandTool.bind(this),
			this.killCommandTool.bind(this),
			this.cancelBackgroundCommand.bind(this),
			() => this.checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
			this.createWrappedFCUpdateCallback(),
			(newPlan: string) => this.FocusChainManager?.forceReplaceFocusChain(newPlan) ?? Promise.resolve(),
			this.switchToActModeCallback.bind(this),
			this.cancelTask,
			// Atomic hook state helpers for ToolExecutor
			this.setActiveHookExecution.bind(this),
			this.clearActiveHookExecution.bind(this),
			this.getActiveHookExecution.bind(this),
			this.runUserPromptSubmitHook.bind(this),
			commandExecutorCallbacks.updateClineMessage,
		)

		// Inject controller context for spawn_task to create new webview panels
		this.toolExecutor.setControllerContext(this.controller?.context)
		this.promptInputFileWatcherInitialization = this.initializePromptInputFileWatcher()
	}

	private getEffectiveApiConfiguration(): ApiConfiguration {
		const apiConfiguration = this.stateManager.getApiConfigurationForTask(this.taskId)
		return {
			...apiConfiguration,
			...(this.taskSm.planModeProfileId !== undefined && { planModeProfileId: this.taskSm.planModeProfileId }),
			...(this.taskSm.planModeProfile !== undefined && { planModeProfile: this.taskSm.planModeProfile }),
			...(this.taskSm.actModeProfileId !== undefined && { actModeProfileId: this.taskSm.actModeProfileId }),
			...(this.taskSm.actModeProfile !== undefined && { actModeProfile: this.taskSm.actModeProfile }),
			ulid: this.ulid,
			onStreamEstimatedTokens: (tokens) => this.apiRateMetricsService.recordEstimatedTokens(tokens),
		}
	}

	private async resolveLegacyEphemeralRetryContent(
		apiIndex: number,
		interactionId: string,
	): Promise<ClineContent[] | undefined> {
		const messages = this.messageStateHandler.clineMessages
		const errorAskIndex = findLastIndex(
			messages,
			(message) => message.type === "ask" && message.ask === "api_req_failed" && message.interactionId === interactionId,
		)
		if (errorAskIndex < 0) return undefined
		for (let index = errorAskIndex - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.conversationHistoryIndex !== apiIndex) continue
			if (message.type === "say" && message.say === "user_feedback") {
				const content = await buildUserFeedbackContent(message.text, message.images, message.files)
				return content.length > 0 ? content : undefined
			}
			if (
				message.type === "ask" &&
				(message.ask === "resume_task" || message.ask === "resume_completed_task" || message.ask === "api_req_failed")
			) {
				break
			}
		}
		return undefined
	}

	private async buildResumeApiContent(draft?: InteractionDraft): Promise<ClineContent[]> {
		const runtimeState = this.taskRuntime.getState()
		if (runtimeState.phase !== TaskPhase.RESUMING) {
			return buildUserFeedbackContent(draft?.text, draft?.images, draft?.files)
		}

		if (runtimeState.turn) {
			const restoredToolContent = collectResumeTurnContent({
				blocks: runtimeState.turn.blocks,
				assistantApiIndex: runtimeState.turn.assistantApiIndex,
				apiHistory: this.messageStateHandler.apiConversationHistory,
				uiHistory: this.messageStateHandler.clineMessages,
				pendingContent: this.taskState.userMessageContent,
				synthesizeMissing: "all",
			})
			const feedbackContent = await buildUserFeedbackContent(
				createResumeContinuationText(draft?.text),
				draft?.images,
				draft?.files,
			)
			return [...restoredToolContent, ...feedbackContent]
		}

		const restoredInput = await projectResumeOrdinaryInput({
			apiHistory: this.messageStateHandler.apiConversationHistory,
			ordinaryInput: this.taskState.userMessageContent,
			draft,
		})
		const feedbackContent = await buildUserFeedbackContent(
			createResumeContinuationText(restoredInput.draftEmbedded ? undefined : draft?.text),
			restoredInput.draftEmbedded ? undefined : draft?.images,
			restoredInput.draftEmbedded ? undefined : draft?.files,
		)
		return [...restoredInput.content, ...feedbackContent]
	}

	private resolveProfileBinding(profileName: string): { profileId: string; profileName: string } {
		const profile = findEnabledProfileByName(profileName)
		if (!profile) throw new Error(`Profile not valid: "${profileName}" is unavailable.`)
		return { profileId: profile.id, profileName: profile.name }
	}

	/** Rebuild the active handler from one fresh Profile snapshot. */
	public async rebuildApiHandler(
		options: { validateCredentials?: boolean; abortPrevious?: boolean } = {},
	): Promise<ApiProfileValidity> {
		const mode = this.taskSm.mode
		const previousApi = this.api
		const previousPromptScope = this.getApiHandlerPromptScope(previousApi)
		const profileResolution = await resolveTaskApiProfileFresh(this.getEffectiveApiConfiguration(), mode)
		const nextApi =
			profileResolution.error || !profileResolution.resolvedApiProfile
				? createUnavailableApiHandler(profileResolution.error ?? "Profile not valid: resolved Profile is unavailable.")
				: buildApiHandlerFromProfile(profileResolution.configuration, mode, profileResolution.resolvedApiProfile)
		if (options.abortPrevious === true || !this.taskState.isStreaming) previousApi.abort?.()
		this.api = nextApi
		if (!profileResolution.usedFallback && profileResolution.resolvedProfileId && profileResolution.resolvedProfile) {
			this.taskSm.adoptResolvedProfileIdentity(mode, profileResolution.resolvedProfileId, profileResolution.resolvedProfile)
		}
		const validity =
			options.validateCredentials === true &&
			profileResolution.validity.status === "valid" &&
			profileResolution.resolvedApiProfile
				? await validateApiProfileCredentials(profileResolution.resolvedApiProfile)
				: profileResolution.validity
		if (this.toolExecutor) {
			this.toolExecutor.setApi(this.api)
		}
		if (previousPromptScope !== this.getApiHandlerPromptScope(this.api)) {
			this.promptCacheHealth.reset("profile_changed")
		}
		return validity
	}

	/** Capture the handler fields that affect prompt shape and context accounting. */
	private getApiHandlerPromptScope(api: ApiHandler): string {
		const model = api.getModel()
		return JSON.stringify({
			providerId: api.getProviderId?.(),
			modelId: model.id,
			modelInfo: model.info,
			webToolsMode: api.getWebToolsMode?.(),
			mode: this.taskSm.mode,
		})
	}

	/** Return the operation currently owning the Task-local compaction Session. */
	public getContextCompactionOperationId(): string | undefined {
		return this.contextCompactionSession.getActiveOperationId()
	}

	/** Expose the destructive fallback only while terminal automatic compaction recovery is awaiting Retry. */
	public isForceTruncateAvailable(): boolean {
		const interaction = this.getRuntimeState().interaction
		return (
			this.taskState.forceTruncateAvailable &&
			!this.taskState.abort &&
			interaction?.kind === "error_retry" &&
			interaction.status === "awaiting"
		)
	}

	/** Return the authoritative Task-local context-window indicator snapshot. */
	public getContextWindowIndicator(): ContextWindowIndicatorSnapshot {
		return this.contextWindowIndicator.getSnapshot()
	}

	/**
	 * Publish one committed runtime view after completing any phase-bound indicator transition.
	 *
	 * Phase-bound indicator settling stays on the committing transition because it
	 * reads state that a later coalesced post would no longer observe; only the
	 * Webview build itself is deferred.
	 */
	private async publishRuntimeTaskView(
		state: Readonly<TaskRuntimeState>,
		durability: SnapshotDurability = "flushed",
		origin?: ProjectionEffectOrigin,
	): Promise<void> {
		this.apiRateMetricsService.setTaskLoopActive(isTaskRateMetricsLoopActive(state.phase))
		if (state.phase === TaskPhase.COMPLETED) {
			await this.settleOrdinaryIndicatorRound()
		}
		await this.projectionScheduler.postView(durability, origin)
	}

	/** Synchronize the authoritative indicator after an active runtime scope is durably adopted. */
	private syncContextWindowIndicatorScope(): boolean {
		const mode = this.taskSm.mode
		const profile = this.getContextWindowIndicatorProfile(mode)
		const { contextWindow } = getContextWindowInfo(this.api)
		return this.setContextWindowIndicatorSnapshot(
			this.contextWindowIndicator.adoptScope({
				contextWindow,
				...profile,
				mode,
			}),
		)
	}

	private setContextWindowIndicatorSnapshot(snapshot: ContextWindowIndicatorSnapshot): boolean {
		if ((this.taskState.contextWindowIndicator?.revision ?? -1) >= snapshot.revision) return false
		this.taskState.contextWindowIndicator = cloneDeep(snapshot)
		return true
	}

	private async publishContextWindowIndicatorSnapshot(
		snapshot: ContextWindowIndicatorSnapshot,
		options: { immediate?: boolean; wait?: boolean } = {},
	): Promise<void> {
		if (!this.setContextWindowIndicatorSnapshot(snapshot)) return
		const publication = this.postStateToWebview({ immediate: options.immediate ?? true })
		if (options.wait === false) {
			void publication.catch((error) =>
				Logger.debug(`[Task ${this.taskId}] Failed to publish context-window indicator: ${error}`),
			)
			return
		}
		await publication
	}

	private getContextWindowIndicatorProfile(mode: Mode, profileName?: string): { profileId?: string; profileName?: string } {
		const resolvedName = profileName ?? this.getContextCompactionProfileBinding(mode)
		const profile = findEnabledProfileByName(resolvedName)
		return { profileId: profile?.id, profileName: profile?.name ?? resolvedName }
	}

	private async beginOrdinaryContextWindowIndicator(
		apiIndex: number,
		providerAttempt: number,
		requestScope: RequestApiScope,
		providerInput: CompactionProviderInput,
	): Promise<ContextWindowIndicatorLineage> {
		const lineage: ContextWindowIndicatorLineage = {
			kind: "ordinary",
			requestId: `ordinary:${this.taskId}:${apiIndex}`,
			requestSequence: this.taskState.apiRequestCount,
			attemptId: `ordinary:${this.taskId}:${apiIndex}:attempt:${providerAttempt}`,
		}
		const estimatedSegments = estimateContextWindowIndicatorSegments({
			providerInput,
			durableMessageCount: Math.max(0, providerInput.messages.length - 1),
			providerId: requestScope.providerInfo.providerId,
			modelId: requestScope.providerInfo.model.id,
		})
		const profile = this.getContextWindowIndicatorProfile(requestScope.providerInfo.mode)
		const contextWindow = getContextWindowInfo(requestScope.api).contextWindow
		// Use the same authoritative occupancy projection as admission. The frozen
		// Provider durable baseline and the local absolute estimate are different
		// measurement scales and must never be subtracted directly.
		const currentIndicator = this.contextWindowIndicator.getSnapshot()
		const durableContextTokens = currentIndicator.durableContextTokens
		const requestPressures = this.getContextWindowRequestPressures()
		const occupancy = resolveContextWindowProjection({
			requestInfos: requestPressures,
			candidateEstimatedTokens: estimatedSegments.totalTokens,
			contextWindow,
			triggerTokens: contextWindow,
		})
		const segments =
			requestPressures.length === 0 && currentIndicator.revision === 0
				? estimatedSegments
				: projectAuthoritativeContextWindowIndicatorSegments({
						projectedTotalTokens: occupancy.projectedUsageTokens,
						durableContextTokens,
						estimatedEnvironmentTokens: estimatedSegments.environmentTokens,
					})
		this.ordinaryContextIndicatorLineageByApiIndex.set(apiIndex, lineage)
		this.ordinaryContextIndicatorReceivingByApiIndex.set(apiIndex, new ContextWindowReceivingTracker())
		await this.publishContextWindowIndicatorSnapshot(
			this.contextWindowIndicator.beginSend({
				lineage,
				durableContextTokens: segments.durableContextTokens,
				pendingSendTokens: segments.pendingSendTokens,
				environmentTokens: segments.environmentTokens,
				contextWindow,
				...profile,
				mode: requestScope.providerInfo.mode,
			}),
		)
		return lineage
	}

	private async receiveOrdinaryContextWindowIndicator(
		apiIndex: number,
		expectedLineage: ContextWindowIndicatorLineage,
		chunk: unknown,
	): Promise<void> {
		const lineage = this.ordinaryContextIndicatorLineageByApiIndex.get(apiIndex)
		const receiving = this.ordinaryContextIndicatorReceivingByApiIndex.get(apiIndex)
		if (!lineage || !receiving || !isSameContextWindowIndicatorLineage(lineage, expectedLineage)) return
		const previous = receiving.getSnapshot()
		const snapshot = receiving.apply(chunk)
		if (
			previous.receivingTokens === snapshot.receivingTokens &&
			previous.authoritativeContextTokens === snapshot.authoritativeContextTokens
		) {
			return
		}
		await this.publishContextWindowIndicatorSnapshot(
			this.contextWindowIndicator.receive({
				lineage,
				receivingTokens: snapshot.receivingTokens,
				authoritativeContextTokens: snapshot.authoritativeContextTokens,
			}),
		)
	}

	/** Stage the completed Provider exchange and clear per-request bookkeeping. */
	private async settleOrdinaryIndicatorRound(): Promise<void> {
		const pendingEntries = [...this.ordinaryContextIndicatorLineageByApiIndex.entries()]
		if (pendingEntries.length === 0) return
		const latestEntry = pendingEntries[pendingEntries.length - 1]
		const latestLineage = latestEntry?.[1]
		if (!latestLineage || latestEntry === undefined) return
		const latestReceiving = this.ordinaryContextIndicatorReceivingByApiIndex.get(latestEntry[0])?.getSnapshot()
		await this.publishContextWindowIndicatorSnapshot(
			this.contextWindowIndicator.settle({
				lineage: latestLineage,
				authoritativeContextTokens: latestReceiving?.authoritativeContextTokens || undefined,
			}),
		)
		for (const [apiIndex] of pendingEntries) {
			this.ordinaryContextIndicatorLineageByApiIndex.delete(apiIndex)
			this.ordinaryContextIndicatorReceivingByApiIndex.delete(apiIndex)
		}
	}

	/** Re-estimate the not-yet-frozen continuation as one replaceable Staged value. */
	private async refreshOrdinaryIndicatorStaged(): Promise<void> {
		if (this.contextWindowIndicator.getSnapshot().phase !== "stable") return
		const pendingInputTokens = estimateContextWindowCandidate(
			{
				systemPrompt: "",
				messages: [
					{
						role: "user",
						content: cloneDeep(this.taskState.userMessageContent),
					},
				],
				tools: [],
				serverTools: [],
			},
			{ providerId: this.api.getProviderId?.() ?? DEFAULT_API_PROVIDER, modelId: this.api.getModel().id },
		)
		await this.publishContextWindowIndicatorSnapshot(this.contextWindowIndicator.refreshStaged({ pendingInputTokens }))
	}

	private async rollbackOrdinaryContextWindowIndicator(
		apiIndex: number,
		expectedLineage?: ContextWindowIndicatorLineage,
	): Promise<void> {
		const lineage = this.ordinaryContextIndicatorLineageByApiIndex.get(apiIndex)
		if (!lineage || (expectedLineage && !isSameContextWindowIndicatorLineage(lineage, expectedLineage))) return
		const rolledBack = this.contextWindowIndicator.rollback({ lineage })
		await this.publishContextWindowIndicatorSnapshot(rolledBack)
		await this.publishContextWindowIndicatorSnapshot(this.contextWindowIndicator.settle({ lineage: rolledBack.lineage }))
		this.ordinaryContextIndicatorLineageByApiIndex.delete(apiIndex)
		this.ordinaryContextIndicatorReceivingByApiIndex.delete(apiIndex)
	}

	private getContextCompactionIndicatorLineage(
		operationId: string,
		passIndex: number,
		attempt: { attemptIndex: number; authorizationAttemptId: string },
	): ContextWindowIndicatorLineage {
		return {
			kind: "compaction_pass",
			operationId,
			passIndex,
			attemptIndex: attempt.attemptIndex,
			attemptId: attempt.authorizationAttemptId,
		}
	}

	private async beginContextCompactionIndicator(
		input: ContextCompactionSessionInput,
		event:
			| Extract<ContextCompactionSessionEvent, { kind: "pass_started" }>
			| Extract<ContextCompactionSessionEvent, { kind: "pass_retry" }>,
		attempt: { attemptIndex: number; authorizationAttemptId: string },
	): Promise<void> {
		const lineage = this.getContextCompactionIndicatorLineage(input.operationId, event.passIdentity.passIndex, attempt)
		const estimatedSegments = estimateContextWindowIndicatorSegments({
			providerInput: event.providerInput,
			durableMessageCount: event.state.cumulativeSummary ? 1 : 0,
			providerId: input.compactionApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
			modelId: input.compactionApi.getModel().id,
		})
		const currentIndicator = this.contextWindowIndicator.getSnapshot()
		const latestProviderTokens = getLatestReliableContextWindowTokens(this.getContextWindowRequestPressures())
		const segments =
			latestProviderTokens > 0
				? projectAuthoritativeContextWindowIndicatorSegments({
						projectedTotalTokens: latestProviderTokens,
						durableContextTokens: currentIndicator.durableContextTokens,
						estimatedEnvironmentTokens: currentIndicator.environmentTokens,
					})
				: estimatedSegments
		const targetProfile = input.transition?.target.profile ?? this.getContextCompactionProfileBinding(input.targetMode)
		this.contextCompactionIndicatorReceivingByAttemptId.set(
			attempt.authorizationAttemptId,
			new ContextWindowReceivingTracker(),
		)
		await this.publishContextWindowIndicatorSnapshot(
			this.contextWindowIndicator.beginSend({
				lineage,
				durableContextTokens: segments.durableContextTokens,
				pendingSendTokens: segments.pendingSendTokens,
				environmentTokens: segments.environmentTokens,
				contextWindow: getContextWindowInfo(input.compactionApi).contextWindow,
				...this.getContextWindowIndicatorProfile(input.targetMode, targetProfile),
				mode: input.targetMode,
			}),
		)
	}

	private async receiveContextCompactionIndicator(
		event: Extract<ContextCompactionSessionEvent, { kind: "pass_receiving" }>,
	): Promise<void> {
		const lineage = this.getContextCompactionIndicatorLineage(
			event.passIdentity.operationId,
			event.passIdentity.passIndex,
			event.attempt,
		)
		const currentLineage = this.contextWindowIndicator.getSnapshot().lineage
		if (!isSameContextWindowIndicatorLineage(currentLineage, lineage)) return
		const receiving = this.contextCompactionIndicatorReceivingByAttemptId.get(event.attempt.authorizationAttemptId)
		if (!receiving) return
		const previous = receiving.getSnapshot()
		const snapshot = receiving.apply(event.chunk)
		if (
			previous.receivingTokens === snapshot.receivingTokens &&
			previous.authoritativeContextTokens === snapshot.authoritativeContextTokens
		) {
			return
		}
		this.setContextWindowIndicatorSnapshot(
			this.contextWindowIndicator.receive({
				lineage,
				receivingTokens: snapshot.receivingTokens,
				authoritativeContextTokens: snapshot.authoritativeContextTokens,
			}),
		)
	}

	private async retryContextCompactionIndicator(
		input: ContextCompactionSessionInput,
		event: Extract<ContextCompactionSessionEvent, { kind: "pass_retry" }>,
	): Promise<void> {
		const failedLineage = this.getContextCompactionIndicatorLineage(
			input.operationId,
			event.passIdentity.passIndex,
			event.event.failedAttempt,
		)
		if (!isSameContextWindowIndicatorLineage(this.contextWindowIndicator.getSnapshot().lineage, failedLineage)) return
		await this.publishContextWindowIndicatorSnapshot(this.contextWindowIndicator.rollback({ lineage: failedLineage }))
		this.contextCompactionIndicatorReceivingByAttemptId.delete(event.event.failedAttempt.authorizationAttemptId)
		await this.beginContextCompactionIndicator(input, event, event.event.nextAttempt)
	}

	private async commitContextCompactionIndicator(
		event: Extract<ContextCompactionSessionEvent, { kind: "pass_completed" }>,
	): Promise<void> {
		const projection = event.projection.indicator
		if (!projection) return
		const currentLineage = this.contextWindowIndicator.getSnapshot().lineage
		if (
			currentLineage.kind !== "compaction_pass" ||
			currentLineage.operationId !== event.passIdentity.operationId ||
			currentLineage.passIndex !== event.passIdentity.passIndex ||
			currentLineage.attemptIndex !== event.attempt.attemptIndex ||
			currentLineage.attemptId !== event.attempt.authorizationAttemptId
		) {
			return
		}
		const committed = this.contextWindowIndicator.commit({
			lineage: currentLineage,
			durableContextTokens: projection.durableContextTokens,
			pendingSendTokens: projection.pendingSendTokens,
			allowDecrease: true,
			environmentTokens: projection.environmentTokens,
			contextWindow: projection.contextWindow,
			profileId: projection.profileId,
			profileName: projection.profileName,
			mode: projection.mode,
		})
		await this.publishContextWindowIndicatorSnapshot(committed)
		await this.publishContextWindowIndicatorSnapshot(this.contextWindowIndicator.settle({ lineage: currentLineage }))
		this.contextCompactionIndicatorReceivingByAttemptId.delete(event.attempt.authorizationAttemptId)
	}

	/** Return the current Task-local prompt cache health projection. */
	public getPromptCacheHealth(): PromptCacheHealthSnapshot {
		return this.promptCacheHealth.getSnapshot()
	}

	/** Return the latest read-only prompt freshness projection. */
	public getPromptFreshness(): PromptFreshnessSnapshot {
		return this.systemPromptCacheService.getPromptFreshness()
	}

	/** Return active-second TPM, complete-execution RPM, and cumulative round usage. */
	public getApiRateSnapshot(): ApiRateSnapshot {
		const active = this.apiRateMetricsService.getSnapshot()
		const rounds = this.apiRequestRoundLifecycle.getSnapshot()
		const executions = this.apiRequestRoundLifecycle.getExecutionSnapshot()
		return {
			...(active.activeSeconds === undefined ? {} : { activeSeconds: active.activeSeconds }),
			...(active.tokensPerMinute === undefined ? {} : { tokensPerMinute: active.tokensPerMinute }),
			...(executions.requestsPerMinute === undefined ? {} : { requestsPerMinute: executions.requestsPerMinute }),
			rpmBasis: executions.rpmBasis,
			executionCount: executions.executionCount,
			...(executions.executionDurationMs === undefined ? {} : { executionDurationMs: executions.executionDurationMs }),
			providerRoundCount: rounds.providerRoundCount,
			...(rounds.totalTokensIn === undefined ? {} : { totalTokensIn: rounds.totalTokensIn }),
			...(rounds.totalTokensOut === undefined ? {} : { totalTokensOut: rounds.totalTokensOut }),
			...(rounds.totalCacheWrites === undefined ? {} : { totalCacheWrites: rounds.totalCacheWrites }),
			...(rounds.totalCacheReads === undefined ? {} : { totalCacheReads: rounds.totalCacheReads }),
			...(rounds.totalCost === undefined ? {} : { totalCost: rounds.totalCost }),
			...(rounds.cacheHitRate === undefined ? {} : { cacheHitRate: rounds.cacheHitRate }),
			cacheUsageAvailable: rounds.cacheUsageAvailable,
			...(rounds.currency === undefined ? {} : { currency: rounds.currency }),
		}
	}

	/** Query persisted Task-local API rate history without adding it to ExtensionState. */
	public async queryApiRateMetrics(query: ApiRateMetricsQuery): Promise<ApiRateMetricsQueryResult> {
		await this.ensureApiRateMetricsInitialized()
		return this.apiRateMetricsService.query(query)
	}

	/** Query unified Task-local TPM, complete-execution RPM, and round usage/cache history. */
	public async queryTaskRateMetrics(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult> {
		await this.ensureApiRateMetricsInitialized()
		return this.taskRateMetricsQueryService.query(query)
	}

	private ensureApiRateMetricsInitialized(): Promise<void> {
		this.apiRateMetricsInitialization ??= (() => {
			const beganAt = performance.now()
			const activeMetrics = this.apiRateMetricsService.initialize().finally(() => {
				Logger.debug(
					`[Task ${this.taskId}] API rate metrics initialization phase=active durationMs=${Math.round(performance.now() - beganAt)}`,
				)
			})
			const roundMetrics = this.apiRequestRoundLifecycle
				.initializeRounds()
				.catch((error) => {
					Logger.warn(`[Task ${this.taskId}] Failed to recover API request round metrics`, error)
				})
				.finally(() => {
					Logger.debug(
						`[Task ${this.taskId}] API rate metrics initialization phase=rounds durationMs=${Math.round(performance.now() - beganAt)}`,
					)
				})
			const executionMetrics = this.apiRequestRoundLifecycle
				.initializeExecutions()
				.catch((error) => {
					Logger.warn(`[Task ${this.taskId}] Failed to recover API response execution metrics`, error)
				})
				.finally(() => {
					Logger.debug(
						`[Task ${this.taskId}] API rate metrics initialization phase=executions durationMs=${Math.round(performance.now() - beganAt)}`,
					)
				})
			return Promise.all([activeMetrics, roundMetrics, executionMetrics]).then(() => undefined)
		})()
		return this.apiRateMetricsInitialization
	}

	private async scheduleAssistantPresentation(
		_trigger: TaskLatencyTrigger,
		priority: PresentationPriority = "normal",
	): Promise<void> {
		if (this.presentationSchedulingDisabled) {
			// Scheduling is disabled: preserve the old per-chunk synchronisation
			// semantics by awaiting flushNow() directly, while still routing through
			// the scheduler so its serialisation/locking guarantees are respected.
			await this.presentationScheduler.flushNow().catch((error) => {
				Logger.warn(`[Task] Failed immediate presentation flush: ${error}`)
			})
			return
		}

		this.presentationScheduler.requestFlush(priority)
	}

	/** Publish only the latest accumulated reasoning text at the presentation cadence. */
	private async flushPendingReasoningMessage(context?: PresentationFlushContext): Promise<void> {
		if (context && !context.isCurrent()) return
		const thinking = this.pendingReasoningText
		// An empty string is meaningful: it opens a contentless activity row for
		// encrypted reasoning. Only `undefined` means there is nothing to publish.
		if (thinking === undefined) return
		this.pendingReasoningText = undefined
		if (this.taskState.abort || (context && !context.isCurrent())) return

		const existingTs = this.taskState.reasoningTs
		const ts = await this.say("reasoning", thinking, undefined, undefined, true, existingTs)
		if (context && !context.isCurrent()) return
		if (ts !== undefined && existingTs === undefined) {
			this.taskState.reasoningTs = ts
		}
	}

	private async flushAssistantPresentationOrThrow() {
		await this.presentationScheduler.flushNow()
	}

	private getPresentationPriorityForChunk(args: {
		chunkType: "text" | "reasoning" | "tool_calls"
		hadVisibleAssistantContent: boolean
	}): PresentationPriority {
		if (!args.hadVisibleAssistantContent) {
			return "immediate"
		}

		if (args.chunkType === "tool_calls") {
			return "immediate"
		}

		return "normal"
	}

	// Communicate with webview

	// partial has three valid states true (partial message), false (completion of partial message), undefined (individual complete message)
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		options?: AskOptions,
	): Promise<{
		response: ClineAskResponse
		text?: string
		images?: string[]
		files?: string[]
		askTs?: number
	}> {
		const approvalKind = partial !== true ? this.getApprovalInteractionKind(type) : undefined
		const runtime = this.taskRuntime?.getState()
		const runtimeBlock = runtime?.turn?.blocks.find(
			(block) =>
				(options?.existingTs !== undefined && block.ts === options.existingTs) ||
				block.phase === "executing" ||
				block.phase === "auto_executing",
		)
		if (approvalKind && runtime?.turn && runtimeBlock) {
			const outcome = await this.interactionCoordinator.open({
				turnId: runtime.turn.turnId,
				interactionId: runtimeBlock.dlineTid,
				kind: approvalKind,
				presentation: text ?? "",
				existingTs: options?.existingTs,
			})
			return {
				response: outcome.actionId === "approve" ? "yesButtonClicked" : "noButtonClicked",
				text: outcome.draft?.text,
				images: outcome.draft?.images,
				files: outcome.draft?.files,
			}
		}

		const askOptions = this.withApprovalVisibleCallback(type, text, partial, options)

		const result = await this.taskController.ask(type, text, partial, askOptions)

		return result
	}

	/** Map legacy handler approval asks onto the canonical interaction registry. */
	private getApprovalInteractionKind(type: ClineAsk): InteractionKind | undefined {
		switch (type) {
			case "tool":
				return "tool_approval"
			case "command":
				return "command_approval"
			case "browser_action_launch":
				return "browser_approval"
			case "use_mcp_server":
				return "mcp_approval"
			case "use_subagents":
				return "subagent_approval"
			case "spawn_task":
				return "spawn_task_approval"
			case "change_todo_list":
				return "change_todo_list"
			default:
				return undefined
		}
	}

	// CONVERSATIONAL_TOOL_NAMES is now imported from @shared/tools as the
	// single source of truth shared by autoApprove, BlockPhaseMachine, and
	// handleWebviewAskResponse.

	/** Return the task-local mode without shared active-task routing. */
	getMode(): Mode {
		return this.taskSm.mode
	}

	/** Return the active Profile-related error interaction eligible for explicit recovery. */
	private getProfileRecoveryInteractionId(): string | undefined {
		const interaction = this.getRuntimeState().interaction
		if (interaction?.kind !== "error_retry" || !interaction.anchor?.messageTs) return undefined
		const presentation = this.messageStateHandler.clineMessages.find(
			(message) => message.ts === interaction.anchor?.messageTs && message.ask === "api_req_failed",
		)
		return presentation?.text?.includes("Profile not valid:") ? interaction.interactionId : undefined
	}

	/** Persistently remove the error presentation superseded by a durable Profile recovery. */
	private async clearProfileRecoveryMessages(interactionId: string): Promise<void> {
		const messages = this.messageStateHandler.clineMessages
		const errorAskIndex = findLastIndex(
			messages,
			(message) =>
				message.ask === "api_req_failed" &&
				message.interactionId === interactionId &&
				message.text?.includes("Profile not valid:") === true,
		)
		if (errorAskIndex < 0) return

		for (let index = errorAskIndex - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.say !== "api_req_started" || !message.text) continue
			let requestInfo: ClineApiReqInfo
			try {
				requestInfo = JSON.parse(message.text) as ClineApiReqInfo
			} catch {
				continue
			}
			if (!requestInfo.streamingFailedMessage?.includes("Profile not valid:")) continue
			delete requestInfo.streamingFailedMessage
			await this.messageStateHandler.updateClineMessage(index, { text: JSON.stringify(requestInfo) })
			await this.messageStateHandler.flushMessageUpdate(index)
			break
		}

		await this.messageStateHandler.removeMessagesByTs([messages[errorAskIndex].ts])
	}

	/**
	 * Atomically commit one or both task-local Profile bindings.
	 *
	 * @param targetProfile Validated Profile name selected by the user.
	 * @param targetModes Task-local bindings included in the transaction.
	 */
	async commitProfileBindings(
		targetProfile: { profileId: string; profileName: string } | string,
		targetModes: readonly Mode[],
	): Promise<void> {
		const uniqueModes = [...new Set(targetModes)]
		const resolvedTarget = typeof targetProfile === "string" ? this.resolveProfileBinding(targetProfile) : targetProfile
		const targetBindings: Partial<Record<Mode, { profileId: string; profileName: string }>> = {}
		for (const mode of uniqueModes) targetBindings[mode] = resolvedTarget
		const rebuildActiveHandler = uniqueModes.includes(this.taskSm.mode)
		const profileRecoveryInteractionId = rebuildActiveHandler ? this.getProfileRecoveryInteractionId() : undefined
		const sourceProfileState = this.taskSm.setProfileIdentityBindings(targetBindings, { clearRuntimeOverrides: true })
		try {
			if (rebuildActiveHandler) await this.rebuildApiHandler()
			await this.stateManager.flushPendingState()
			if (rebuildActiveHandler) this.syncContextWindowIndicatorScope()
		} catch (error) {
			this.taskSm.restoreProfileState(sourceProfileState)
			if (rebuildActiveHandler) {
				try {
					await this.rebuildApiHandler()
				} catch (rollbackError) {
					throw new Error("Failed to restore the source Profile handler after Profile adoption failed.", {
						cause: rollbackError,
					})
				}
			}
			throw error
		}
		if (profileRecoveryInteractionId) {
			// The recovery waiter owns the failed request boundary. Cancel it before
			// removing the canonical interaction so its request finally block can
			// release the active-request flags before the UI becomes editable.
			const recoveryWaiterCancelled = this.interactionCoordinator.cancelPendingInteraction(
				profileRecoveryInteractionId,
				"profile_recovered",
			)
			if (recoveryWaiterCancelled) {
				await this.interactionCoordinator.waitForPendingInteraction(profileRecoveryInteractionId)
				await pWaitFor(() => !this.taskState.isStreaming && !this.taskState.isWaitingForFirstChunk, {
					interval: 10,
					timeout: 10_000,
				})
			}
			await this.clearProfileRecoveryMessages(profileRecoveryInteractionId)
			const recovered = await this.dispatchRuntime({
				type: "PROFILE_RECOVERY_COMMITTED",
				interactionId: profileRecoveryInteractionId,
			})
			if (!recovered.accepted && this.getRuntimeState().interaction?.interactionId === profileRecoveryInteractionId) {
				Logger.warn(`[Task ${this.taskId}] Profile recovery interaction remained active after durable Profile commit.`)
			}
		}
	}

	/**
	 * Commit a validated task-local mode switch and rebuild runtime dependencies.
	 *
	 * @param targetMode Validated target mode.
	 * @param chatContent Optional pending draft to submit after handler rebuild.
	 */
	async commitMode(targetMode: Mode, chatContent?: ChatContent): Promise<void> {
		const sourceMode = this.taskSm.mode
		const hasModeSwitchInput = Boolean(
			chatContent?.message?.trim() || chatContent?.images?.length || chatContent?.files?.length,
		)
		const shouldContinueInteraction = hasModeSwitchInput && this.interactionCoordinator.canRespondForModeSwitch()
		if (hasModeSwitchInput && this.taskState.isAwaitingPlanResponse && !shouldContinueInteraction) {
			throw new Error("The active conversational interaction is no longer available for the mode switch.")
		}
		this.taskSm.setMode(targetMode)
		this.pendingSystemPromptRefreshReason = "mode_switch"
		await this.rebuildApiHandler()
		if (shouldContinueInteraction) {
			this.taskState.didRespondToPlanAskBySwitchingMode = sourceMode === "plan" && targetMode === "act"
			const continued = await this.interactionCoordinator.respondForModeSwitch({
				text: chatContent?.message ?? "",
				images: chatContent?.images ?? [],
				files: chatContent?.files ?? [],
			})
			if (!continued) {
				this.taskState.didRespondToPlanAskBySwitchingMode = false
				this.taskSm.setMode(sourceMode)
				await this.rebuildApiHandler()
				throw new Error("The active plan interaction changed during the mode switch.")
			}
		} else {
			this.taskState.didRespondToPlanAskBySwitchingMode = false
		}
		await this.stateManager.flushPendingState()
	}

	/** Project the complete pending target request without adopting the target mode or consuming one-shot context. */
	async projectModeSwitchTargetUsage(targetApi: ApiHandler, targetMode: Mode, chatContent?: ChatContent): Promise<number> {
		return this.projectContextTransitionTargetUsage(targetApi, targetMode, {
			chatContent,
			didSwitchFromPlan: this.taskSm.mode === "plan" && targetMode === "act",
			missingInteractionError: "Mode switch interaction block is unavailable for target projection.",
			projectInteraction: async (interaction, lifecycle) =>
				projectModeSwitchContinuation({
					kind: interaction.kind,
					functionId: lifecycle.functionId,
					dlineTid: lifecycle.dlineTid,
					sourceMode: this.taskSm.mode,
					targetMode,
					chatContent,
				}),
		})
	}

	/**
	 * Report context already occupied by the task without rebuilding a target request.
	 *
	 * The live segmented indicator owns presentation, while the newest persisted provider
	 * usage closes the short race before its asynchronous projection reaches the Webview.
	 * Selecting a Profile only rebinds the handler, so this advisory check remains pure.
	 */
	getOccupiedContextTokens(): number {
		return resolveOccupiedContextWindowTokens(
			getContextWindowIndicatorTotalTokens(this.contextWindowIndicator.getSnapshot()),
			this.getContextWindowRequestPressures(),
		)
	}

	/** Assemble one non-destructive complete target candidate for an explicit context transition. */
	private async projectContextTransitionTargetUsage(
		targetApi: ApiHandler,
		targetMode: Mode,
		options: {
			chatContent?: ChatContent
			didSwitchFromPlan: boolean
			missingInteractionError: string
			projectInteraction?: (
				interaction: NonNullable<ReturnType<TaskRuntime["getState"]>["interaction"]>,
				lifecycle: NonNullable<ReturnType<TaskRuntime["getState"]>["turn"]>["blocks"][number],
			) => ClineContent | Promise<ClineContent>
		},
	): Promise<number> {
		const requestScope = createRequestApiScope(
			targetApi,
			targetMode,
			this.stateManager.getGlobalSettingsKey("customPrompt"),
			this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled"),
			this.explicitInstructionRegistry,
		)
		try {
			const runtimeState = this.taskRuntime.getState()
			const interaction = runtimeState.interaction
			const turn = runtimeState.turn
			let continuationContent: ClineContent[] = []
			if (interaction && turn) {
				const lifecycle = turn.blocks.find((candidate) => candidate.dlineTid === interaction.interactionId)
				if (!lifecycle) throw new Error(options.missingInteractionError)
				continuationContent = collectResumeTurnContent({
					blocks: turn.blocks,
					assistantApiIndex: turn.assistantApiIndex,
					apiHistory: this.messageStateHandler.apiConversationHistory,
					uiHistory: this.messageStateHandler.clineMessages,
					pendingContent: this.taskState.userMessageContent,
					synthesizeMissing: "terminal_only",
					deferMissingDlineTids: [interaction.interactionId],
				})
				if (options.projectInteraction) {
					continuationContent.push(await options.projectInteraction(interaction, lifecycle))
				} else if (options.chatContent) {
					continuationContent.push(
						...(await buildUserFeedbackContent(
							options.chatContent.message,
							options.chatContent.images,
							options.chatContent.files,
						)),
					)
				}
			} else if (options.chatContent) {
				continuationContent = await buildUserFeedbackContent(
					options.chatContent.message,
					options.chatContent.images,
					options.chatContent.files,
				)
			}

			const [parsedContent, environmentDetails] = await this.loadContext(continuationContent, false, false, requestScope, {
				preview: true,
				mode: targetMode,
				didSwitchFromPlan: options.didSwitchFromPlan,
			})
			if (environmentDetails) parsedContent.push({ type: "text", text: environmentDetails })
			await this.appendBackgroundResults(parsedContent, { preview: true })
			const targetHistory: ClineStorageMessage[] = [
				...cloneDeep(this.messageStateHandler.apiConversationHistory),
				{ role: "user", content: parsedContent, ts: Date.now() },
			]
			const previousApiReqIndex = findLastIndex(
				this.messageStateHandler.clineMessages,
				(message) => message.say === "api_req_started",
			)
			const providerInput = await this.buildOrdinaryProviderInput(previousApiReqIndex, requestScope, targetHistory, {
				preview: true,
			})
			const candidateEstimatedTokens = estimateContextWindowCandidate(providerInput, {
				providerId: targetApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
				modelId: targetApi.getModel().id,
			})
			const { contextWindow } = getContextWindowInfo(targetApi)
			return resolveContextWindowProjection({
				requestInfos: this.getContextWindowRequestPressures(),
				candidateEstimatedTokens,
				contextWindow,
				triggerTokens: contextWindow,
			}).projectedUsageTokens
		} finally {
			requestScope.explicitInstructions.cancel()
		}
	}

	private resolveCompactionProviderInputCalibrationRatio(input: ContextCompactionSessionInput): number {
		if (input.transition) return 1
		const baseline = this.latestOrdinaryCompactionDiagnostic
		const provider = input.compactionApi.getProviderId?.() ?? DEFAULT_API_PROVIDER
		const modelId = input.compactionApi.getModel().id
		if (!baseline || baseline.providerId !== provider || baseline.modelId !== modelId) return 1
		for (let index = this.messageStateHandler.clineMessages.length - 1; index >= 0; index--) {
			const message = this.messageStateHandler.clineMessages[index]
			if (message.say !== "api_req_started" || !message.text) continue
			try {
				const info = JSON.parse(message.text) as ClineApiReqInfo
				const estimatedInputTokens = info.estimatedContextTokens ?? 0
				const providerInputTokens = (info.tokensIn ?? 0) + (info.cacheReads ?? 0) + (info.cacheWrites ?? 0)
				if (estimatedInputTokens <= 0 || providerInputTokens <= 0 || info.contextTokensSource === "estimate") return 1
				const ratio = Math.min(1, Math.max(0.5, providerInputTokens / estimatedInputTokens))
				if (isCompactionDevDiagnosticsEnabled()) {
					Logger.debug("[CompactionDiag] pass-zero-calibration", {
						taskId: this.taskId,
						estimatedInputTokens,
						providerInputTokens,
						ratio,
					})
				}
				return ratio
			} catch {
				return 1
			}
		}
		return 1
	}

	/** Create the sole Task-local execution boundary shared by every compaction trigger. */
	private createContextCompactionSession(): ContextCompactionSession {
		return new ContextCompactionSession(
			{
				getPassInputCeiling: (input) => {
					const { contextWindow } = getContextWindowInfo(input.compactionApi)
					return resolveCompactTriggerPolicy(
						contextWindow,
						computeSummarizeBudget(),
						this.getAutoCondenseTriggerOptions(),
					).passInputCeilingTokens
				},
				getSingleTurnInputCeiling: (input) => {
					const { contextWindow } = getContextWindowInfo(input.compactionApi)
					const policy = resolveCompactTriggerPolicy(
						contextWindow,
						computeSummarizeBudget(),
						this.getAutoCondenseTriggerOptions(),
					)
					return Math.max(
						0,
						policy.hardPassContextWindowTokens -
							COMPACTION_CLOSURE_RESERVE_TOKENS -
							MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
					)
				},
				estimatePassInput: async (input, passHistory, state) => {
					const calibrationRatio =
						state.passIndex === 0 ? this.resolveCompactionProviderInputCalibrationRatio(input) : 1
					const request = await this.buildContextCompactionPassRequest(
						input,
						passHistory,
						undefined,
						undefined,
						"estimate",
					)
					try {
						return Math.ceil(
							estimateContextWindowCandidate(request.providerInput, {
								providerId: input.compactionApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
								modelId: input.compactionApi.getModel().id,
							}) * calibrationRatio,
						)
					} finally {
						request.explicitInstructions.cancel()
					}
				},
				buildPassRequest: (input, state, feedback, passHistory) =>
					this.buildContextCompactionPassRequest(
						input,
						passHistory ?? buildCompactionPassHistory(state),
						feedback,
						state.nextPassSummaryCarryLimitTokens,
						"send",
						state.passIndex === 0 ? this.resolveCompactionProviderInputCalibrationRatio(input) : 1,
					),
				buildSummaryRefitRequest: (input, state, carryLimitTokens, refitAttempt) => {
					if (!state.cumulativeSummary) throw new Error("Summary refit requires an existing cumulative summary")
					return this.buildContextCompactionPassRequest(
						input,
						[{ role: "user", content: [{ type: "text", text: state.cumulativeSummary }] }],
						[{ type: "text", text: buildSummaryRefitGuidance(carryLimitTokens, refitAttempt) }],
						carryLimitTokens,
					)
				},
				reviewPass: (input, _state, passIdentity, attempt, summary) =>
					this.reviewContextCompactionPass(input, passIdentity, attempt, summary),
				reprojectTarget: (input, state) => this.reprojectContextCompactionTarget(input, state),
				stageAcceptedPass: async (_input, state, projection) => {
					this.taskState.targetWindowFittingState = { ...state }
					this.taskState.targetWindowFittingProjection = {
						projectedUsageTokens: projection.projectedUsageTokens,
						targetContextWindow: projection.targetContextWindow,
						coveredTurnCount: state.coveredTurnCount,
						totalTurnCount: state.turns.length,
					}
				},
				commit: (input, state) => this.commitContextCompaction(input, state),
				publish: (input, event) => this.publishContextCompactionEvent(input, event),
				waitForRetry: (_input, retryAttempt, signal) => this.waitForContextCompactionRetry(retryAttempt, signal),
				recordUsage: (usage) => {
					this.apiRateMetricsService.recordExactUsage(usage)
					if (isCompactionDevDiagnosticsEnabled()) {
						const fittingState = this.taskState.targetWindowFittingState
						Logger.debug(`[CompactionDiag] provider-usage`, {
							taskId: this.taskId,
							operationId: fittingState?.operationId ?? null,
							passIndex: fittingState?.passIndex ?? null,
							inputTokens: usage.inputTokens,
							outputTokens: usage.outputTokens,
							cacheReadTokens: usage.cacheReadTokens,
							cacheWriteTokens: usage.cacheWriteTokens,
							providerInputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
							providerContextTokens:
								usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
						})
					}
				},
				recordTiming: (timing) => {
					Logger.debug(`[Task ${this.taskId}] Context compaction timing`, timing)
				},
				providerRequestRounds: this.createProviderRequestRoundPort(),
			},
			{ maxRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS },
		)
	}

	private async settleContextCompactionIndicator(): Promise<void> {
		const lineage = this.contextWindowIndicator.getSnapshot().lineage
		await this.publishContextWindowIndicatorSnapshot(this.contextWindowIndicator.settle({ lineage }))
		await this.refreshStableContextWindowIndicator({ reestimateDurable: true })
	}

	private async estimateStableProjectedContext(mode: Mode): Promise<number> {
		const requestScope = createRequestApiScope(
			this.api,
			mode,
			this.stateManager.getGlobalSettingsKey("customPrompt"),
			this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled"),
			this.explicitInstructionRegistry,
		)
		try {
			const previousApiReqIndex = findLastIndex(
				this.messageStateHandler.clineMessages,
				(message) => message.say === "api_req_started",
			)
			const providerInput = await this.buildProviderInput(previousApiReqIndex, requestScope, {
				applyContextManagement: false,
				preview: true,
			})
			const segments = estimateContextWindowIndicatorSegments({
				providerInput,
				durableMessageCount: providerInput.messages.length,
				providerId: requestScope.providerInfo.providerId,
				modelId: requestScope.providerInfo.model.id,
			})
			return segments.durableContextTokens
		} finally {
			requestScope.explicitInstructions.cancel()
		}
	}

	private async estimateCurrentEnvironmentTokens(api: ApiHandler, mode: Mode): Promise<number> {
		const model = api.getModel()
		const promptProfile = resolvePromptProfile({
			modelId: model.id,
			contextWindow: model.info.capabilities?.contextWindow,
		})
		const environmentDetails = await this.getEnvironmentDetails(false, promptProfile, { preview: true, api, mode })
		return estimateContextWindowIndicatorSegments({
			providerInput: {
				systemPrompt: "",
				messages: [{ role: "user", content: [{ type: "text", text: environmentDetails }] }],
				serverTools: [],
			},
			durableMessageCount: 0,
			providerId: api.getProviderId?.() ?? DEFAULT_API_PROVIDER,
			modelId: model.id,
		}).environmentTokens
	}

	private async refreshStableContextWindowIndicator(options: { reestimateDurable?: boolean } = {}): Promise<void> {
		if (this.contextWindowEnvironmentRefreshInFlight || this.contextWindowIndicator.getSnapshot().phase !== "stable") return
		this.contextWindowEnvironmentRefreshInFlight = true
		try {
			const mode = this.taskSm.mode
			const profile = this.getContextWindowIndicatorProfile(mode)
			const environmentTokens = await this.estimateCurrentEnvironmentTokens(this.api, mode)
			const durableContextTokens = options.reestimateDurable ? await this.estimateStableProjectedContext(mode) : undefined
			const { contextWindow } = getContextWindowInfo(this.api)
			await this.publishContextWindowIndicatorSnapshot(
				this.contextWindowIndicator.refreshStable({
					durableContextTokens,
					environmentTokens,
					contextWindow,
					...profile,
					mode,
				}),
			)
		} catch (error) {
			Logger.debug(`[Task ${this.taskId}] Failed to refresh dynamic context-window environment: ${error}`)
		} finally {
			this.contextWindowEnvironmentRefreshInFlight = false
		}
	}

	private startContextWindowEnvironmentRefresh(): void {
		if (this.contextWindowEnvironmentRefreshTimer) return
		this.contextWindowEnvironmentRefreshTimer = setInterval(() => {
			void this.refreshStableContextWindowIndicator()
		}, 15_000)
		this.contextWindowEnvironmentRefreshTimer.unref?.()
	}

	private stopContextWindowEnvironmentRefresh(): void {
		if (!this.contextWindowEnvironmentRefreshTimer) return
		clearInterval(this.contextWindowEnvironmentRefreshTimer)
		this.contextWindowEnvironmentRefreshTimer = undefined
	}

	/** Resolve the effective task-local Profile name without consulting another active Task. */
	private getContextCompactionProfileBinding(mode: Mode): string | undefined {
		const configuration = this.stateManager.getApiConfigurationForTask(this.taskId)
		return mode === "plan"
			? (this.taskSm.planModeProfile ?? configuration.planModeProfile)
			: (this.taskSm.actModeProfile ?? configuration.actModeProfile)
	}

	/** Build one authorized hidden Pass request through the frozen target handler. */
	private async buildContextCompactionPassRequest(
		input: ContextCompactionSessionInput,
		passHistory: readonly ClineStorageMessage[],
		feedback?: readonly ClineContent[],
		summaryOutputLimitTokens?: number,
		purpose: "send" | "estimate" = "send",
		inputCalibrationRatio = 1,
	) {
		const requestScope = createRequestApiScope(
			input.compactionApi,
			input.targetMode,
			this.stateManager.getGlobalSettingsKey("customPrompt"),
			this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled"),
			this.explicitInstructionRegistry,
		)
		requestScope.explicitInstructions.register({
			type: "summarize_task",
			source: input.trigger,
			targetTool: ClineDefaultTool.SUMMARIZE_TASK,
			operationId: input.operationId,
		})
		const focusChainSettings =
			resolvePromptProfile({
				modelId: requestScope.providerInfo.model.id,
				contextWindow: requestScope.providerInfo.model.info.capabilities?.contextWindow,
			}) === PromptProfile.Standard
				? this.stateManager.getGlobalSettingsKey("focusChainSettings")
				: undefined
		const passGuidance = cloneDeep(feedback ?? input.passGuidance ?? [])
		const requestTimestamp = Date.now()
		const buildCandidateHistory = (budgetGuidance: string): ClineStorageMessage[] => [
			...cloneDeep(passHistory),
			{
				role: "user",
				content: [
					{
						type: "text",
						text: summarizeTask(focusChainSettings, this.cwd, isMultiRootEnabled(this.stateManager), budgetGuidance),
					},
					...cloneDeep(passGuidance),
				],
				ts: requestTimestamp,
			},
		]
		const previousApiReqIndex = findLastIndex(
			this.messageStateHandler.clineMessages,
			(message) => message.say === "api_req_started",
		)
		try {
			const providerInput = await this.buildProviderInput(previousApiReqIndex, requestScope, {
				apiConversationHistory: buildCandidateHistory(""),
				applyContextManagement: false,
				applyCompactionProjection: false,
				preview: true,
				conversationHistoryDeletedRange: null,
			})
			const { contextWindow } = getContextWindowInfo(input.compactionApi)
			const policy = resolveCompactTriggerPolicy(
				contextWindow,
				computeSummarizeBudget(),
				this.getAutoCondenseTriggerOptions(),
			)
			const resolvedBudget = resolveCompactionWindowBudget({
				contextWindow: policy.hardPassContextWindowTokens,
				maxOutputTokens: requestScope.providerInfo.model.info.capabilities?.maxTokens,
				summaryOutputLimitTokens,
				systemPrompt: providerInput.systemPrompt,
				tools: providerInput.tools,
				serverTools: providerInput.serverTools,
				closureReserveTokens: COMPACTION_CLOSURE_RESERVE_TOKENS,
				// The planner selects the Pass range with this same estimator. Measuring the request
				// differently here would let it reject a range the planner cannot shrink further.
				estimator: {
					providerId: input.compactionApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
					modelId: requestScope.providerInfo.model.id,
				},
				buildMessages: buildCandidateHistory,
			})
			const calibratedInputTokens = Math.ceil(resolvedBudget.budget.estimatedInputTokens * inputCalibrationRatio)
			const calibratedPassFits = calibratedInputTokens <= policy.passInputCeilingTokens
			if (resolvedBudget.budget.decision !== "ready" && purpose === "send" && !calibratedPassFits) {
				// Structured so the session can shrink the next Pass range using the measurement that
				// rejected this one instead of reproposing the range that just failed.
				throw new CompactionPassBudgetError({
					estimatedInputTokens: resolvedBudget.budget.estimatedInputTokens,
					contextWindow: policy.hardPassContextWindowTokens,
					availableRemainder: resolvedBudget.budget.availableRemainder,
					estimatedTextTokens: resolvedBudget.budget.estimatedTextTokens,
					estimatedImageTokens: resolvedBudget.budget.estimatedImageTokens,
				})
			}
			return {
				providerInput: {
					...providerInput,
					messages: resolvedBudget.messages,
					providerOutputCap: resolvedBudget.budget.providerOutputCap,
				},
				explicitInstructions: requestScope.explicitInstructions,
				initialAttemptId: requestScope.explicitInstructions.createConsumePort().identity.attemptId,
			}
		} catch (error) {
			requestScope.explicitInstructions.cancel()
			throw error
		}
	}

	/** Rebuild the complete target candidate with fresh dynamic environment after each accepted Pass. */
	private async reprojectContextCompactionTarget(
		input: ContextCompactionSessionInput,
		state: TargetWindowFittingState,
	): Promise<ContextCompactionReprojection> {
		const targetProfile = input.transition?.target.profile ?? this.getContextCompactionProfileBinding(input.targetMode)
		const requestScope = createRequestApiScope(
			input.targetApi,
			input.targetMode,
			this.stateManager.getGlobalSettingsKey("customPrompt"),
			this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled"),
			this.explicitInstructionRegistry,
		)
		try {
			const continuationContent = cloneDeep(input.targetContinuationContent ?? [])
			const [parsedContent, environmentDetails] = await this.loadContext(
				continuationContent,
				input.includeFileDetails === true,
				false,
				requestScope,
				{
					preview: true,
					mode: input.targetMode,
					didSwitchFromPlan: input.didSwitchFromPlan === true,
				},
			)
			if (environmentDetails) parsedContent.push({ type: "text", text: environmentDetails })
			await this.appendBackgroundResults(parsedContent, { preview: true })
			const continuation: ClineStorageMessage[] = parsedContent.length
				? [{ role: "user", content: parsedContent, ts: Date.now() }]
				: []
			const targetHistory = buildTargetCandidateHistory(state, [
				...cloneDeep(input.targetContinuationHistory ?? []),
				...continuation,
			])
			const providerReadyTargetHistory = this.contextManager.repairProviderMessages(targetHistory)
			const previousApiReqIndex = findLastIndex(
				this.messageStateHandler.clineMessages,
				(message) => message.say === "api_req_started",
			)
			const targetInput = await this.buildProviderInput(previousApiReqIndex, requestScope, {
				apiConversationHistory: providerReadyTargetHistory,
				applyContextManagement: false,
				applyCompactionProjection: false,
				preview: true,
				conversationHistoryDeletedRange: null,
			})
			const candidateEstimatedTokens = estimateContextWindowCandidate(targetInput, {
				providerId: input.targetApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
				modelId: input.targetApi.getModel().id,
			})
			const { contextWindow } = getContextWindowInfo(input.targetApi)
			const decision = decideTargetWindowFitting({
				candidateEstimatedTokens,
				providerContextWindow: contextWindow,
				...this.getAutoCondenseTriggerOptions(),
				hasMoreTurns: state.coveredTurnCount < state.turns.length,
			})
			const segments = estimateContextWindowIndicatorSegments({
				providerInput: targetInput,
				durableMessageCount: Math.max(0, targetInput.messages.length - continuation.length),
				providerId: input.targetApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
				modelId: input.targetApi.getModel().id,
			})
			return {
				...decision,
				indicator: {
					durableContextTokens: segments.durableContextTokens,
					pendingSendTokens: segments.pendingSendTokens,
					environmentTokens: segments.environmentTokens,
					contextWindow,
					...this.getContextWindowIndicatorProfile(input.targetMode, targetProfile),
					mode: input.targetMode,
				},
			}
		} finally {
			requestScope.explicitInstructions.cancel()
		}
	}

	/** Finalize the cumulative summary card without rewriting canonical API history. */
	private async commitContextCompaction(input: ContextCompactionSessionInput, state: TargetWindowFittingState): Promise<void> {
		const snapshot = this.contextCompactionPresentation.finalizeOperation(input.operationId)
		if (!snapshot?.existingTs) throw new Error("Completed compaction presentation is unavailable for durable commit.")
		const preCompactionApiEndIndex = this.messageStateHandler.apiConversationHistory.length - 1
		const range = createCompactionConversationRange(state, preCompactionApiEndIndex)
		await this.commitContextCompactionSnapshot(input, snapshot, range)
		this.taskState.targetWindowFittingState = undefined
		this.taskState.targetWindowFittingProjection = undefined
		this.taskState.compactionFittingRequired = false
		this.taskState.targetWindowFittingCommitted = true
		if (input.trigger === "task_header" || input.trigger === "manual_compact_command") {
			this.taskState.manualCompactionCommitted = true
		}
		this.pendingSystemPromptRefreshReason = "post_compaction"
		try {
			await this.stateManager.flushPendingState()
		} catch (error) {
			Logger.error(`[Task ${this.taskId}] Failed to flush state after durable compaction commit:`, error)
		}
	}

	/** Present a terminal automatic-compaction failure through the existing API retry interaction. */
	private async presentTerminalCompactionFailure(
		operationId: string,
		apiIndex: number,
		retryContent: ClineContent[],
	): Promise<void> {
		this.taskState.forceTruncateAvailable = true
		const errorMessage =
			this.contextCompactionFailureReasons.get(operationId) ?? "Context compaction failed before completion."
		const retryProgress = this.contextCompactionRetryProgress.get(operationId)
		const retriesExhausted =
			retryProgress !== undefined &&
			retryProgress.maxRetryAttempts > 0 &&
			retryProgress.retryAttempt >= retryProgress.maxRetryAttempts
		this.contextCompactionFailureReasons.delete(operationId)
		this.contextCompactionRetryProgress.delete(operationId)
		this.taskState.autoRetryAttempts = retriesExhausted ? retryProgress.retryAttempt : 0
		this.endAutoRetrySequence(false)
		await this.interactionCoordinator.releaseApiContinuationForRequestGate()
		if (retriesExhausted) {
			await this.say(
				"error_retry",
				JSON.stringify({
					attempt: retryProgress.retryAttempt,
					maxAttempts: retryProgress.maxRetryAttempts,
					delaySeconds: 0,
					failed: true,
					errorMessage,
				}),
			)
		}
		const retryId = `retry:${this.taskId}:${this.getRuntimeState().revision}`
		await this.recoverApiFailure({
			turnId: retryId,
			retryContent: cloneDeep(retryContent),
			interactionId: retryId,
			apiIndex,
			presentation: errorMessage,
			persistedRequest: false,
		})
	}

	/** Publish one Session Pass lifecycle through the Task-local per-Pass presentation owner. */
	private async publishContextCompactionEvent(
		input: ContextCompactionSessionInput,
		event: ContextCompactionSessionEvent,
	): Promise<void> {
		const isManual = input.trigger === "task_header" || input.trigger === "manual_compact_command"
		this.taskState.isManualContextCompactionRequest = isManual
		this.taskState.isInternalContextCompactionRequest = !isManual
		let snapshot: ContextCompactionPresentationSnapshot | undefined
		let commitSnapshot = false
		switch (event.kind) {
			case "pass_preparing":
				snapshot = this.contextCompactionPresentation.preparePass(input.operationId, event.state.passIndex)
				break
			case "pass_started":
				if (input.trigger === "auto_compaction") this.contextCompactionRetryProgress.delete(input.operationId)
				snapshot = this.contextCompactionPresentation.startPass(event.passIdentity, event.attempt)
				await this.beginContextCompactionIndicator(input, event, event.attempt)
				break
			case "pass_receiving":
				await this.receiveContextCompactionIndicator(event)
				snapshot = this.contextCompactionPresentation.receiving(event.passIdentity, event.attempt)
				break
			case "pass_partial":
				snapshot = this.contextCompactionPresentation.partial(event.passIdentity, event.attempt, event.content)
				break
			case "pass_retry":
				await this.retryContextCompactionIndicator(input, event)
				if (input.trigger === "auto_compaction" && event.event.kind === "pass_retry") {
					this.contextCompactionRetryProgress.set(input.operationId, {
						retryAttempt: event.event.retryAttempt,
						maxRetryAttempts: event.event.maxRetryAttempts,
					})
				}
				snapshot = this.contextCompactionPresentation.retry(
					event.passIdentity,
					event.event.failedAttempt,
					event.event.nextAttempt,
					event.event.kind === "pass_retry" ? event.event.retryAttempt : undefined,
					event.event.kind === "pass_retry" ? event.event.maxRetryAttempts : undefined,
				)
				break
			case "pass_completed":
				this.contextCompactionRetryProgress.delete(input.operationId)
				await this.commitContextCompactionIndicator(event)
				snapshot = this.contextCompactionPresentation.complete(event.passIdentity, event.attempt, event.content)
				commitSnapshot = event.projection.status !== "complete"
				break
			case "summary_refit_preparing":
				snapshot = this.contextCompactionPresentation.prepareSummaryRefit(event.passIdentity, event.refitAttempt - 1)
				break
			case "summary_refit_started":
				snapshot = this.contextCompactionPresentation.startSummaryRefit(
					event.passIdentity,
					event.refitAttempt - 1,
					event.attempt,
				)
				break
			case "summary_refit_receiving":
				snapshot = this.contextCompactionPresentation.receivingSummaryRefit(event.passIdentity, event.attempt)
				break
			case "summary_refit_partial":
				snapshot = this.contextCompactionPresentation.partialSummaryRefit(
					event.passIdentity,
					event.attempt,
					event.content,
				)
				break
			case "summary_refit_retry":
				snapshot = this.contextCompactionPresentation.retrySummaryRefit(
					event.passIdentity,
					event.event.failedAttempt,
					event.event.nextAttempt,
					event.event.kind === "pass_retry" ? event.event.retryAttempt : undefined,
					event.event.kind === "pass_retry" ? event.event.maxRetryAttempts : undefined,
					event.event.error instanceof Error ? event.event.error.message : String(event.event.error),
				)
				break
			case "summary_refit_completed":
				snapshot = this.contextCompactionPresentation.completeSummaryRefit(
					event.passIdentity,
					event.attempt,
					event.content,
				)
				commitSnapshot = true
				break
			case "failed":
				if (input.signal?.aborted) this.contextCompactionRetryProgress.delete(input.operationId)
				if (input.trigger === "auto_compaction") this.contextCompactionFailureReasons.set(input.operationId, event.error)
				this.contextCompactionIndicatorReceivingByAttemptId.clear()
				this.taskState.targetWindowFittingState = undefined
				this.taskState.targetWindowFittingProjection = undefined
				this.taskState.compactionFittingRequired = false
				this.taskState.targetWindowFittingCommitted = false
				snapshot = this.contextCompactionPresentation.fail(input.operationId, event.error)
				commitSnapshot = true
				break
		}
		if (snapshot) {
			await this.publishContextCompactionSnapshot(input, snapshot)
			if (commitSnapshot) {
				const durableSnapshot = this.contextCompactionPresentation.getUnitSnapshot(
					snapshot.operationId,
					snapshot.unitKind,
					snapshot.unitIndex,
				)
				if (!durableSnapshot) throw new Error("Context compaction execution-unit card disappeared before durable commit.")
				await this.commitContextCompactionSnapshot(input, durableSnapshot)
			}
		}
		if (
			event.kind === "pass_receiving" ||
			event.kind === "pass_partial" ||
			event.kind === "summary_refit_receiving" ||
			event.kind === "summary_refit_partial"
		) {
			return
		}
		await this.postStateToWebview()
	}

	/** Publish one transient execution-unit card without marking the durable UI store dirty. */
	private async publishContextCompactionSnapshot(
		input: ContextCompactionSessionInput,
		snapshot: ContextCompactionPresentationSnapshot,
	): Promise<void> {
		const message = this.createContextCompactionMessage(input, snapshot, true)
		const transient = this.messageStateHandler.upsertTransientClineMessage(message)
		if (snapshot.existingTs === undefined) this.contextCompactionPresentation.bindMessageTs(snapshot, message.ts)
		await sendPartialMessageEvent(this.controller, convertClineMessageToProto(transient))
	}

	/** Append one terminal execution-unit card to JSONL; only the final cumulative summary receives a canonical range. */
	private async commitContextCompactionSnapshot(
		input: ContextCompactionSessionInput,
		snapshot: ContextCompactionPresentationSnapshot,
		compactionConversationRange?: ClineMessage["compactionConversationRange"],
	): Promise<ClineMessage> {
		if (!snapshot.existingTs) throw new Error("Context compaction card is unavailable for durable commit.")
		const committed = await this.messageStateHandler.finalizeClineMessage(
			this.createContextCompactionMessage(input, snapshot, false, compactionConversationRange),
		)
		this.contextCompactionPresentation.markDurable(snapshot)
		try {
			await sendPartialMessageEvent(this.controller, convertClineMessageToProto(committed))
		} catch (error) {
			Logger.error(`[Task ${this.taskId}] Failed to publish a durably committed compaction card:`, error)
		}
		return committed
	}

	private createContextCompactionMessage(
		input: ContextCompactionSessionInput,
		snapshot: ContextCompactionPresentationSnapshot,
		partial: boolean,
		compactionConversationRange?: ClineMessage["compactionConversationRange"],
	): ClineMessage {
		const model = input.targetApi.getModel()
		return {
			ts: snapshot.existingTs ?? this.genMessageTs(),
			type: "say",
			say: "tool",
			partial,
			text: JSON.stringify({
				tool: "summarizeTask",
				content: snapshot.content,
				compactionStatus: snapshot.status,
				...(snapshot.error ? { error: snapshot.error } : {}),
				...(snapshot.retryAttempt !== undefined ? { retryAttempt: snapshot.retryAttempt } : {}),
				...(snapshot.maxRetryAttempts !== undefined ? { maxRetryAttempts: snapshot.maxRetryAttempts } : {}),
				compactionOperationId: snapshot.operationId,
				compactionUnitKind: snapshot.unitKind,
				compactionUnitIndex: snapshot.unitIndex,
				compactionDurable: partial === false,
				...(snapshot.passIdentity ? { compactionPassIndex: snapshot.passIdentity.passIndex } : {}),
				...(snapshot.attempt ? { compactionAttemptIndex: snapshot.attempt.attemptIndex } : {}),
				...(snapshot.attempt ? { compactionAttemptId: snapshot.attempt.authorizationAttemptId } : {}),
			} satisfies ClineSayTool),
			conversationHistoryIndex: this.messageStateHandler.apiConversationHistory.length - 1,
			conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
			compactionConversationRange,
			modelInfo: {
				providerId: input.targetApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
				modelId: model.id,
				mode: input.targetMode,
			},
		}
	}

	/** Review one manual Pass without granting the handler any acceptance or canonical-write authority. */
	private async reviewContextCompactionPass(
		input: ContextCompactionSessionInput,
		passIdentity: ReturnType<typeof getCompactionPassIdentity>,
		attempt: { attemptIndex: number; authorizationAttemptId: string },
		summary: string,
	): Promise<ContextCompactionPassReview> {
		if (input.trigger !== "task_header" && input.trigger !== "manual_compact_command") {
			return { action: "accept" }
		}
		const snapshot = this.contextCompactionPresentation.getUnitSnapshot(input.operationId, "pass", passIdentity.passIndex)
		const existingTs =
			snapshot?.passIdentity &&
			snapshot.attempt &&
			areCompactionPassIdentitiesEqual(snapshot.passIdentity, passIdentity) &&
			snapshot.attempt.attemptIndex === attempt.attemptIndex &&
			snapshot.attempt.authorizationAttemptId === attempt.authorizationAttemptId
				? snapshot.existingTs
				: undefined
		const interactionId = `context-compaction-review:${input.operationId}:${passIdentity.passIndex}:${attempt.attemptIndex}`
		const review = {
			turnId: interactionId,
			interactionId,
			kind: "condense" as const,
			presentation: summary,
			existingTs,
		}
		const runtimeState = this.getRuntimeState()
		const outcome =
			runtimeState.interaction?.status === "awaiting"
				? await this.interactionCoordinator.interrupt(review)
				: await this.interactionCoordinator.open(review)
		if (outcome.actionId === "confirm_utility") return { action: "accept" }
		if (outcome.actionId !== "reject") {
			throw new Error(`Unsupported manual compaction action: ${outcome.actionId}`)
		}
		return {
			action: "regenerate",
			feedback: await buildUserFeedbackContent(
				outcome.draft?.text ?? "",
				outcome.draft?.images ?? [],
				outcome.draft?.files ?? [],
			),
		}
	}

	/** Wait for one Pass retry while respecting the Session-owned cancellation signal. */
	private waitForContextCompactionRetry(retryAttempt: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(finish, getRetryDelay(retryAttempt))
			const abort = () => finish(signal.reason ?? new Error("Context compaction cancelled."))
			function finish(error?: unknown): void {
				clearTimeout(timer)
				signal.removeEventListener("abort", abort)
				if (error) reject(error)
				else resolve()
			}
			if (signal.aborted) abort()
			else signal.addEventListener("abort", abort, { once: true })
		})
	}

	/** Clear request inputs that were frozen against a canonical state which is about to change. */
	private invalidatePreparedProviderInputs(): void {
		this.ordinaryRequestInputReplay.clear()
		this.compactionRequestReplay.clear()
	}

	/** Derive the active provider context from canonical API history and surviving completed cards. */
	private projectCanonicalContextWithRanges(canonicalHistory = this.messageStateHandler.apiConversationHistory): {
		messages: ClineStorageMessage[]
		sourceCanonicalRanges: Array<CanonicalMessageRange | undefined>
	} {
		const canonicalWithContextUpdates = this.contextManager.applyContextHistoryUpdatesToCanonical(cloneDeep(canonicalHistory))
		const projected = projectCompactionContext({
			canonicalHistory: canonicalWithContextUpdates,
			completedCards: readCompletedCompactionCards(this.messageStateHandler.clineMessages),
			conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
		})
		const repaired = this.contextManager.repairProviderMessagesWithRanges(
			cloneDeep(projected.messages),
			cloneDeep(projected.sourceCanonicalRanges),
		)
		return { messages: repaired.messages, sourceCanonicalRanges: repaired.canonicalRanges }
	}

	private projectCanonicalContext(canonicalHistory = this.messageStateHandler.apiConversationHistory): ClineStorageMessage[] {
		return this.projectCanonicalContextWithRanges(canonicalHistory).messages
	}

	/** Return the active fitting source and its canonical API range mapping. */
	private getContextCompactionSourceProjection(): {
		messages: ClineStorageMessage[]
		sourceCanonicalRanges: Array<CanonicalMessageRange | undefined>
	} {
		return this.projectCanonicalContextWithRanges()
	}

	/**
	 * Split active canonical history without mutating the assistant/tool tail protected from compaction.
	 *
	 * The compaction gate evaluates BEFORE the current request's user message is
	 * persisted, so tool results produced by the previous turn (e.g. a qna_respond
	 * reply) are still pending in taskState.userMessageContent. Indexing canonical
	 * history alone leaves their tool_use unpaired and pushes the entire history
	 * into the protected tail. Pending tool results are therefore merged into the
	 * boundary view so pairing succeeds; they never enter targetContinuationHistory
	 * because the upcoming request persists them separately.
	 */
	private getOrdinaryContextCompactionBoundary(pendingContent?: readonly ClineContent[]) {
		const source = this.getContextCompactionSourceProjection()
		return projectContextCompactionBoundary(
			source.messages,
			pendingContent ?? this.taskState.userMessageContent,
			{},
			source.sourceCanonicalRanges,
		)
	}

	/** Project a hidden-Pass source without resolving the Task Header's live turn-ending interaction. */
	private getTaskHeaderContextCompactionBoundary() {
		const source = this.getContextCompactionSourceProjection()
		return projectContextCompactionBoundary(
			source.messages,
			[],
			{ shouldCompleteUnpairedToolUse: (toolUse) => isTurnEndingToolName(toolUse.name) },
			source.sourceCanonicalRanges,
		)
	}

	/** Execute automatic fitting before ordinary admission without exposing a second Pass authority. */
	private async runOrdinaryContextCompaction(
		operationId: string,
		requestScope: RequestApiScope,
		ordinaryInput: ClineContent[],
		includeFileDetails: boolean,
	): Promise<ContextCompactionSessionResult> {
		if (this.contextCompactionSession.getActiveOperationId()) return "failed"
		const boundaryProjectionStartedAtMs = performance.now()
		const { sourceHistory, sourceCanonicalRanges, targetContinuationHistory } =
			this.getOrdinaryContextCompactionBoundary(ordinaryInput)
		const boundaryProjectionMs = elapsedCompactionMs(boundaryProjectionStartedAtMs)
		this.invalidatePreparedProviderInputs()
		try {
			return await this.contextCompactionSession.run({
				operationId,
				trigger: "auto_compaction",
				taskNamespace: this.taskId,
				compactionApi: requestScope.api,
				targetApi: requestScope.api,
				targetMode: requestScope.providerInfo.mode,
				sourceHistory,
				sourceCanonicalRanges,
				targetContinuationHistory,
				targetContinuationContent: cloneDeep(ordinaryInput),
				ordinaryInput: cloneDeep(ordinaryInput),
				includeFileDetails,
				boundaryProjectionMs,
				signal: this.taskState.operationSignal,
			})
		} finally {
			this.contextCompactionPresentation.clear(operationId)
			this.taskState.isInternalContextCompactionRequest = false
			this.taskState.isManualContextCompactionRequest = false
			await this.postStateToWebview({ immediate: true })
		}
	}

	/** Execute one slash-command compaction through the same Session without persisting command guidance. */
	private async runManualContextCompaction(
		operationId: string,
		requestScope: RequestApiScope,
		passGuidance: ClineContent[],
		includeFileDetails: boolean,
		pendingContent: readonly ClineContent[],
	): Promise<ContextCompactionSessionResult> {
		if (this.contextCompactionSession.getActiveOperationId()) return "failed"
		const boundaryProjectionStartedAtMs = performance.now()
		const { sourceHistory, sourceCanonicalRanges, targetContinuationHistory } =
			this.getOrdinaryContextCompactionBoundary(pendingContent)
		const boundaryProjectionMs = elapsedCompactionMs(boundaryProjectionStartedAtMs)
		this.invalidatePreparedProviderInputs()
		try {
			return await this.contextCompactionSession.run({
				operationId,
				trigger: "manual_compact_command",
				taskNamespace: this.taskId,
				compactionApi: requestScope.api,
				targetApi: requestScope.api,
				targetMode: requestScope.providerInfo.mode,
				sourceHistory,
				sourceCanonicalRanges,
				targetContinuationHistory,
				passGuidance: cloneDeep(passGuidance),
				targetContinuationContent: [],
				ordinaryInput: [],
				includeFileDetails,
				boundaryProjectionMs,
				signal: this.taskState.operationSignal,
			})
		} finally {
			this.contextCompactionPresentation.clear(operationId)
			this.taskState.isInternalContextCompactionRequest = false
			this.taskState.isManualContextCompactionRequest = false
			await this.postStateToWebview({ immediate: true })
		}
	}

	/** Freeze the target continuation without resolving the live interaction. */
	private async captureContextTransitionContinuation(
		trigger: "profile_switch" | "mode_switch",
		targetMode: Mode,
		chatContent?: ChatContent,
	): Promise<ClineContent[]> {
		const runtimeState = this.taskRuntime.getState()
		const interaction = runtimeState.interaction
		const turn = runtimeState.turn
		if (!interaction || !turn) {
			return chatContent ? buildUserFeedbackContent(chatContent.message, chatContent.images, chatContent.files) : []
		}
		const lifecycle = turn.blocks.find((candidate) => candidate.dlineTid === interaction.interactionId)
		if (!lifecycle) throw new Error("Context transition interaction block is unavailable for compaction.")
		const continuation = collectResumeTurnContent({
			blocks: turn.blocks,
			assistantApiIndex: turn.assistantApiIndex,
			apiHistory: this.messageStateHandler.apiConversationHistory,
			uiHistory: this.messageStateHandler.clineMessages,
			pendingContent: this.taskState.userMessageContent,
			synthesizeMissing: "terminal_only",
			deferMissingDlineTids: [interaction.interactionId],
		})
		if (trigger === "mode_switch") {
			continuation.push(
				await projectModeSwitchContinuation({
					kind: interaction.kind,
					functionId: lifecycle.functionId,
					dlineTid: lifecycle.dlineTid,
					sourceMode: this.taskSm.mode,
					targetMode,
					chatContent,
				}),
			)
		} else if (chatContent) {
			continuation.push(...(await buildUserFeedbackContent(chatContent.message, chatContent.images, chatContent.files)))
		}
		return continuation
	}

	/** Execute one Profile/Mode compaction without waking a conversational handler. */
	async compactForTransition(
		trigger: "profile_switch" | "mode_switch",
		operationId: string,
		targetApi: ApiHandler,
		targetMode: Mode,
		chatContent?: ChatContent,
		transition?: ContextCompactionTransitionState,
	): Promise<ContextCompactionSessionResult> {
		if (this.contextCompactionSession.getActiveOperationId()) return "failed"
		this.invalidatePreparedProviderInputs()
		try {
			const targetContinuationContent = await this.captureContextTransitionContinuation(trigger, targetMode, chatContent)
			const boundaryProjectionStartedAtMs = performance.now()
			const source = this.getContextCompactionSourceProjection()
			const boundaryProjectionMs = elapsedCompactionMs(boundaryProjectionStartedAtMs)
			const result = await this.contextCompactionSession.run({
				operationId,
				trigger,
				taskNamespace: this.taskId,
				compactionApi: targetApi,
				targetApi,
				targetMode,
				sourceHistory: source.messages,
				sourceCanonicalRanges: source.sourceCanonicalRanges,
				targetContinuationContent,
				didSwitchFromPlan: trigger === "mode_switch" && this.taskSm.mode === "plan" && targetMode === "act",
				transition,
				boundaryProjectionMs,
				signal: this.taskState.operationSignal,
			})
			if (result !== "completed") this.contextCompactionPresentation.clear(operationId)
			return result
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			const snapshot = this.contextCompactionPresentation.fail(operationId, reason)
			if (snapshot) {
				const failureInput: ContextCompactionSessionInput = {
					operationId,
					trigger,
					compactionApi: targetApi,
					targetApi,
					targetMode,
					sourceHistory: [],
				}
				await this.publishContextCompactionSnapshot(failureInput, snapshot)
				const durableSnapshot = this.contextCompactionPresentation.getUnitSnapshot(
					snapshot.operationId,
					snapshot.unitKind,
					snapshot.unitIndex,
				)
				if (durableSnapshot) await this.commitContextCompactionSnapshot(failureInput, durableSnapshot)
			}
			this.contextCompactionPresentation.clear(operationId)
			Logger.warn(`[Task ${this.taskId}] Context compaction failed before transition commit: ${reason}`)
			return "failed"
		} finally {
			this.taskState.isInternalContextCompactionRequest = false
			this.taskState.isManualContextCompactionRequest = false
			await this.postStateToWebview({ immediate: true })
		}
	}

	/** Request one user-triggered compaction without consuming a causal interaction. */
	public async compactTask(expectedRevision: number): Promise<{ accepted: boolean; result: string }> {
		const runtimeState = this.getRuntimeState()
		if (runtimeState.revision !== expectedRevision) return { accepted: false, result: "stale_state" }
		if (this.taskState.abort || !this.taskState.isInitialized || !runtimeState.interaction) {
			return { accepted: false, result: "unavailable" }
		}
		if (this.contextCompactionSession.getActiveOperationId()) {
			return { accepted: false, result: "already_running" }
		}

		const operationId = `manual-compact:${this.taskId}:${expectedRevision}`
		const { sourceHistory, sourceCanonicalRanges, targetContinuationHistory } = this.getTaskHeaderContextCompactionBoundary()
		this.invalidatePreparedProviderInputs()
		const settlement = this.contextCompactionSession
			.run({
				operationId,
				trigger: "task_header",
				compactionApi: this.api,
				targetApi: this.api,
				targetMode: this.taskSm.mode,
				sourceHistory,
				sourceCanonicalRanges,
				targetContinuationHistory,
				signal: this.taskState.operationSignal,
			})
			.finally(() => {
				this.contextCompactionPresentation.clear(operationId)
				this.taskState.isInternalContextCompactionRequest = false
				this.taskState.isManualContextCompactionRequest = false
				void this.postStateToWebview({ immediate: true }).catch((error) => {
					Logger.error(`[Task ${this.taskId}] Failed to publish settled Task Header compaction state:`, error)
				})
			})
			.then(() => undefined)
		this.taskHeaderCompactionSettlement = settlement
		void settlement.finally(() => {
			if (this.taskHeaderCompactionSettlement === settlement) this.taskHeaderCompactionSettlement = undefined
		})
		await this.postStateToWebview({ immediate: true })
		return { accepted: true, result: "accepted" }
	}

	/** Apply one explicit legacy history truncation without starting a provider request. */
	public async forceTruncateTask(expectedRevision: number): Promise<{ accepted: boolean; result: string }> {
		const runtimeState = this.getRuntimeState()
		if (runtimeState.revision !== expectedRevision) return { accepted: false, result: "stale_state" }
		if (this.taskState.abort || !this.taskState.isInitialized || !runtimeState.interaction) {
			return { accepted: false, result: "unavailable" }
		}
		if (!this.isForceTruncateAvailable()) {
			return { accepted: false, result: "not_available" }
		}
		if (this.contextCompactionSession.getActiveOperationId()) {
			return { accepted: false, result: "already_running" }
		}

		const previousRange = this.taskState.conversationHistoryDeletedRange
		await this.handleContextWindowExceededError(this.api, false, "none")
		const nextRange = this.taskState.conversationHistoryDeletedRange
		const rangeChanged =
			(nextRange?.[0] ?? undefined) !== (previousRange?.[0] ?? undefined) ||
			(nextRange?.[1] ?? undefined) !== (previousRange?.[1] ?? undefined)
		if (!rangeChanged) return { accepted: false, result: "no_history_to_truncate" }

		this.taskState.manualHistoryTruncationCommitted = true
		this.taskState.forceTruncateAvailable = false
		this.taskState.didAutomaticallyRetryFailedApiRequest = false
		await this.postStateToWebview({ immediate: true })
		return { accepted: true, result: "accepted" }
	}

	/** Settle the completed compaction projection after transition orchestration finishes. */
	async completeContextCompaction(operationId: string): Promise<void> {
		await this.settleContextCompactionIndicator()
		this.contextCompactionPresentation.clear(operationId)
		await this.postStateToWebview({ immediate: true })
	}

	/** Cancel only an in-flight compaction; a completed card survives transition commit failure. */
	async abortContextCompaction(operationId: string, reason: string): Promise<void> {
		this.contextCompactionSession.cancel(operationId, reason)
		this.contextCompactionPresentation.clear(operationId)
		this.taskState.isInternalContextCompactionRequest = false
		this.taskState.isManualContextCompactionRequest = false
		await this.postStateToWebview({ immediate: true })
	}

	private getAutoCondenseTriggerOptions(): CompactTriggerOptions {
		return {
			triggerPercent: this.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent"),
			minReserveTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
			maxReserveTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
			maxContextTokens: this.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
		}
	}

	/** Apply an aggressive history range before a source request that is already near its own limit. */
	private async prepareModeSwitchCompaction(
		currentTokens: number,
		sourceContextWindow: number,
		triggerOptions: CompactTriggerOptions,
	): Promise<void> {
		const triggerTokens = computeCompactTrigger(sourceContextWindow, computeSummarizeBudget(), triggerOptions)
		if (sourceContextWindow <= 0 || !shouldCompactProjectedUsage(currentTokens, triggerTokens)) {
			return
		}
		const history = this.messageStateHandler.apiConversationHistory
		const nextRange = this.contextManager.getNextTruncationRange(
			history,
			this.taskState.conversationHistoryDeletedRange,
			"none",
		)
		if (nextRange[1] < nextRange[0]) return
		const currentRange = this.taskState.conversationHistoryDeletedRange
		if (currentRange?.[0] === nextRange[0] && currentRange[1] === nextRange[1]) return
		this.taskState.conversationHistoryDeletedRange = nextRange
		await this.messageStateHandler.updateTaskHistory()
		await this.contextManager.triggerApplyStandardContextTruncationNoticeChange(
			Date.now(),
			await ensureTaskDirectoryExists(this.taskId),
			history,
		)
	}

	/** Merge a confirmation-owned draft into the first target-mode request. */
	private async consumeModeSwitchChatContent(userContent: ClineContent[]): Promise<ClineContent[]> {
		const chatContent = this.modeSwitchCompaction.takeChatContent()
		if (!chatContent) return userContent
		const hasContent = Boolean(chatContent.message || chatContent.images?.length || chatContent.files?.length)
		if (!hasContent) return userContent
		await this.say("user_feedback", chatContent.message ?? "", chatContent.images, chatContent.files)
		return [...userContent, ...(await buildUserFeedbackContent(chatContent.message, chatContent.images, chatContent.files))]
	}

	/**
	 * Wait for an automatic retry delay while allowing the Webview to trigger it
	 * immediately. The same primitive is used by first-chunk and no-response
	 * retries so manual Retry cannot race a second timer.
	 */
	private waitForAutoRetry(delay: number): Promise<boolean> {
		// A new wait replaces only an obsolete timer. Do not publish the transient
		// empty state: the retry sequence must remain represented in the footer.
		this.cancelPendingAutoRetry(false)
		this.autoRetrySequenceActive = true
		return new Promise<boolean>((resolve) => {
			let settled = false
			let timer: NodeJS.Timeout
			const settle = (allowed: boolean, publish = true): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (!allowed) {
					this.autoRetrySequenceActive = false
				}
				if (this.pendingAutoRetry?.settle === settle) {
					this.pendingAutoRetry = undefined
					if (publish) this.postAutoRetryViewState()
				}
				resolve(allowed)
			}
			timer = setTimeout(() => settle(!this.taskState.abort), Math.max(0, delay))
			this.pendingAutoRetry = { settle }
			this.postAutoRetryViewState()
		})
	}

	/** Publish only the footer state change owned by the retry timer. */
	private postAutoRetryViewState(): void {
		void this.postStateToWebview().catch((error) => {
			Logger.error(`[Task ${this.taskId}] Failed to publish automatic retry state:`, error)
		})
	}

	/** End the whole automatic-retry sequence and optionally publish its footer state. */
	private endAutoRetrySequence(publish = true): void {
		const pending = this.pendingAutoRetry
		const wasActive = this.autoRetrySequenceActive || pending !== undefined
		this.autoRetrySequenceActive = false
		if (pending) {
			pending.settle(false, publish)
		} else if (wasActive && publish) {
			this.postAutoRetryViewState()
		}
	}

	/** Remove obsolete automatic-retry cards after a provider request recovers. */
	private async clearAutoRetryMessages(): Promise<void> {
		const retryMessageTimestamps = this.messageStateHandler.clineMessages
			.filter((message) => message.type === "say" && message.say === "error_retry")
			.map((message) => message.ts)
		await this.messageStateHandler.removeMessagesByTs(retryMessageTimestamps)
	}

	/** Mark the latest automatic-retry card as exhausted before opening manual recovery. */
	private async markAutoRetryExhausted(errorMessage: string): Promise<void> {
		const retryMessageIndex = findLastIndex(
			this.messageStateHandler.clineMessages,
			(message) => message.type === "say" && message.say === "error_retry",
		)
		if (retryMessageIndex === -1) return
		const retryMessage = this.messageStateHandler.clineMessages[retryMessageIndex]
		let retryInfo: Record<string, unknown> = {}
		try {
			retryInfo = JSON.parse(retryMessage.text || "{}") as Record<string, unknown>
		} catch {
			retryInfo = {}
		}
		await this.messageStateHandler.updateClineMessage(retryMessageIndex, {
			text: JSON.stringify({
				...retryInfo,
				attempt: MAX_AUTO_RETRY_ATTEMPTS,
				maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
				delaySeconds: 0,
				failed: true,
				errorMessage,
			}),
		})
		await this.messageStateHandler.flushMessageUpdate(retryMessageIndex)
	}

	/** Cancel a delayed retry as part of task cancellation or termination. */
	private cancelPendingAutoRetry(publish = true): void {
		this.endAutoRetrySequence(publish)
	}

	/** Return whether the live task footer can override a scheduled retry. */
	public hasPendingAutoRetry(): boolean {
		return this.pendingAutoRetry !== undefined && !this.taskState.abort
	}

	/** Return whether the complete automatic retry sequence still owns the footer. */
	public hasAutoRetrySequence(): boolean {
		return this.autoRetrySequenceActive && !this.taskState.abort
	}

	/** Transfer one automatic retry sequence to explicit user control. */
	public overridePendingAutoRetry(): boolean {
		if (!this.autoRetrySequenceActive || this.taskState.abort) return false
		this.manualRetryTakeoverActive = true
		const pending = this.pendingAutoRetry
		if (pending) {
			pending.settle(true, false)
		}
		this.autoRetrySequenceActive = false
		this.postAutoRetryViewState()
		return true
	}

	/** Observe whether explicit user control owns the current retry sequence. */
	private hasManualRetryTakeover(): boolean {
		return this.manualRetryTakeoverActive
	}

	/** Consume the one-shot manual takeover at the canonical retry decision boundary. */
	private consumeManualRetryTakeover(): boolean {
		const active = this.manualRetryTakeoverActive
		this.manualRetryTakeoverActive = false
		return active
	}

	/** Schedule a retry that can be superseded by the explicit Retry action. */
	private scheduleAutoRetry(delay: number, isCurrentTask: () => boolean, dispatchRetry: () => Promise<void>): void {
		void this.waitForAutoRetry(delay).then(async (allowed) => {
			if (!allowed || this.taskState.abort) return
			if (!isCurrentTask()) {
				this.endAutoRetrySequence()
				return
			}
			try {
				await dispatchRetry()
			} catch (error) {
				this.endAutoRetrySequence()
				Logger.error(`[Task ${this.taskId}] Automatic retry dispatch failed:`, error)
			}
		})
	}

	/** Start a canonical compaction replay only after the failed stream has fully released its request lifecycle. */
	private scheduleCompactionReplay(apiIndex: number): void {
		void pWaitFor(() => !this.taskState.isStreaming, { interval: 10, timeout: 10_000 })
			.then(async () => {
				if (this.controller.task !== this || this.taskState.abort) return
				const retried = await this.dispatchRuntime({ type: "API_RETRY_SCHEDULED", apiIndex })
				if (!retried.accepted) {
					throw new Error(`Compaction replay rejected: ${retried.error?.code ?? "invalid_runtime_event"}`)
				}
			})
			.catch((error) => {
				Logger.error(`[Task ${this.taskId}] Compaction replay dispatch failed:`, error)
			})
	}

	/** Schedule the next attempt owned exclusively by the immutable fitting Pass. */
	private scheduleFittingPassRetry(
		delay: number,
		apiIndex: number,
		passIdentity: ReturnType<typeof getCompactionPassIdentity>,
	): void {
		const taskId = this.taskId
		const signal = this.taskState.operationSignal
		void new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason)
				return
			}
			const timer = setTimeout(resolve, delay)
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer)
					reject(signal.reason)
				},
				{ once: true },
			)
		})
			.then(() => pWaitFor(() => !this.taskState.isStreaming, { interval: 10, timeout: 10_000 }))
			.then(async () => {
				if (this.controller.task?.taskId !== taskId || this.taskState.abort) return
				if (!this.compactionRequestReplay.isActivePass(apiIndex, passIdentity)) return
				const retried = await this.dispatchRuntime({ type: "API_RETRY_SCHEDULED", apiIndex })
				if (!retried.accepted) {
					throw new Error(`Fitting Pass retry rejected: ${retried.error?.code ?? "invalid_runtime_event"}`)
				}
			})
			.catch((error) => {
				if (signal.aborted) return
				Logger.error(`[Task ${this.taskId}] Fitting Pass retry dispatch failed:`, error)
			})
	}

	/** Continue Task-owned recovery after an automatic compaction attempt has been fully discarded. */
	private async recoverAutomaticCompactionFailure(
		apiIndex: number,
		errorMessage: string,
		requestScope: RequestApiScope,
		retryContent: ClineContent[],
	): Promise<void> {
		const fittingState = this.taskState.targetWindowFittingState
		if (fittingState) {
			const passIdentity = getCompactionPassIdentity(fittingState)
			const retryDecision = this.compactionRetryPolicy.registerFailure(passIdentity)
			if (retryDecision.action === "retry") {
				await this.updateContextCompactionStatus("retrying", {
					error: errorMessage,
					retryAttempt: retryDecision.retryAttempt,
					maxRetryAttempts: retryDecision.maxRetryAttempts,
					clearContent: true,
				})
				const delay = getRetryDelay(retryDecision.retryAttempt)
				this.scheduleFittingPassRetry(delay, apiIndex, passIdentity)
				requestScope.explicitInstructions.close()
				return
			}

			await this.updateContextCompactionStatus("failed", { error: errorMessage })
			this.taskState.forceTruncateAvailable = true
			this.compactionRetryPolicy.reset()
			this.manualRetryTakeoverActive = false
			this.endAutoRetrySequence(false)
			const retryId = `retry:${this.taskId}:${this.getRuntimeState().revision}`
			await this.recoverApiFailure({
				turnId: retryId,
				interactionId: retryId,
				apiIndex,
				presentation: errorMessage,
				persistedRequest: false,
				retryContent: cloneDeep(retryContent),
			})
			return
		}

		const manualRetryTakeover = this.consumeManualRetryTakeover()
		const retryDecision = getStreamRetryDecision({
			isSpendLimitError: false,
			autoRetryAttempts: manualRetryTakeover ? MAX_AUTO_RETRY_ATTEMPTS : this.taskState.autoRetryAttempts,
		})
		if (retryDecision.shouldRetry) {
			this.taskState.autoRetryAttempts++
			await this.updateContextCompactionStatus("retrying", {
				error: errorMessage,
				retryAttempt: this.taskState.autoRetryAttempts,
				maxRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS,
				clearContent: true,
			})
			const delay = getRetryDelay(this.taskState.autoRetryAttempts)
			await this.say(
				"error_retry",
				JSON.stringify({
					attempt: this.taskState.autoRetryAttempts,
					maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
					delaySeconds: delay / 1000,
					errorMessage,
				}),
			)
			const taskId = this.taskId
			const retryAttempts = this.taskState.autoRetryAttempts
			this.scheduleAutoRetry(
				delay,
				() => this.controller.task?.taskId === taskId,
				async () => {
					const activeTask = this.controller.task
					if (!activeTask) return
					activeTask.taskState.autoRetryAttempts = retryAttempts
					const retried = await activeTask.dispatchRuntime({ type: "API_RETRY_SCHEDULED", apiIndex })
					if (!retried.accepted) {
						throw new Error(`Automatic compaction retry rejected: ${retried.error?.code ?? "invalid_runtime_event"}`)
					}
				},
			)
			requestScope.explicitInstructions.close()
			return
		}

		await this.updateContextCompactionStatus("failed", { error: errorMessage })
		this.taskState.forceTruncateAvailable = true
		if (!manualRetryTakeover && this.taskState.autoRetryAttempts >= MAX_AUTO_RETRY_ATTEMPTS) {
			await this.markAutoRetryExhausted(errorMessage)
		}
		this.endAutoRetrySequence(false)
		const retryId = `retry:${this.taskId}:${this.getRuntimeState().revision}`
		await this.recoverApiFailure({
			turnId: retryId,
			interactionId: retryId,
			apiIndex,
			presentation: errorMessage,
			persistedRequest: false,
			retryContent: cloneDeep(retryContent),
		})
	}

	async handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[], files?: string[]) {
		const hasFeedback = Boolean(text) || Boolean(images?.length) || Boolean(files?.length)
		const runtimeState = this.taskRuntime.getState()
		const isProfileRecoveryInput =
			askResponse === "messageResponse" &&
			hasFeedback &&
			!runtimeState.interaction &&
			runtimeState.ordinaryInput?.kind === "profile_recovery"
		if (isProfileRecoveryInput) {
			const content = await buildUserFeedbackContent(text, images, files)
			const claimed = await this.dispatchRuntime({
				type: "PROFILE_RECOVERY_INPUT_RECEIVED",
				draft: { text: text ?? "", images: images ?? [], files: files ?? [] },
			})
			if (!claimed.accepted) {
				Logger.warn(`[Task ${this.taskId}] Profile recovery input claim was rejected.`)
				return
			}
			this.taskState.userMessageContent.push(...content)
			this.taskState.userMessageContentReady = true
			return
		}

		// Nothing was waiting for this response. Recording it anyway would put
		// the text into the conversation as user feedback and leave it parked
		// for the next unrelated question to consume. Input that arrives while
		// the task is working belongs in the input queue, which delivers it at
		// a tool round or turn end.
		if (!this.taskController.resolveAsk(askResponse, text, images, files)) {
			// Refused rather than stored: with nothing waiting, keeping it would
			// let it answer whatever question is asked next. The reason a
			// no ask was listening still needs to be recoverable from the log.
			// Both lookups are optional: this path is already anomalous, and a
			// diagnostic that threw would replace the report with its own failure.
			Logger.warn(
				formatUnroutedAskResponse({
					taskId: this.taskId,
					response: askResponse,
					text,
					images,
					files,
					messageCount: this.messageStateHandler?.clineMessages?.length ?? -1,
					phase: this.taskRuntime?.getState?.()?.phase ?? "unknown",
				}),
			)
			return
		}
		const activeBlock = this.taskController.getActiveBlock()
		const isConversationalResponse = Boolean(
			activeBlock && CONVERSATIONAL_TOOL_NAMES.has(activeBlock.toolName as ClineDefaultTool),
		)
		if (hasFeedback) {
			await this.say("user_feedback", text, images, files)
			this.taskState.ackedFeedback = { response: askResponse, text, images, files }
			const runtimeInteraction = this.taskRuntime.getState().interaction
			if (!activeBlock && !isConversationalResponse && !runtimeInteraction && askResponse === "messageResponse") {
				this.taskState.userMessageContent.push(...(await buildUserFeedbackContent(text, images, files)))
				this.taskState.userMessageContentReady = true
			}
		}

		// Conversational tools (qna_respond, make_plan, etc.) handle
		// user responses internally via their handler's ask(). The block phase
		// machine must NOT treat messageResponse as a rejection for these tools,
		// otherwise subsequent conversational tools in the same turn get
		// cascaded SKIPPED and the task loop deadlocks.
		if (activeBlock && CONVERSATIONAL_TOOL_NAMES.has(activeBlock.toolName as ClineDefaultTool)) {
			return
		}

		// Update the approval state machine based on the user's response
		if (askResponse === "noButtonClicked" || askResponse === "messageResponse") {
			const rejected = this.taskController.rejectActiveBlock()
			if (rejected) {
				this.taskController.transitionRequired(TaskPhase.BETWEEN_TURNS, {
					apiIndex: rejected.conversationHistoryIndex,
				})
				await this.flushTaskSnapshot()
				await this.postStateToWebview()
			}
		} else if (askResponse === "yesButtonClicked") {
			const executing = this.taskController.completeActiveBlock()
			if (executing) {
				this.taskController.transitionRequired(TaskPhase.EXECUTING, {
					apiIndex: executing.conversationHistoryIndex,
					execution: {
						mode: this.isParallelToolCallingEnabled() ? "parallel" : "serial",
						executingFunctionIds: [executing.functionId],
						executingDlineTids: [executing.dlineTid],
					},
				})
				await this.flushTaskSnapshot()
				await this.postStateToWebview()
			}
		}
	}

	/** Monotonic message ts generator to avoid same-ms collisions */
	private lastGeneratedMessageTs = 0

	/**
	 * Generate a unique message timestamp (ms). Guarantees monotonic increase
	 * for all ClineMessage.ts values while preserving millisecond semantics.
	 */
	private genMessageTs(): number {
		const maxExistingTs = this.messageStateHandler.clineMessages.reduce((max, m) => Math.max(max, m.ts), 0)
		const currentMax = Math.max(maxExistingTs, this.taskState.lastMessageTs ?? 0, this.lastGeneratedMessageTs)
		const ts = Math.max(Date.now(), currentMax + 1)
		this.lastGeneratedMessageTs = ts
		return ts
	}

	/**
	 * Add or update a "say" message in the chat.
	 *
	 * @param type The type of the message (ClineSay)
	 * @param text The message text (optional)
	 * @param images Image URIs (optional)
	 * @param files File paths (optional)
	 * @param partial Whether this message is a partial/streaming update (optional)
	 * @param existingTs If provided, update the existing message with this ts instead of adding a new one
	 * @returns The ts of the added or updated message, or undefined if updated in place
	 */
	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		existingTs?: number,
		commandTs?: number,
	): Promise<number | undefined> {
		return this.taskController.say(type, text, images, files, partial, existingTs, commandTs)
	}

	async sayAndCreateMissingParamError(toolName: ClineDefaultTool, paramName: string, relPath?: string, existingTs?: number) {
		await this.say(
			"error",
			`Dline tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
			undefined,
			undefined,
			false,
			existingTs,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	/**
	 * Persist a task state snapshot to snapshot.json only.
	 * Called only by the canonical runtime persistence effect.
	 *
	 * The reducer classifies each transition: a coalesced one is handed to the
	 * persistence layer without forcing a write, so a turn with many blocks no
	 * longer pays one durable write per block inside the runtime queue.
	 */
	private async emitStateSnapshot(
		snapshot: TaskSnapshot,
		durability: SnapshotDurability = "flushed",
		origin?: ProjectionEffectOrigin,
	): Promise<void> {
		this.latestTaskSnapshot = snapshot
		await this.projectionScheduler.persistSnapshot(snapshot, durability, origin)
		// The history projection is only reconciled once the snapshot it mirrors is
		// durable, so a coalesced transition defers it to the next barrier rather
		// than publishing a projection ahead of the state it claims to reflect.
		if (durability !== "flushed") return
		if (await this.syncTaskCompletionProjection(snapshot)) {
			await this.postStateToWebview({ immediate: true })
		}
	}

	/** Synchronize the durable history projection from one already persisted canonical snapshot. */
	private async syncTaskCompletionProjection(snapshot: TaskSnapshot): Promise<boolean> {
		if (snapshot.revision === undefined) return false
		return await this.completionProjector.sync({
			phase: snapshot.phase,
			revision: snapshot.revision,
			completion: snapshot.completion,
		})
	}

	/**
	 * Atomically writes the latest task snapshot to snapshot.json.
	 * @param snapshot Snapshot generated by the task phase machine.
	 */
	private async writeTaskSnapshot(snapshot: TaskSnapshot): Promise<void> {
		this.latestTaskSnapshot = snapshot
		// The queue is user-owned input, not runtime state: it is attached here
		// rather than in createSnapshot so the runtime round-trip contract
		// (hydrate(create(state)) === state) stays exact.
		//
		// The committed projection is used instead of reading the queue live,
		// because an unrelated runtime snapshot can be written while a queue
		// section is mid-transaction. Persisting that intermediate state would
		// survive a rollback and leave the file contradicting memory.
		//
		// Before the queue is known, the value already on the snapshot is kept:
		// this write is about runtime state and has no business deciding that
		// the user's retained input is gone.
		//
		// Resolved before the first await: a write that yields here would
		// otherwise pick up a projection published by a transaction that has
		// not finished, and a later rollback could not take it back off disk.
		const decision = this.inputQueueCoordinator.resolveSnapshotWrite(snapshot.inputQueue)
		const taskDir = await ensureTaskDirectoryExists(this.taskId)
		const snapshotPath = path.join(taskDir, GlobalFileNames.taskSnapshot)
		const tmpPath = `${snapshotPath}.tmp.${Date.now()}`
		let persisted: TaskSnapshot
		if (decision.kind === "write") {
			persisted = { ...snapshot, inputQueue: decision.entries }
		} else {
			const existing = await this.readPersistedInputQueue(snapshotPath)
			if (!existing.readable) {
				// Still unreadable, so what the file holds is still unknown.
				// Replacing it now would delete input on the strength of a read
				// that never succeeded, which is exactly what preserving is for.
				// The runtime part of this snapshot is recoverable; the user's
				// text is not.
				Logger.error("[inputQueue] Snapshot write skipped: the queue on disk could not be read back")
				this.inputQueueCoordinator.recordSnapshotWriteOutcome("failed")
				return
			}
			persisted = { ...snapshot, inputQueue: existing.entries }
		}
		await fs.writeFile(tmpPath, JSON.stringify(persisted, null, 2), "utf8")
		await renameTaskSnapshotWithRetry(tmpPath, snapshotPath)
		// A preserve keeps the queue that was already on disk, so the change the
		// ticket carries is not there. Saying "written" would let a delivery
		// treat a missing in-flight mark as a durable one.
		this.inputQueueCoordinator.recordSnapshotWriteOutcome(decision.kind === "write" ? "written" : "preserved")
	}

	/**
	 * Re-read only the queue field from the snapshot that is being replaced.
	 *
	 * Used when this task could not load the queue: the file may still hold
	 * input, and rewriting the snapshot without it would delete input the user
	 * never removed. A second failure leaves the field out, which is no worse
	 * than the write that was already going to happen.
	 */
	private async readPersistedInputQueue(
		snapshotPath: string,
	): Promise<{ readable: true; entries: QueuedInputEntry[] | undefined } | { readable: false }> {
		try {
			const raw = await fs.readFile(snapshotPath, "utf8")
			const existing = normalizeLegacyTaskSnapshot(JSON.parse(raw))
			return { readable: true, entries: existing.inputQueue }
		} catch (error) {
			// A missing file holds nothing to protect, so the write may proceed
			// with no queue. Any other failure leaves the contents unknown.
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
				return { readable: true, entries: undefined }
			}
			return { readable: false }
		}
	}

	/**
	 * Loads snapshot.json into memory for snapshot-first history restoration.
	 * @returns The parsed task snapshot, or undefined when absent or invalid.
	 */
	private async loadTaskSnapshot(): Promise<TaskSnapshot | undefined> {
		// Reading and applying run as one section. A reload can reach a task
		// that is already running, and a read taken before a concurrent change
		// would otherwise be applied after it, silently undoing input the user
		// has already been told was saved.
		return this.inputQueueCoordinator.runExclusive(async () => {
			try {
				const taskDir = await ensureTaskDirectoryExists(this.taskId)
				const snapshotPath = path.join(taskDir, GlobalFileNames.taskSnapshot)
				const raw = await fs.readFile(snapshotPath, "utf8")
				const snapshot = normalizeLegacyTaskSnapshot(JSON.parse(raw))
				this.latestTaskSnapshot = snapshot
				// Restore retained input so a resumed task keeps everything the
				// user queued before the task was paused, cancelled or reloaded.
				this.inputQueueCoordinator.adoptPersisted(snapshot.inputQueue)
				if (this.inputQueueCoordinator.droppedInFlightCount > 0) {
					// The user will not see this input again, so the reason has
					// to be recoverable rather than silent.
					Logger.warn(
						`[inputQueue] Dropped ${this.inputQueueCoordinator.droppedInFlightCount} queued input(s) that were mid-delivery when the task stopped; they may already have reached the model`,
					)
				}
				return snapshot
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code
				if (code === "ENOENT") {
					this.inputQueueCoordinator.markQueueAbsent()
				} else {
					this.inputQueueCoordinator.markQueueUnreadable()
					Logger.error("[loadTaskSnapshot] Failed to read task snapshot:", error)
				}
				return undefined
			}
		})
	}

	/**
	 * Project the retained input queue for the Webview.
	 *
	 * Uses the user-visible list rather than the persisted projection: an entry
	 * already claimed for delivery must not be offered for editing or removal.
	 */
	public getInputQueueSnapshot(): QueuedInputEntry[] {
		return this.inputQueueCoordinator.snapshot()
	}

	/**
	 * Apply one user-driven queue change, then persist and publish it.
	 *
	 * The queue is the authoritative copy of everything the user typed while the
	 * task was busy, so a change is written to disk before it is announced. When
	 * the write fails the caller is told so rather than being shown an entry
	 * that a reload would drop.
	 */
	public async mutateInputQueue(mutation: InputQueueMutation): Promise<InputQueueMutationResult> {
		const result = await this.inputQueueCoordinator.mutate(mutation)
		if (result.accepted && this.awaitingQueuedInputInteraction) {
			// The awaiting callback may have checked an empty queue just before this
			// mutation committed. Retrying here closes that ordering gap; the queue
			// coordinator serializes claims and keeps delivery at-most-once.
			void this.inputQueueCoordinator.deliverAtTurnEnd()
		}
		return result
	}

	/**
	 * Answer a durable turn-end interaction with retained input, if any is due.
	 *
	 * Delivering through the interaction response path rather than say() is what
	 * makes the text reach the model: the waiting tool handler turns the response
	 * into that tool call's result, so the queued text arrives paired with the
	 * call it answers instead of as an orphaned block.
	 */
	private async answerTurnEndWithQueuedInput(delivery: QueueDelivery): Promise<boolean> {
		const awaiting = this.awaitingQueuedInputInteraction
		if (!awaiting) {
			// Nothing is waiting for an answer, so this batch has nowhere to go.
			// Reporting it as undelivered returns it to the queue.
			return false
		}
		const modelBlocks = this.renderQueuedInputBlocks(delivery)
		const result = await this.dispatchRuntime({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: this.taskId,
				turnId: awaiting.turnId,
				interactionId: awaiting.interactionId,
				actionId: "reply",
				stateRevision: this.taskRuntime.getState().revision,
				draft: {
					text: modelBlocks.join("\n\n"),
					images: [...delivery.images],
					files: [...delivery.files],
				},
				presentationDraft: {
					text: delivery.entries.map((entry) => entry.text).join("\n\n"),
					images: [...delivery.images],
					files: [...delivery.files],
				},
				userInputKind: "queued",
				queuedInputMode: delivery.kind,
			},
		})
		if (this.awaitingQueuedInputInteraction === awaiting) {
			this.awaitingQueuedInputInteraction = undefined
		}
		if (!result.accepted) {
			Logger.warn(`[inputQueue] Turn-end delivery rejected: ${result.error?.code ?? "unknown"}`)
		}
		return result.accepted
	}

	/**
	 * Add a claimed batch to the request being assembled.
	 *
	 * The task is not waiting for the user here, so the text is added to the
	 * next request as its own user message rather than as a tool result.
	 */
	private async stageToolRoundQueuedInput(delivery: QueueDelivery): Promise<void> {
		// Built in full before anything is appended. Pushing as we go would
		// leave the guidance and the first blocks in the request if a later
		// step threw: the entry would then be sent with this round and put
		// back in the queue to be sent again.
		const staged: ClineContent[] = []
		// Each entry becomes its own complete model-only XML block. Passing the
		// batch through buildUserFeedbackContent would merge the entries and lose
		// their individual boundaries.
		for (const block of this.renderQueuedInputBlocks(delivery)) {
			staged.push({ type: "text", text: block })
		}
		if (delivery.images.length > 0) {
			staged.push(...formatResponse.imageBlocks([...delivery.images]))
		}
		if (delivery.files.length > 0) {
			const fileContent = await processFilesIntoText([...delivery.files])
			if (fileContent) {
				staged.push({ type: "text", text: fileContent })
			}
		}
		this.taskState.userMessageContent.push(...staged)
	}

	/** Persist a pure user-facing QueueInput row after a staged request became durable. */
	private async presentDeliveredQueuedInput(delivery: QueueDelivery): Promise<void> {
		await this.taskController.channel.presentSay(
			"user_feedback",
			delivery.entries.map((entry) => entry.text).join("\n\n"),
			[...delivery.images],
			[...delivery.files],
			`input-queue:${delivery.entries.map((entry) => entry.id).join(",")}`,
			"queued",
			delivery.kind,
		)
	}

	/** Build complete model-only XML blocks while retaining pure user data for UI history. */
	private renderQueuedInputBlocks(delivery: QueueDelivery): string[] {
		const description = this.escapeXmlAttribute(this.getQueuedInputGuidance())
		return delivery.blocks.map((block) => `<user_message description="${description}">\n${block}\n</user_message>`)
	}

	/** Escape text embedded in a double-quoted XML attribute. */
	private escapeXmlAttribute(value: string): string {
		return value
			.replace(/&/g, "&amp;")
			.replace(/"/g, "&quot;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/'/g, "&apos;")
	}

	/** Render the versioned internal queue guidance in English. */
	private getQueuedInputGuidance(): string {
		return getPrompt("inputQueue", "auxiliaryAlignmentV1", "en")
	}

	/**
	 * Discard or reclaim the staged tool-round batch once its fate is known.
	 *
	 * @param delivered whether the input reached the durable conversation. A
	 * round that ended before sending never delivered it, so the input returns
	 * to the queue instead of being silently consumed.
	 */
	private async settleStagedQueueDelivery(delivered: boolean): Promise<void> {
		await this.inputQueueCoordinator.settleStagedDelivery(delivered)
	}

	/**
	 * Rewrite snapshot.json so the queue on disk matches memory.
	 *
	 * A queue change produces no runtime event, so nothing else would schedule a
	 * snapshot. The latest runtime snapshot is reused unchanged; writeTaskSnapshot
	 * attaches the current queue to whatever it is given.
	 *
	 * Before the first runtime snapshot exists there is nothing cached, but the
	 * composer already routes a blocked send to the queue. A baseline is derived
	 * from current runtime state instead of skipping the write, so input queued
	 * in that early window is not lost if the task never reaches its first
	 * runtime persist.
	 *
	 * The write goes through the same persistence chain as runtime snapshots.
	 * Writing directly would let a queue change carrying an older cached runtime
	 * snapshot land after a newer runtime write and roll the file back.
	 *
	 * Rejects when the write fails; the coordinator decides what that means for
	 * the change it was carrying.
	 *
	 * Every flush serializes on the shared write chain and rewrites the whole
	 * snapshot, so each call is expensive for a large task. The wait is still
	 * required: the queue coordinator decides whether to roll a change back by
	 * checking that this write actually reached the file, so a coalesced write
	 * would report a change as lost while it was merely still pending.
	 */
	private async persistInputQueue(): Promise<void> {
		// A fresh object per call, never the cached instance. The persistence
		// chain clears its pending slot by identity, so scheduling the same
		// object twice would let the first write erase the second request and
		// leave the newer queue unwritten.
		const snapshot: TaskSnapshot = { ...(this.latestTaskSnapshot ?? createSnapshot(this.taskRuntime.getState())) }
		this.snapshotPersistence.schedule(snapshot)
		await this.snapshotPersistence.flushNow()
	}

	/**
	 * Forces any pending snapshot.json update to disk before a critical lifecycle boundary.
	 */
	private async flushTaskSnapshot(): Promise<void> {
		try {
			await this.snapshotPersistence.flushNow()
		} catch (error) {
			Logger.error("[flushTaskSnapshot] Failed to persist task snapshot:", error)
		}
	}

	/** Synchronize retained phase machines from one already validated runtime aggregate. */
	private syncRetainedMachines(includeTaskPhase = true): void {
		const state = this.taskRuntime.getState()
		if (includeTaskPhase) {
			this.taskController.restoreFrom(createSnapshot(state))
		}
		if (state.turn) {
			this.taskController.restoreTurnFromSnapshot(
				state.turn.blocks.map((block) => ({ ...block })),
				state.turn.activeDlineTid,
			)
		}
	}

	/** Build resume input from a usable snapshot plus the complete persisted histories. */
	private async loadResumeInput(): Promise<ResumeInput> {
		await this.snapshotPersistence.flushNow()
		const snapshot = await this.loadTaskSnapshot()
		const uiHistory = this.messageStateHandler.clineMessages
		const apiHistory = this.messageStateHandler.apiConversationHistory
		const apiTailStartIndex = snapshot ? Math.max(0, snapshot.apiIndex + 1) : 0
		return {
			taskId: this.taskId,
			snapshot,
			uiTail: snapshot ? selectResumeUiTail(snapshot, uiHistory) : uiHistory,
			apiTail: apiHistory.slice(apiTailStartIndex),
			apiTailStartIndex,
			apiHistoryLength: apiHistory.length,
			uiHistory,
			apiHistory,
		}
	}

	/** Register a durable ask row for a Resume/Completion interaction synthesized from history. */
	private presentSynthesizedHistoryInteraction(snapshot: TaskSnapshot): Promise<void> {
		const interaction = snapshot.interaction
		if (!interaction || interaction.anchor || interaction.status !== "opening") return Promise.resolve()

		let presentation = ""
		let existingTs: number | undefined
		if (interaction.kind === "completion") {
			const lifecycle = snapshot.turn?.blocks.find((block) => block.dlineTid === interaction.interactionId)
			if (lifecycle) {
				const block = this.findRestoredTurnEndBlock(
					interaction.interactionId,
					lifecycle.ts,
					snapshot.turn?.assistantApiIndex,
				)
				presentation = block.params.result ?? ""
				existingTs = lifecycle.ts
			}
		}

		const registered = this.taskController.channel.beginSynthesizedHistoryAsk(
			getInteraction(interaction.kind).taskAsk,
			presentation,
			existingTs,
			interaction.interactionId,
		)
		const messageTs = registered.askTs
		interaction.status = "awaiting"
		interaction.anchor = { messageTs, messageType: "ask" }
		snapshot.anchor = {
			...(snapshot.anchor ?? { apiIndex: snapshot.apiIndex }),
			uiMessageTs: messageTs,
			turnId: interaction.turnId,
			interactionId: interaction.interactionId,
		}
		snapshot.timestamp = Date.now()
		return registered.persistence
	}

	/** Locate the original turn-end block from runtime memory or canonical persisted assistant history. */
	private findRestoredTurnEndBlock(interactionId: string, messageTs: number, assistantApiIndex?: number): ToolUse {
		if (assistantApiIndex !== undefined) {
			const message = this.messageStateHandler.apiConversationHistory[assistantApiIndex]
			const matchingBlocks =
				message?.role === "assistant" && Array.isArray(message.content)
					? message.content.filter(
							(candidate): candidate is ClineAssistantToolUseBlock =>
								candidate.type === "tool_use" && candidate.dline_tid === interactionId,
						)
					: []
			if (matchingBlocks.length !== 1) {
				throw new Error(matchingBlocks.length === 0 ? "resume_turn_end_block_missing" : "resume_turn_end_block_ambiguous")
			}
			return this.restoreHandler.storedToRuntime(matchingBlocks[0], messageTs)
		}

		const runtimeBlock = this.taskState.assistantMessageContent.find(
			(candidate): candidate is ToolUse => candidate.type === "tool_use" && candidate.dline_tid === interactionId,
		)
		if (runtimeBlock) return runtimeBlock

		const storedBlock = this.messageStateHandler.apiConversationHistory
			.flatMap((message) => (message.role === "assistant" && Array.isArray(message.content) ? message.content : []))
			.find(
				(candidate): candidate is ClineAssistantToolUseBlock =>
					candidate.type === "tool_use" && candidate.dline_tid === interactionId,
			)
		if (!storedBlock) throw new Error("resume_turn_end_block_missing")
		return this.restoreHandler.storedToRuntime(storedBlock, messageTs)
	}

	/** Rebuild every tool block from the exact assistant message owned by a restored runtime turn. */
	private restoredTurnToolBlocks(turn: NonNullable<TaskRuntimeState["turn"]>): ToolUse[] {
		const message = this.messageStateHandler.apiConversationHistory[turn.assistantApiIndex]
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			throw new Error("resume_assistant_turn_missing")
		}
		const stored = message.content.filter(
			(candidate): candidate is ClineAssistantToolUseBlock => candidate.type === "tool_use",
		)
		if (stored.length !== turn.blocks.length) throw new Error("resume_turn_tool_count_mismatch")
		return turn.blocks.map((lifecycle) => {
			const matches = stored.filter(
				(candidate) => candidate.dline_tid === lifecycle.dlineTid && candidate.function_id === lifecycle.functionId,
			)
			const [match] = matches
			if (!match || matches.length !== 1) throw new Error("resume_turn_tool_identity_mismatch")
			return this.restoreHandler.storedToRuntime(match, lifecycle.ts)
		})
	}

	/** Wait until a Task Header compaction has committed and cleared its request classification flags. */
	private async waitForTaskHeaderCompactionSettlement(): Promise<void> {
		const settlement = this.taskHeaderCompactionSettlement
		if (settlement) await settlement
	}

	/** Consume one history-only interaction after its causal response has been durably accepted. */
	private async continueRestoredInteraction(context: DetachedInteractionContinuationContext): Promise<void> {
		try {
			if (!context.isCurrent() || this.controllerDetached) return
			await this.waitForTaskHeaderCompactionSettlement()
			if (!context.isCurrent() || this.controllerDetached) return
			const state = this.taskRuntime.getState()
			if (context.interaction.kind === "hosted_web_approval") {
				const apiIndex = hostedWebApprovalApiIndex(this.taskId, context.interaction.interactionId)
				if (apiIndex === undefined || apiIndex !== state.anchor.apiIndex) {
					throw new Error("resume_hosted_web_request_identity_mismatch")
				}
				if (context.outcome.actionId === "reject") {
					await context.resolve()
					return
				}
				const continued = await this.dispatchRuntime({
					type: "HOSTED_WEB_REQUEST_CONTINUATION_REQUESTED",
					interactionId: context.interaction.interactionId,
					apiIndex,
				})
				if (!continued.accepted) throw new Error("resume_hosted_web_request_rejected")
				return
			}
			const turn = state.turn
			if (!turn) throw new Error(`resume_turn_missing: interaction=${context.interaction.turnId}`)
			if (turn.turnId !== context.interaction.turnId) {
				throw new Error(
					`resume_turn_identity_mismatch: runtime=${turn.turnId}, interaction=${context.interaction.turnId}`,
				)
			}
			let lifecycle = turn.blocks.find((candidate) => candidate.dlineTid === context.interaction.interactionId)
			if (!lifecycle) throw new Error("resume_interaction_block_missing")
			const blocks = this.restoredTurnToolBlocks(turn)
			const block = blocks.find((candidate) => candidate.dline_tid === lifecycle?.dlineTid)
			if (!block || block.function_id !== lifecycle.functionId) throw new Error("resume_interaction_block_mismatch")

			this.taskState.resetOperationCancellation()
			this.taskState.abort = false
			this.taskState.userMessageContent = collectResumeTurnContent({
				blocks: turn.blocks,
				assistantApiIndex: turn.assistantApiIndex,
				apiHistory: this.messageStateHandler.apiConversationHistory,
				uiHistory: this.messageStateHandler.clineMessages,
				pendingContent: [],
				synthesizeMissing: "terminal_only",
				deferMissingDlineTids: [context.interaction.interactionId],
			})
			this.taskState.assistantMessageContent = blocks
			this.taskState.didCompleteReadingStream = true

			if (lifecycle.phase === BlockPhase.AWAITING_APPROVAL) {
				const started = await this.dispatchRuntime({
					type: "BLOCK_APPROVED",
					turnId: turn.turnId,
					dlineTid: lifecycle.dlineTid,
				})
				if (!context.isCurrent()) return
				if (!started.accepted) throw new Error("resume_interaction_start_rejected")
				lifecycle = started.next.turn?.blocks.find((candidate) => candidate.dlineTid === lifecycle?.dlineTid)
				if (!lifecycle) throw new Error("resume_interaction_block_missing_after_start")
			}

			const continuation = getInteraction(context.interaction.kind).continuation
			if (continuation === "handler" || continuation === "completion") {
				const toolResult = await this.toolExecutor.continueTurnEndInteraction(
					context.interaction.kind,
					block,
					context.outcome,
				)
				if (!context.isCurrent()) return
				await this.toolExecutor.commitRestoredToolResult(toolResult, block)
				if (!context.isCurrent()) return
			} else {
				await this.toolExecutor.executeTool(block)
				if (!context.isCurrent()) return
			}

			if (!this.turnDriver.hasPendingToolResult(lifecycle.dlineTid, lifecycle.functionId)) {
				await this.toolExecutor.commitInterruptedToolResult(
					block,
					"The tool continuation ended without a durable result. Its side effect was not replayed.",
				)
				if (!context.isCurrent()) return
			}
			for (const candidate of this.taskRuntime.getState().turn?.blocks ?? []) {
				if (candidate.phase !== BlockPhase.SKIPPED && candidate.phase !== BlockPhase.CANCELLED) continue

				const terminalBlock = blocks.find((item) => item.dline_tid === candidate.dlineTid)
				if (!terminalBlock) throw new Error("resume_terminal_block_missing")
				await this.turnDriver.ensureTerminalToolResult(terminalBlock, candidate.phase)
				if (!context.isCurrent()) return
			}

			const currentBlock = this.taskRuntime
				.getState()
				.turn?.blocks.find((candidate) => candidate.dlineTid === lifecycle?.dlineTid)
			if (currentBlock && !this.turnDriver.isTerminalRuntimeBlock(currentBlock.phase)) {
				const completed = await this.dispatchRuntime({
					type: "BLOCK_EXECUTION_COMPLETED",
					turnId: turn.turnId,
					dlineTid: currentBlock.dlineTid,
				})
				if (!context.isCurrent()) return
				if (!completed.accepted) throw new Error("resume_interaction_completion_rejected")
			}

			await context.resolve()
			if (!context.isCurrent()) return
			this.syncRetainedMachines(false)
			await this.turnDriver.execute()
			if (!context.isCurrent()) return
			if (this.taskRuntime.getState().phase === TaskPhase.CANCELLING) return
			this.taskState.userMessageContent.push({ type: "text", text: createResumeContinuationText() })
			await this.recursivelyMakeClineRequests(this.taskState.userMessageContent)
		} catch (error) {
			const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
			Logger.error(`[Task ${this.taskId}] restored interaction continuation failed: ${detail}`)
			this.taskState.abort = true
			void this.requestCancellation()
			throw error
		}
	}

	private async saveCheckpointCallback(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void> {
		return this.checkpointManager?.saveCheckpoint(isAttemptCompletionMessage, completionMessageTs) ?? Promise.resolve()
	}

	private async persistCheckpointHashToMessage(messageIndex: number, commitHash: string): Promise<void> {
		// Register the write synchronously before the first await. Terminate can then
		// mark the Task aborted and wait for exactly the store work that already began,
		// without waiting for a slow baseline commit that has not reached this boundary.
		if (this.taskState.abort) return
		const persistence = this.checkpointHashPersistenceChain
			.catch(() => undefined)
			.then(async () => {
				if (this.taskState.abort) return
				await this.messageStateHandler.updateClineMessage(messageIndex, {
					lastCheckpointHash: commitHash,
				})
				await this.messageStateHandler.flushMessageUpdate(messageIndex)
				await this.postStateToWebview()
			})
		this.checkpointHashPersistenceChain = persistence.catch(() => undefined)
		await persistence
	}

	/**
	 * Check if parallel tool calling is enabled.
	 * Parallel tool calling is enabled if:
	 * 1. User has enabled it in settings, OR
	 * 2. The current model/provider supports native tool calling and handles parallel tools well
	 */
	private resolveParallelToolCallingEnabled(providerInfo = this.getCurrentProviderInfo()): boolean {
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		return isParallelToolCallingEnabled(enableParallelSetting, providerInfo)
	}

	private isParallelToolCallingEnabled(providerInfo = this.getCurrentProviderInfo()): boolean {
		return this.activeProviderInputRuntime?.parallelToolsEnabled ?? this.resolveParallelToolCallingEnabled(providerInfo)
	}

	private async switchToActModeCallback(): Promise<boolean> {
		return await this.controller.toggleActModeForYoloMode()
	}

	/**
	 * Creates a wrapped focus chain update callback that also syncs the
	 * editor tab title with the latest task progress.
	 *
	 * @returns An async function matching updateFCListFromToolResponse signature
	 */
	private createWrappedFCUpdateCallback(): (taskProgress: string | undefined) => Promise<void> {
		const baseCallback: (taskProgress: string | undefined) => Promise<void> = this.FocusChainManager
			? this.FocusChainManager.updateFCListFromToolResponse.bind(this.FocusChainManager)
			: async (_taskProgress: string | undefined) => {}
		return async (taskProgress: string | undefined) => {
			await baseCallback(taskProgress)
			// Sync panel title after focus chain update
			this.syncPanelTitleFromState()
		}
	}

	/**
	 * Canonical editor-panel title for this task.
	 *
	 * This is the single source of truth for panel titles: it always combines the
	 * task description with the current focus chain progress, so no caller can
	 * drop the progress suffix by passing raw task text.
	 *
	 * @returns Formatted title such as `改进编辑面板任务标题 (1/5)`
	 */
	getPanelTitle(): string {
		const taskMessage = this.messageStateHandler.clineMessages.find((message) => message.say === "task")
		return formatTaskPanelTitle({
			taskTitle: taskMessage?.text || this.initialTaskTitle,
			checklist: this.taskState.currentFocusChainChecklist,
		})
	}

	/**
	 * Syncs the editor tab title based on current task state.
	 * Uses the task description and focus chain progress for the title.
	 */
	private syncPanelTitleFromState(): void {
		try {
			void this.controller.syncPanelTitle()
		} catch {
			// Non-critical; silently skip
		}
	}

	/**
	 * Unified cancellation handler for hook-requested cancellations.
	 * Ensures state is always saved before aborting, regardless of whether
	 * the user clicked cancel or the hook returned {cancel: true}.
	 *
	 * @param hookName The name of the hook for logging
	 * @param wasCancelled Whether user clicked cancel (vs hook returning cancel: true)
	 */
	private async handleHookCancellation(hookName: string, wasCancelled: boolean): Promise<void> {
		// ALWAYS save state, regardless of cancellation source
		this.taskState.didFinishAbortingStream = true

		// Save conversation state to disk
		await this.messageStateHandler.updateTaskHistory()
		await this.messageStateHandler.flushApiConversationHistory()
		await this.messageStateHandler.flushUiMessages()

		// Update UI
		await this.postStateToWebview()

		// Log for debugging/telemetry
		Logger.log(`[Task ${this.taskId}] ${hookName} hook cancelled (userInitiated: ${wasCancelled})`)
	}

	/**
	 * Calculate the new deleted range for PreCompact hook
	 * @param apiConversationHistory The full API conversation history
	 * @returns Tuple with start and end indices for the deleted range
	 */
	private calculatePreCompactDeletedRange(
		apiConversationHistory: ClineStorageMessage[],
		keep: "none" | "lastTwo" | "half" | "quarter" = "quarter",
	): [number, number] {
		const newDeletedRange = this.contextManager.getNextTruncationRange(
			apiConversationHistory,
			this.taskState.conversationHistoryDeletedRange,
			keep,
		)

		return newDeletedRange || [0, 0]
	}

	private async runUserPromptSubmitHook(
		userContent: ClineContent[],
		_context: "initial_task" | "resume" | "feedback",
	): Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }> {
		const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))

		if (!hooksEnabled) {
			return {}
		}

		const { extractUserPromptFromContent } = await import("./utils/extractUserPromptFromContent")

		// Extract clean user prompt from content, stripping system wrappers and metadata
		const promptText = extractUserPromptFromContent(userContent)

		const userPromptResult = await executeHook({
			hookName: "UserPromptSubmit",
			hookInput: {
				userPromptSubmit: {
					prompt: promptText,
					attachments: [],
				},
			},
			isCancellable: true,
			say: this.say.bind(this),
			setActiveHookExecution: this.setActiveHookExecution.bind(this),
			clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
			messageStateHandler: this.messageStateHandler,
			taskId: this.taskId,
			hooksEnabled,
			model: getHookModelContext(this.api, this.stateManager),
		})

		// Handle cancellation from hook
		if (userPromptResult.cancel === true && userPromptResult.wasCancelled) {
			// Set flag to allow Controller.cancelTask() to proceed
			this.taskState.didFinishAbortingStream = true
			// Save BOTH files so Controller.cancelTask() can find the task
			await this.messageStateHandler.updateTaskHistory()
			await this.messageStateHandler.flushApiConversationHistory()
			await this.messageStateHandler.flushUiMessages()
			await this.postStateToWebview()
		}

		return {
			cancel: userPromptResult.cancel,
			contextModification: userPromptResult.contextModification,
			errorMessage: userPromptResult.errorMessage,
		}
	}

	// Task lifecycle

	/** Run the complete cancellation transaction without message-derived state inference. */
	/** Present exhausted retry recovery and commit the chosen continuation. */
	public recoverApiFailure(input: {
		turnId: string
		interactionId: string
		apiIndex: number
		presentation: string
		persistedRequest?: boolean
		retryContent?: ClineContent[]
	}) {
		return this.interactionCoordinator.recover(input)
	}

	/** Reset every detector that feeds the mistake-limit recovery gate. */
	private resetMistakeLimitState(): void {
		this.taskState.consecutiveMistakeCount = 0
		this.taskState.autoRetryAttempts = 0
		this.taskState.consecutiveIdenticalToolCount = 0
		this.taskState.lastToolName = ""
		this.taskState.lastToolParams = ""
	}

	public async requestCancellation(): Promise<TaskDispatchResult> {
		const cancellationGeneration = this.interactionCoordinator.cancelPending()
		try {
			const requested = await this.dispatchRuntime({ type: "TASK_CANCEL_REQUESTED", source: "user" })
			if (!requested.accepted) {
				return requested
			}
			const cutoffRevision = requested.next.supersededEffectRevision ?? requested.next.revision - 1
			// Bound this wait exactly like interrupt() and terminate() do. A
			// provider stream or tool that ignores the abort signal must not keep
			// the user's cancel pending forever: the task is already CANCELLING
			// with abort set, and anything still running past the deadline is
			// fenced by the terminal cleanup path.
			await withTerminateTimeout(
				Promise.all([
					this.taskRuntime.waitForDeferredEffectsThrough(cutoffRevision),
					this.interactionCoordinator.waitForClaimedContinuations(),
				]).then(() => undefined),
				5_000,
				"taskCancel.waitForSupersededOperations",
			)
			const resumeInteractionId = `resume:${this.taskId}:${requested.next.revision}`
			return await this.dispatchRuntime({
				type: "TASK_CANCELLED",
				resume: {
					turnId: resumeInteractionId,
					interactionId: resumeInteractionId,
					presentation: "",
				},
			})
		} finally {
			this.interactionCoordinator.completeCancellation(cancellationGeneration)
		}
	}

	/** Commit a checkpoint chat rewind and optionally continue edited input exactly once. */
	private async restoreCheckpointChatRuntime(input: { apiIndex: number; editedText?: string }): Promise<void> {
		const before = this.getRuntimeState()
		const restored = await this.dispatchRuntime({
			type: "CHECKPOINT_CHAT_RESTORED",
			apiIndex: input.apiIndex,
			...(input.editedText === undefined ? {} : { draft: { text: input.editedText, images: [], files: [] } }),
		})
		if (!restored.accepted) {
			const detail = restored.effectError
				? `${restored.effectError.effectType}: ${restored.effectError.message}`
				: (restored.error?.code ?? "invalid_runtime_event")
			throw new Error(
				`Checkpoint chat restore rejected: ${detail}; requestedApiIndex=${String(input.apiIndex)}; phase=${before.phase}; currentApiIndex=${String(before.anchor.apiIndex)}`,
			)
		}
		this.syncRetainedMachines()
	}

	/** Fence every continuation and publication synchronously when the Controller releases this Task surface. */
	public fenceControllerDetachment(): void {
		if (this.controllerDetached) return
		this.controllerDetached = true
		this.interactionCoordinator.fence("task_detached")
		this.taskState.activeHookExecution?.abortController.abort()
		this.taskState.abort = true
		this.taskState.cancelOperations("task_detached")
		this.api?.abort?.()
	}

	/** Mark an interactive historical Task as visible but not yet dispatchable. */
	public beginHistoryPreparation(): void {
		this.historyPreparationPending = true
	}

	/** Return whether the History surface is awaiting canonical Resume identity. */
	public isHistoryPreparationPending(): boolean {
		return this.historyPreparationPending
	}

	/** Return the read-only runtime aggregate for projection and migration tests. */
	public getRuntimeState(): Readonly<TaskRuntimeState> {
		return this.taskRuntime.getState()
	}

	/** Dispatch one typed event through the serialized task runtime. */
	public dispatchRuntime(event: TaskEvent): Promise<TaskDispatchResult> {
		if (event.type === "INTERACTION_RESPONDED") {
			const interactionBeforeResponse = this.taskRuntime.getState().interaction
			return this.interactionCoordinator.respond(event.response).then((result) => {
				const isAcceptedErrorRetryTakeover =
					result.accepted &&
					interactionBeforeResponse?.status === "awaiting" &&
					interactionBeforeResponse.kind === "error_retry" &&
					interactionBeforeResponse.interactionId === event.response.interactionId &&
					interactionBeforeResponse.turnId === event.response.turnId &&
					(event.response.actionId === "retry" || event.response.actionId === "start_new_task")
				if (isAcceptedErrorRetryTakeover) {
					this.taskState.forceTruncateAvailable = false
				}
				return result
			})
		}
		return this.taskRuntime.dispatch(event)
	}

	/** Wait until the detached continuation for one accepted interaction has settled. */
	public waitForInteractionSettlement(interactionId: string): Promise<void> {
		return this.interactionCoordinator.waitForClaimedContinuation(interactionId)
	}

	public async startTask(
		task?: string,
		images?: string[],
		files?: string[],
		context?: string[],
		initialUserContent: readonly ClineUserContent[] = [],
	): Promise<void> {
		const startTaskBeganAt = performance.now()
		Logger.debug(`[Task ${this.taskId}] startTask entered`)
		await this.ensureApiRateMetricsInitialized()
		const rateMetricsReadyAt = performance.now()
		// Ignore rules are already loaded by the Controller that owns this workspace.
		const ignoreControllerReadyAt = performance.now()
		this.startContextWindowEnvironmentRefresh()
		// The stable indicator only refreshes a header readout. Nothing below reads
		// its result, while it builds full environment details (host version, visible
		// tabs, open tabs, active task controllers) behind a single await. Keeping it
		// on the startup path delayed the first request by seconds on large
		// workspaces, so it now settles in the background.
		void this.refreshStableContextWindowIndicator().catch((error) => {
			Logger.debug(`[Task ${this.taskId}] Initial context-window indicator refresh failed: ${error}`)
		})
		// The pre-request startup path emits no other log line, so a stall here is
		// invisible in production logs. Report the segment costs before the first
		// `say` so a slow start can be attributed without a debugger.
		Logger.debug(
			`[Task ${this.taskId}] startTask timing: rateMetrics=${Math.round(rateMetricsReadyAt - startTaskBeganAt)}ms, ` +
				`clineIgnore=${Math.round(ignoreControllerReadyAt - rateMetricsReadyAt)}ms`,
		)
		// conversationHistory (for API) and clineMessages (for webview) need to be in sync
		// if the extension process were killed, then on restart the clineMessages might not be empty, so we need to set it to [] when we create a new Cline client (otherwise webview would show stale messages from previous session)
		await this.messageStateHandler.uiMessage?.clear()
		// Clearing reaches the durable store directly, so aggregates derived from
		// the previous session would otherwise survive into the first state
		// publication of this task.
		this.messageStateHandler.invalidateDerivedAggregates()
		const uiMessageClearedAt = performance.now()
		await this.messageStateHandler.apiConversation?.clear()
		const storesClearedAt = performance.now()

		await this.postStateToWebview()
		const statePostedAt = performance.now()

		await this.say("task", task, images, files)
		const taskSaidAt = performance.now()
		// This span sits between the last startup log line and the first state
		// delivery, so a stall here is otherwise invisible in production logs.
		Logger.debug(
			`[Task ${this.taskId}] startTask handoff timing: clearUiMessage=${Math.round(uiMessageClearedAt - ignoreControllerReadyAt)}ms, ` +
				`clearApiConversation=${Math.round(storesClearedAt - uiMessageClearedAt)}ms, ` +
				`postState=${Math.round(statePostedAt - storesClearedAt)}ms, ` +
				`sayTask=${Math.round(taskSaidAt - statePostedAt)}ms`,
		)

		const initializing = await this.dispatchRuntime({ type: "TASK_INITIALIZE_REQUESTED" })
		if (!initializing.accepted) {
			throw new Error(`Task initialization rejected: ${initializing.error?.code ?? "invalid_runtime_event"}`)
		}
		const initializeDispatchedAt = performance.now()
		recordPerfPhase(
			PerfDomain.TaskInit,
			"stage",
			initializeDispatchedAt - taskSaidAt,
			{ stage: "initializeDispatch", kind: "admission" },
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[Task ${this.taskId}] startTask admission phase=initializeDispatch elapsedMs=${Math.round(initializeDispatchedAt - taskSaidAt)}`,
			)
		}

		const imageBlocks: ClineImageContentBlock[] = formatResponse.imageBlocks(images)

		const userContent: ClineUserContent[] = [
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		]

		// Inject context blocks — each as independent text block for cache-friendly design.
		// Accepts string[] to support future auto-extraction of multiple context fragments.
		if (context && context.length > 0) {
			for (const ctx of context) {
				userContent.push({ type: "text", text: `<context>\n${ctx}\n</context>` })
			}
		}

		if (files && files.length > 0) {
			const fileContentString = await processFilesIntoText(files)
			if (fileContentString) {
				userContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}
		const filesProcessedAt = performance.now()
		recordPerfPhase(
			PerfDomain.TaskInit,
			"stage",
			filesProcessedAt - initializeDispatchedAt,
			{ stage: "processFiles", kind: "admission", elapsedMs: Math.round(filesProcessedAt - taskSaidAt) },
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[Task ${this.taskId}] startTask admission phase=processFiles elapsedMs=${Math.round(filesProcessedAt - taskSaidAt)}`,
			)
		}

		userContent.push(...cloneDeep(initialUserContent))

		// Add TaskStart hook context to the conversation if provided
		const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (hooksEnabled) {
			const taskStartResult = await executeHook({
				hookName: "TaskStart",
				hookInput: {
					taskStart: {
						taskMetadata: {
							taskId: this.taskId,
							ulid: this.ulid,
							initialTask: task || "",
						},
					},
				},
				isCancellable: true,
				say: this.say.bind(this),
				setActiveHookExecution: this.setActiveHookExecution.bind(this),
				clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
				messageStateHandler: this.messageStateHandler,
				taskId: this.taskId,
				hooksEnabled,
				model: getHookModelContext(this.api, this.stateManager),
			})

			// Handle cancellation from hook
			if (taskStartResult.cancel === true) {
				// Always save state regardless of cancellation source
				await this.handleHookCancellation("TaskStart", taskStartResult.wasCancelled)

				// Let Controller handle the cancellation (it will call abortTask)
				await this.cancelTask()
				return
			}

			// Add context modification to the conversation if provided
			if (taskStartResult.contextModification) {
				const contextText = taskStartResult.contextModification.trim()
				if (contextText) {
					userContent.push({
						type: "text",
						text: `<hook_context source="TaskStart">\n${contextText}\n</hook_context>`,
					})
				}
			}
		}

		const taskStartHookAt = performance.now()
		recordPerfPhase(
			PerfDomain.TaskInit,
			"stage",
			taskStartHookAt - filesProcessedAt,
			{ stage: "taskStartHook", kind: "admission", elapsedMs: Math.round(taskStartHookAt - taskSaidAt) },
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[Task ${this.taskId}] startTask admission phase=taskStartHook elapsedMs=${Math.round(taskStartHookAt - taskSaidAt)}`,
			)
		}

		// Defensive check: Verify task wasn't aborted during hook execution before continuing
		// Must be OUTSIDE the hooksEnabled block to prevent UserPromptSubmit from running
		if (this.taskState.abort) {
			return
		}

		// Run UserPromptSubmit hook for initial task (after TaskStart for UI ordering)
		const userPromptHookResult = await this.runUserPromptSubmitHook(userContent, "initial_task")
		const userPromptHookAt = performance.now()
		recordPerfPhase(
			PerfDomain.TaskInit,
			"stage",
			userPromptHookAt - taskStartHookAt,
			{ stage: "userPromptHook", kind: "admission", elapsedMs: Math.round(userPromptHookAt - taskSaidAt) },
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[Task ${this.taskId}] startTask admission phase=userPromptHook elapsedMs=${Math.round(userPromptHookAt - taskSaidAt)}`,
			)
		}

		// Defensive check: Verify task wasn't aborted during hook execution (handles async cancellation)
		if (this.taskState.abort) {
			return
		}

		// Handle hook cancellation
		if (userPromptHookResult.cancel === true) {
			await this.handleHookCancellation("UserPromptSubmit", userPromptHookResult.wasCancelled ?? false)
			await this.cancelTask()
			return
		}

		// Add hook context if provided
		if (userPromptHookResult.contextModification) {
			userContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
			})
		}

		// Record environment metadata for new task
		try {
			await this.environmentContextTracker.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata:", error)
		}
		const environmentRecordedAt = performance.now()
		recordPerfPhase(
			PerfDomain.TaskInit,
			"stage",
			environmentRecordedAt - userPromptHookAt,
			{ stage: "recordEnvironment", kind: "admission", elapsedMs: Math.round(environmentRecordedAt - taskSaidAt) },
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[Task ${this.taskId}] startTask admission phase=recordEnvironment elapsedMs=${Math.round(environmentRecordedAt - taskSaidAt)}`,
			)
		}

		const initialized = await this.dispatchRuntime({
			type: "TASK_INITIALIZED",
			anchor: { apiIndex: this.messageStateHandler.apiConversationHistory.length - 1 },
			hasTask: true,
		})
		if (!initialized.accepted) {
			throw new Error(`Task initialization commit rejected: ${initialized.error?.code ?? "invalid_runtime_event"}`)
		}
		const initializedDispatchedAt = performance.now()
		recordPerfPhase(
			PerfDomain.TaskInit,
			"stage",
			initializedDispatchedAt - environmentRecordedAt,
			{ stage: "initializedDispatch", kind: "admission", elapsedMs: Math.round(initializedDispatchedAt - taskSaidAt) },
			{ taskId: this.taskId },
		)
		recordPerfPhase(
			PerfDomain.TaskInit,
			"stage",
			initializedDispatchedAt - taskSaidAt,
			{ stage: "admissionTotal", kind: "admission", hooksEnabled },
			{ taskId: this.taskId },
		)

		// Everything above is awaited before the first API request can start, so an
		// unattributed stall here is invisible unless each stage reports its own cost.
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[Task ${this.taskId}] startTask admission phase=initializedDispatch elapsedMs=${Math.round(initializedDispatchedAt - taskSaidAt)}`,
			)
			Logger.debug(
				`[Task ${this.taskId}] startTask admission timing: ` +
					`initializeDispatch=${Math.round(initializeDispatchedAt - taskSaidAt)}ms, ` +
					`processFiles=${Math.round(filesProcessedAt - initializeDispatchedAt)}ms, ` +
					`taskStartHook=${Math.round(taskStartHookAt - filesProcessedAt)}ms, ` +
					`userPromptHook=${Math.round(userPromptHookAt - taskStartHookAt)}ms, ` +
					`recordEnvironment=${Math.round(environmentRecordedAt - userPromptHookAt)}ms, ` +
					`initializedDispatch=${Math.round(initializedDispatchedAt - environmentRecordedAt)}ms, ` +
					`totalMs=${Math.round(initializedDispatchedAt - taskSaidAt)}, hooksEnabled=${hooksEnabled}`,
			)
		}

		// Mark task as initialized so checkpoint restore can proceed
		this.taskState.isInitialized = true

		await this.initiateTaskLoop(userContent)
	}

	private isPendingToolApprovalAsk(ask: ClineAsk | undefined): ask is ClineAsk {
		return (
			ask === "tool" ||
			ask === "command" ||
			ask === "browser_action_launch" ||
			ask === "use_mcp_server" ||
			ask === "use_subagents" ||
			ask === "spawn_task" ||
			ask === "change_todo_list" ||
			ask === "status_acknowledgment"
		)
	}

	/**
	 * Check if an ask type is conversational (Q&A / plan / report).
	 * These tools display a text response in the footer without approve/reject buttons and
	 * expect a text reply via the input box. They must set conversation awaiting in the
	 * snapshot so buildTaskUiState returns cancelEnabled=false and no action buttons.
	 */
	private isConversationalAsk(ask: ClineAsk | undefined): ask is ClineAsk {
		return (
			ask === "make_plan" ||
			ask === "qna_respond" ||
			ask === "followup" ||
			ask === "generate_report" ||
			ask === "act_mode_respond" ||
			ask === "condense"
		)
	}

	/**
	 * Check if an ask type represents error recovery.
	 * These asks must be projected through TaskUiState instead of legacy buttonConfig.
	 */
	private isErrorRecoveryAsk(ask: ClineAsk | undefined): ask is ClineAsk {
		return ask === "api_req_failed" || ask === "mistake_limit_reached"
	}

	/**
	 * Check if an ask type represents a resumable paused task.
	 * These asks must set awaiting.resume so history and cancel recovery show Resume.
	 */
	private isResumeAsk(ask: ClineAsk | undefined): ask is ClineAsk {
		return ask === "resume_task" || ask === "resume_completed_task"
	}

	/**
	 * Check if an ask type represents completed task feedback.
	 * Completion asks keep the task finished while allowing feedback or Start New Task.
	 */
	private isCompletionAsk(ask: ClineAsk | undefined): ask is ClineAsk {
		return ask === "completion_result"
	}

	private withApprovalVisibleCallback(
		type: ClineAsk,
		text: string | undefined,
		partial: boolean | undefined,
		options?: AskOptions,
	): AskOptions | undefined {
		const shouldTrackApproval = this.isPendingToolApprovalAsk(type) && partial !== true
		const shouldTrackConversation = this.isConversationalAsk(type) && partial !== true
		const shouldTrackErrorRecovery = this.isErrorRecoveryAsk(type) && partial !== true
		const shouldTrackResume = this.isResumeAsk(type) && partial !== true
		const shouldTrackCompletion = this.isCompletionAsk(type) && partial !== true
		const shouldNotify = type !== "command_output" && partial !== true
		if (
			!shouldTrackApproval &&
			!shouldTrackConversation &&
			!shouldTrackErrorRecovery &&
			!shouldTrackResume &&
			!shouldTrackCompletion &&
			!shouldNotify
		) {
			return options
		}

		return {
			...options,
			onAskVisible: async (askTs: number) => {
				if (shouldTrackApproval) {
					await this.markApprovalAskVisible(type)
				}
				if (shouldTrackConversation) {
					await this.markConversationAskVisible(type, askTs)
				}
				if (shouldTrackErrorRecovery) {
					await this.markErrorRecoveryAskVisible(type, askTs, text)
				}
				if (shouldTrackResume) {
					await this.markResumeAskVisible(type, askTs)
				}
				if (shouldTrackCompletion) {
					await this.markCompletionAskVisible(type, askTs)
				}
				await options?.onAskVisible?.(askTs)
				if (shouldNotify) {
					try {
						await NotificationHook.emitUserAttentionNotification(
							{
								messageStateHandler: this.messageStateHandler,
								taskId: this.taskId,
								hooksEnabled: getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled")),
								model: getHookModelContext(this.api, this.stateManager),
							},
							{
								source: type,
								message: text || "",
							},
						)
					} catch (error) {
						Logger.error("[Task.ask] Failed to emit user attention notification:", error)
					}
				}
			},
		}
	}

	private async markApprovalAskVisible(type: ClineAsk): Promise<void> {
		const block = this.taskController.getActiveBlock() ?? this.taskController.advanceNextPendingApproval()
		if (!block) return

		const expectedAsk = this.taskController.toolNameToAskType(block.toolName)
		if (expectedAsk !== type) return

		await this.taskController.transitionRequired(TaskPhase.AWAITING_APPROVAL, {
			apiIndex: block.conversationHistoryIndex,
			awaiting: {
				kind: type === "status_acknowledgment" ? "approval" : "approval",
				taskAsk: type,
				activeFunctionId: block.functionId,
				activeDlineTid: block.dlineTid,
			},
			approval: {
				mode: this.isParallelToolCallingEnabled() ? "parallel" : "serial",
				blocks: this.taskController.getBlocks().map((candidate) => ({
					functionId: candidate.functionId,
					dlineTid: candidate.dlineTid,
					name: candidate.toolName,
					phase: candidate.phase,
					apiIndex: candidate.conversationHistoryIndex,
				})),
				activeFunctionId: block.functionId,
				activeDlineTid: block.dlineTid,
			},
		})
		await this.postStateToWebview()
	}

	/**
	 * Create a conversation-awaiting snapshot for Q&A tools (make_plan,
	 * qna_respond, followup, generate_report, act_mode_respond).
	 * This ensures buildTaskUiState returns cancelEnabled=false and empty actions,
	 * so the frontend hides the Cancel button and shows only the input area.
	 */
	private async markConversationAskVisible(type: ClineAsk, askTs: number): Promise<void> {
		await this.taskController.transitionRequired(TaskPhase.AWAITING_APPROVAL, {
			apiIndex: this.messageStateHandler.apiConversationHistory.length - 1,
			awaiting: {
				kind: "conversation",
				taskAsk: type,
				messageTs: askTs,
			},
		})
		await this.postStateToWebview()
	}

	/**
	 * Create an error-recovery snapshot for retry/process-anyway asks.
	 * This keeps footer actions and input enabled state driven by TaskUiState.
	 */
	private async markErrorRecoveryAskVisible(type: ClineAsk, askTs: number, message?: string): Promise<void> {
		const isApiRequestFailure = type === "api_req_failed"
		await this.taskController.transitionRequired(TaskPhase.AWAITING_APPROVAL, {
			apiIndex: this.messageStateHandler.apiConversationHistory.length - 1,
			awaiting: {
				kind: "error_recovery",
				taskAsk: type,
				messageTs: askTs,
			},
			error: {
				kind: isApiRequestFailure ? "api_req_failed" : "mistake_limit_reached",
				sourceAsk: type,
				message: message ?? "",
				actions: isApiRequestFailure ? ["retry", "start_new_task"] : ["process_anyway", "start_new_task"],
				retryable: isApiRequestFailure,
				processAllowed: !isApiRequestFailure,
				messageTs: askTs,
			},
		})
		await this.postStateToWebview()
	}

	/**
	 * Create a resume-awaiting snapshot for paused or historical task recovery.
	 * This ensures Resume is shown instead of Cancel while no work is active.
	 */
	private async markResumeAskVisible(type: ClineAsk, askTs: number): Promise<void> {
		await this.taskController.transitionRequired(TaskPhase.PAUSED, {
			apiIndex: this.messageStateHandler.apiConversationHistory.length - 1,
			awaiting: {
				kind: "resume",
				taskAsk: type,
				messageTs: askTs,
			},
		})
		await this.postStateToWebview()
	}

	/**
	 * Create a completion-awaiting snapshot for finished task feedback.
	 * This keeps Start New Task visible after attempt_completion completes.
	 */
	private async markCompletionAskVisible(type: ClineAsk, askTs: number): Promise<void> {
		await this.taskController.transitionRequired(TaskPhase.COMPLETED, {
			apiIndex: this.messageStateHandler.apiConversationHistory.length - 1,
			awaiting: {
				kind: "completion",
				taskAsk: type,
				messageTs: askTs,
			},
		})
		await this.postStateToWebview()
	}

	/**
	 * Load and display historical task messages without waiting for user interaction.
	 * Does not execute or replay persisted work; prepareFromHistory() reconciles
	 * the persisted runtime into a stopped interaction state.
	 *
	 * Used for both readonly (locked task) and interactive resume scenarios.
	 */
	public async displayHistory(): Promise<void> {
		// Metrics are a secondary projection and must not delay the historical surface.
		// The request path initializes them on demand; History readiness starts them later.
		// Ignore rules are already loaded by the Controller that owns this workspace.

		// UIMessage and ApiConversation were opened before Task construction and are
		// already the authoritative in-memory views. Metadata refresh is deferred until
		// after Resume readiness so directory-size scans cannot block historical display.

		await ensureTaskDirectoryExists(this.taskId)
		await this.contextManager.initializeContextHistory(await ensureTaskDirectoryExists(this.taskId))
		await this.loadTaskSnapshot()
		await this.rebuildApiHandler()

		// Display-only history loading never infers or mutates runtime phase from message tails.
		// Interactive restoration is owned exclusively by ResumeCoordinator.

		// Mark task as initialized so checkpoint restore can proceed
		this.taskState.isInitialized = true
	}

	/**
	 * Reconcile a historical task into an inert interaction state after its messages
	 * have loaded. No API, tool, interaction waiter, or prior draft is dispatched.
	 *
	 * Only call this when the task lock is acquired (taskLockAcquired === true).
	 * Readonly windows should stop after displayHistory() and show a lock banner.
	 */
	public async prepareFromHistory(options?: ResumeTaskFromHistoryOptions) {
		this.taskState.abort = true
		try {
			await this.resumeCoordinator.prepare(this.taskId)
		} catch (error) {
			this.historyPreparationPending = false
			await this.postStateToWebview({ immediate: true })
			throw error
		}
		this.startContextWindowEnvironmentRefresh()
		await options?.onReadyToDisplay?.()
		void this.ensureApiRateMetricsInitialized().catch((error) => {
			Logger.debug(`[Task ${this.taskId}] Deferred API rate metrics initialization failed: ${error}`)
		})
		const isCurrent = options?.isCurrent ?? (() => true)
		if (!isCurrent()) return

		void this.historyResumeMaintenance
			.run(isCurrent)
			.then(() => {
				if (!isCurrent()) return
				return this.postStateToWebview({ immediate: true })
			})
			.catch((error) => {
				Logger.warn(`[Task ${this.taskId}] Historical maintenance failed unexpectedly:`, error)
			})
	}

	private async patchInterruptedCommandCards(activityIds: ReadonlySet<string>): Promise<void> {
		for (const [index, message] of this.messageStateHandler.clineMessages.entries()) {
			if (
				message.activityId &&
				activityIds.has(message.activityId) &&
				(message.commandStatus === "pending" || message.commandStatus === "running")
			) {
				await this.messageStateHandler.updateClineMessage(index, { commandStatus: "interrupted" })
			}
		}
	}

	/**
	 * Drop duplicated encrypted reasoning snapshots left by earlier versions.
	 *
	 * Histories written before encrypted reasoning was accumulated by item id can hold thousands of
	 * repeated `redacted_thinking` snapshots in one assistant message, which exceeds every
	 * compaction Pass ceiling and leaves the task unable to continue. Repair once on resume.
	 */
	private async repairPersistedEncryptedReasoning(): Promise<void> {
		const history = this.messageStateHandler.apiConversationHistory
		if (history.length === 0) return
		const result = repairPersistedEncryptedReasoning(history)
		if (result.removedBlockCount === 0) return

		await this.messageStateHandler.overwriteApiConversationHistory(result.messages)
		Logger.warn(
			`[Task ${this.taskId}] Removed ${result.removedBlockCount} duplicated encrypted reasoning block(s) from ` +
				`${result.repairedMessageCount} persisted message(s)`,
		)
	}

	private async cleanLegacyTaskStorage(): Promise<void> {
		try {
			const taskDirectory = await ensureTaskDirectoryExists(this.taskId)
			const result = await this.taskLegacyStorageCleaner.cleanLockedTask(taskDirectory)
			for (const failure of result.failed) {
				Logger.warn(`[Task ${this.taskId}] Failed to remove legacy task storage "${failure.name}":`, failure.error)
			}
		} catch (error) {
			Logger.warn(`[Task ${this.taskId}] Failed to clean legacy task storage:`, error)
		}
	}

	/** @deprecated Historical opening is preparation only; use prepareFromHistory(). */
	public async resumeFromHistory(options?: ResumeTaskFromHistoryOptions) {
		await this.prepareFromHistory(options)
	}

	/**
	 * Resume the current task without reloading messages from disk.
	 * Used after cancellation so the message list stays in-place (no flicker)
	 * while still showing the resume prompt and handling the user response.
	 */
	private async initiateTaskLoop(userContent: ClineContent[]): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true
		// The stretch between task creation and the first provider request had no
		// instrumentation, so a slow first turn showed up only as a silent gap in
		// the log. Report it once, for the first turn, where the cost lands.
		const firstTurnStartedAt = performance.now()
		let firstTurnReported = false
		while (!this.taskState.abort) {
			let didEndLoop: boolean
			try {
				didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			} catch (error) {
				// An exception raised between two provider requests must not unwind this
				// loop silently. Surface it, let the recovery interaction own the
				// continuation, then leave the loop like every other recovery call site.
				await this.recoverTaskLoopFailure(error)
				break
			}
			if (!firstTurnReported) {
				firstTurnReported = true
				Logger.debug(
					`[Task ${this.taskId}] first turn timing: startToTurnEnd=${Math.round(
						performance.now() - firstTurnStartedAt,
					)}ms, includeFileDetails=true`,
				)
			}
			includeFileDetails = false // we only need file details the first time

			//  The way this agentic loop works is that cline will be given a task that he then calls tools to complete. unless there's an attempt_completion call, we keep responding back to him with his tool's responses until he either attempt_completion or does not use anymore tools. If he does not use anymore tools, we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.

			//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if the user hits max requests and denies resetting the count.
				//this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
				break
			}
			// this.say(
			// 	"tool",
			// 	"Cline responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
			// )
			nextUserContent = [
				{
					type: "text",
					text: formatResponse.noToolsUsed(this.useNativeToolCalls),
				},
			]
			this.taskState.consecutiveMistakeCount++
		}
	}

	/**
	 * Turn a task-loop failure that escaped one turn into a visible, actionable state.
	 *
	 * Without this boundary an exception raised between two provider requests (for
	 * example while loading context) leaves no trace: no error message is written,
	 * no phase transition is committed and no view state is published, so the task
	 * stays parked in a working phase that the user can neither cancel nor retry.
	 */
	private async recoverTaskLoopFailure(error: unknown): Promise<void> {
		if (this.taskState.abort || isInteractionCancellationError(error)) {
			return
		}

		const presentation = error instanceof Error ? error.message : String(error)
		Logger.error(`[Task ${this.taskId}] Task loop failed between requests:`, error)

		try {
			await this.say("error", presentation)
		} catch (sayError) {
			Logger.error(`[Task ${this.taskId}] Failed to surface task loop failure:`, sayError)
		}

		const interactionId = `task-loop-failure:${this.taskId}:${this.getRuntimeState().revision}`
		try {
			await this.recoverApiFailure({
				turnId: interactionId,
				interactionId,
				apiIndex: this.messageStateHandler.apiConversationHistory.length - 1,
				presentation,
				persistedRequest: true,
			})
		} catch (recoveryError) {
			if (!isInteractionCancellationError(recoveryError)) {
				Logger.error(`[Task ${this.taskId}] Failed to present task loop recovery:`, recoveryError)
			}
		} finally {
			await this.postStateToWebview({ immediate: true }).catch((publishError) => {
				Logger.error(`[Task ${this.taskId}] Failed to publish task loop failure state:`, publishError)
			})
		}
	}

	/**
	 * Determines if the TaskCancel hook should run.
	 * Only runs if there's actual active work happening or if work was started in this session.
	 * Does NOT run when just showing the resume button or completion button with no active work.
	 * @returns true if the hook should run, false otherwise
	 */
	private async shouldRunTaskCancelHook(): Promise<boolean> {
		return shouldRunTaskCancelHook({
			runtime: this.taskRuntime.getState(),
			source: this.taskRuntime.getState().cancellation?.source ?? "user",
			activity: {
				hasActiveHook: Boolean(await this.getActiveHookExecution()),
				isStreaming: this.taskState.isStreaming,
				isWaitingForFirstChunk: this.taskState.isWaitingForFirstChunk,
				hasTaskOwnedCommand: this.commandExecutor.hasTaskOwnedCommand(),
			},
		})
	}

	/**
	 * Pause the task ÃƒÂ¢Ã¢â€?stop execution but preserve all resources.
	 * The task can be resumed later via resume().
	 * Called when the user clicks the cancel button.
	 */
	notifyToolConcurrencyLimitChanged(): void {
		this.turnToolScheduler.notifyLimitChanged()
	}

	notifySubagentConcurrencyLimitChanged(): void {
		this.toolExecutor?.notifySubagentConcurrencyLimitChanged()
	}

	async abortExecution() {
		try {
			this.invalidatePreparedProviderInputs()
			this.cancelPendingAutoRetry()
			this.modeSwitchCompaction.abort()
			this.taskState.pendingManualCompactionContinuation = undefined
			this.taskState.pendingManualCompactionRegeneration = undefined
			// PHASE 1: Check if TaskCancel should run BEFORE any cleanup
			const shouldRunTaskCancelHook = await this.shouldRunTaskCancelHook()

			this.taskState.abort = true
			this.turnToolScheduler.cancelActiveTurn()
			this.taskState.cancelOperations("task_cancelled")
			this.api?.abort?.()
			this.presentationScheduler.reset()
			this.pendingReasoningText = undefined

			// PHASE 3: Cancel the hook, task-owned commands and task activities in
			// parallel. Each branch carries its own deadline, so the worst-case
			// cancel latency is one timeout instead of the sum of three sequential
			// waits. Only Task-owned work is swept here: commands and activities
			// the user moved to the background keep running, and terminate() stays
			// the single place that performs the unfiltered sweep.
			const activeHook = await this.getActiveHookExecution()
			const activeActivityIds = this.activityStore.listRunning("task").map((activity) => activity.activityId)
			await Promise.allSettled([
				(async () => {
					if (!activeHook) {
						return
					}
					try {
						await withTerminateTimeout(this.cancelHookExecution(), 3_000, "cancelHookExecution")
					} catch (error) {
						Logger.error("Failed to cancel hook during task pause", error)
					} finally {
						await this.clearActiveHookExecution()
					}
				})(),
				(async () => {
					try {
						await withTerminateTimeout(
							this.commandExecutor.cancelTaskOwnedCommands(),
							3_000,
							"cancelTaskOwnedCommands",
						)
					} catch (error) {
						Logger.error("Failed to cancel Task-owned command during task pause", error)
					}
				})(),
				(async () => {
					if (activeActivityIds.length === 0) {
						return
					}
					await withTerminateTimeout(this.activityStore.cancel(activeActivityIds), 3_000, "cancelTaskActivities").catch(
						(error) => Logger.error("Failed to cancel task activities during task pause", error),
					)
				})(),
			])

			// PHASE 4: Run TaskCancel hook (conditional)
			const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))
			if (hooksEnabled && shouldRunTaskCancelHook) {
				try {
					// The hook may call a model, so it needs its own deadline:
					// without one it alone can hold the user in the cancel wait.
					await withTerminateTimeout(
						executeHook({
							hookName: "TaskCancel",
							hookInput: {
								taskCancel: {
									taskMetadata: {
										taskId: this.taskId,
										ulid: this.ulid,
										completionStatus: this.taskState.abandoned ? "abandoned" : "cancelled",
									},
								},
							},
							isCancellable: false,
							say: this.say.bind(this),
							messageStateHandler: this.messageStateHandler,
							taskId: this.taskId,
							hooksEnabled,
							model: getHookModelContext(this.api, this.stateManager),
						}),
						5_000,
						"taskCancelHook",
					)
				} catch (error) {
					Logger.error("[TaskCancel Hook] Failed (non-fatal):", error)
				}
			}

			// Stopping the domain is what reverts the diff: routing the reset
			// through halt keeps "exactly one reset per stop" structural instead
			// of relying on each cancel path to remember the call.
			await this.getToolDomain().haltToolDomain("cancel")

			// Save state and update UI so the frontend reflects the pause
			await Promise.all([
				this.flushTaskSnapshot(),
				this.messageStateHandler.flushApiConversationHistory(),
				this.messageStateHandler.flushUiMessages(),
			])
			await this.messageStateHandler.updateTaskHistory()
			await this.postStateToWebview()

			// Resume ask is now handled by cancelTask after pause completes.
			// This ensures the ask is sent with the final cleaned-up message list
			// and avoids a race between pause's async ask and cancelTask's postState.
		} catch (error) {
			Logger.error("[abortExecution] Failed:", error)
		}
	}

	/**
	 * Terminate the task completely ÃƒÂ¢Ã¢â€?dispose all resources and release locks.
	 * Called when the task is cleared, reset, or the extension is shutting down.
	 * No resume ask is sent because the task is being destroyed.
	 */
	async interrupt(): Promise<void> {
		const cutoffRevision = this.taskRuntime.getState().revision
		const cancellationGeneration = this.interactionCoordinator.cancelPending("checkpoint_restore")
		try {
			this.cancelPendingAutoRetry()
			this.modeSwitchCompaction.abort()
			this.taskState.pendingManualCompactionContinuation = undefined
			this.taskState.pendingManualCompactionRegeneration = undefined
			this.taskState.abort = true
			this.taskState.cancelOperations("checkpoint_restore")
			this.api?.abort?.()

			await Promise.all([
				pWaitFor(() => !this.taskState.isStreaming || this.taskState.didFinishAbortingStream, {
					interval: 100,
					timeout: 3_000,
				}).catch(() => {}),
				withTerminateTimeout(
					Promise.all([
						this.taskRuntime.waitForDeferredEffectsThrough(cutoffRevision),
						this.interactionCoordinator.waitForClaimedContinuations(),
					]).then(() => undefined),
					5_000,
					"checkpointRestore.waitForSupersededOperations",
				),
			])
			await withTerminateTimeout(
				this.apiRequestRoundLifecycle.abortOpenExecutions(),
				5_000,
				"checkpointRestore.abortOpenExecutions",
			)

			await this.getToolDomain().haltToolDomain("cancel")
		} finally {
			this.interactionCoordinator.completeCancellation(cancellationGeneration)
		}
	}

	/**
	 * Build the tool execution domain on first use.
	 *
	 * Construction is deferred because the tool executor and command executor
	 * are assigned after the runtime is created, and an executor that captured
	 * them too early would hold stale references.
	 */
	private getToolDomain(): ToolExecutionDomain {
		if (!this.toolDomain) {
			this.toolDomain = new ToolExecutionDomain({
				runner: createToolDomainRunner({
					resources: {
						revertDiff: async () => {
							await this.diffViewProvider.revertChanges()
						},
						// Command cancellation deliberately stays at its existing call
						// sites: abortExecution already cancels task-owned commands
						// before halting, and interrupt intentionally leaves running
						// commands alone. Cancelling here would double-cancel the
						// first path and change the second.
						cancelCommand: async () => undefined,
					},
					execute: async (command) => {
						await this.toolExecutor.runPreparedAdmission(command.dlineTid)
					},
					onReleaseError: (error) => Logger.error("[toolDomain] Resource release failed (non-fatal):", error),
				}),
				sink: this.toolDomainLedger.sink,
				surface: createTaskUserFacingSurface(this),
				identityPrefix: this.taskId,
				releaseFallback: () => this.toolDomainLedger.releaseAll(),
				onHaltFailure: (error) => Logger.error("[toolDomain] Halt did not drain within its budget:", error),
			})
		}
		return this.toolDomain
	}

	/** The editor-visible diff surface, exposed for the tool domain's surface grant. */
	getDiffSurface(): DiffViewProvider {
		return this.diffViewProvider
	}

	async terminate(options?: { preserveCompletedState?: boolean }) {
		const terminateStartedAt = performance.now()
		let stageStartedAt = terminateStartedAt
		const logTerminateStage = (phase: string, details = "") => {
			const now = performance.now()
			recordPerfPhase(
				PerfDomain.TaskClose,
				"stage",
				now - stageStartedAt,
				{ stage: phase, elapsedMs: Math.round(now - terminateStartedAt) },
				{ taskId: this.taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[TaskClosePerf] phase=${phase} taskId=${this.taskId} durationMs=${Math.round(now - stageStartedAt)} elapsedMs=${Math.round(now - terminateStartedAt)}${details ? ` ${details}` : ""}`,
				)
			}
			stageStartedAt = now
		}
		this.stopContextWindowEnvironmentRefresh()
		this.promptFreshnessDisposed = true
		this.promptFreshnessInvalidationCoordinator.dispose()
		const cancellationGeneration = this.interactionCoordinator.cancelPending("task_terminated")
		const initialRuntimeState = this.taskRuntime.getState()
		const preserveCompletedState =
			options?.preserveCompletedState === true &&
			initialRuntimeState.phase === TaskPhase.COMPLETED &&
			initialRuntimeState.completion !== undefined
		let cutoffRevision = initialRuntimeState.supersededEffectRevision ?? initialRuntimeState.revision
		try {
			this.invalidatePreparedProviderInputs()
			this.cancelPendingAutoRetry()
			this.modeSwitchCompaction.abort()
			// PHASE 1: Check if TaskCancel should run BEFORE any cleanup
			const shouldRunTaskCancelHook = await this.shouldRunTaskCancelHook()
			logTerminateStage("cancel_hook_check", `shouldRun=${shouldRunTaskCancelHook}`)

			// PHASE 2: Commit the canonical terminal cleanup boundary before setting abort.
			const runtimePhase = this.taskRuntime.getState().phase
			if (!preserveCompletedState && runtimePhase !== TaskPhase.CANCELLING && runtimePhase !== TaskPhase.ABORTED) {
				const terminating = await this.dispatchRuntime({ type: "TASK_TERMINATE_REQUESTED" })
				if (terminating.accepted) {
					cutoffRevision = terminating.next.supersededEffectRevision ?? terminating.next.revision - 1
				} else if (runtimePhase !== TaskPhase.IDLE) {
					Logger.warn(`Task termination transition rejected: ${terminating.error?.code ?? "invalid_runtime_event"}`)
				}
			}
			logTerminateStage(
				"runtime_transition",
				`preserveCompleted=${preserveCompletedState} initialPhase=${initialRuntimeState.phase}`,
			)

			// PHASE 3: Fence every old continuation and stop the provider transport.
			this.taskState.abort = true
			this.taskState.cancelOperations("task_terminated")
			this.api?.abort?.()

			// PHASE 4: Cancel hooks, background commands and task activities in
			// parallel. Each cancellation is individually bounded by a timeout, so
			// the worst-case close latency is one timeout instead of the sum of
			// three sequential timeouts.
			const activeHook = await this.getActiveHookExecution()
			const activeActivityIds = this.activityStore.listRunning().map((activity) => activity.activityId)
			await Promise.allSettled([
				(async () => {
					if (!activeHook) {
						return
					}
					try {
						await withTerminateTimeout(this.cancelHookExecution(), 5_000, "cancelHookExecution")
					} catch (error) {
						Logger.error("Failed to cancel hook during task terminate", error)
					} finally {
						await this.clearActiveHookExecution()
					}
				})(),
				(async () => {
					try {
						await withTerminateTimeout(this.commandExecutor.cancelBackgroundCommand(), 5_000, "cancelAllCommands")
					} catch (error) {
						Logger.error("Failed to cancel command during task terminate", error)
					}
				})(),
				(async () => {
					if (activeActivityIds.length === 0) {
						return
					}
					await withTerminateTimeout(
						this.activityStore.cancel(activeActivityIds),
						5_000,
						"cancelAllTaskActivities",
					).catch((error) => Logger.error("Failed to cancel task activities during terminate", error))
				})(),
			])
			logTerminateStage(
				"cancel_operations",
				`activities=${activeActivityIds.length} activeHook=${activeHook !== undefined}`,
			)

			// Wait for the provider stream and every already-admitted continuation
			// before taking the final persistence snapshot. Timed-out work is fenced
			// by the store close guard below and can no longer write after close.
			await Promise.all([
				pWaitFor(() => !this.taskState.isStreaming || this.taskState.didFinishAbortingStream, {
					interval: 50,
					timeout: 5_000,
				}).catch(() => {}),
				withTerminateTimeout(
					Promise.all([
						this.taskRuntime.waitForDeferredEffectsThrough(cutoffRevision),
						this.interactionCoordinator.waitForClaimedContinuations(),
					]).then(() => undefined),
					5_000,
					"taskTerminate.waitForSupersededOperations",
				),
			])
			logTerminateStage("wait_superseded_operations")

			const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))
			let taskCancelHookPromise = Promise.resolve()
			if (hooksEnabled && shouldRunTaskCancelHook) {
				taskCancelHookPromise = (async () => {
					try {
						await executeHook({
							hookName: "TaskCancel",
							hookInput: {
								taskCancel: {
									taskMetadata: {
										taskId: this.taskId,
										ulid: this.ulid,
										completionStatus: this.taskState.abandoned ? "abandoned" : "cancelled",
									},
								},
							},
							isCancellable: false,
							say: this.say.bind(this),
							messageStateHandler: this.messageStateHandler,
							taskId: this.taskId,
							hooksEnabled,
							model: getHookModelContext(this.api, this.stateManager),
						})
					} catch (error) {
						Logger.error("[TaskCancel Hook] Failed (non-fatal):", error)
					}
				})()
			}

			// Save state before cleanup
			await this.flushTaskSnapshot()
			logTerminateStage("snapshot_flush")
			this.messageStateHandler.publishTaskHistoryClose()
			logTerminateStage("history_event_enqueue")
			await this.postStateToWebview()
			logTerminateStage("intermediate_state_publish")

			// PHASE 6: Check for incomplete progress (focus chain)
			const currentProviderInfo = this.getCurrentProviderInfo()
			const currentPromptProfile = resolvePromptProfile({
				modelId: currentProviderInfo.model.id,
				contextWindow: currentProviderInfo.model.info.capabilities?.contextWindow,
			})
			if (this.FocusChainManager && currentPromptProfile === PromptProfile.Standard) {
				const apiConfig = this.stateManager.getApiConfiguration()
				const currentMode = this.taskSm.mode
				const currentProfile = currentMode === "plan" ? apiConfig.planModeProfile : apiConfig.actModeProfile

				const currentProvider = resolveProviderFromProfile(currentProfile) || DEFAULT_API_PROVIDER
				const currentModelId = this.api.getModel().id
				this.FocusChainManager.checkIncompleteProgressOnCompletion(currentModelId, currentProvider)
			}

			// PHASE 7: Dispose all resources concurrently with per-operation
			// timeouts. A single stuck dispose (e.g. browser, diff revert)
			// must not prevent other resources from being released.
			const syncCleanups = [
				() => {
					// A StandaloneTerminalManager is released through the awaited
					// cleanup below, so disposing it here too would race that work.
					if (!(this.terminalManager instanceof StandaloneTerminalManager)) {
						this.terminalManager.disposeAll()
					}
				},
				() => {
					this.urlContentFetcher.closeBrowser()
				},
				() => {
					try {
						this.taskFileTracker.dispose()
					} catch {
						/* best-effort */
					}
				},
				() => {
					this.fileContextTracker.dispose()
				},
				() => {
					if (this._mcpNotificationCb) {
						this.mcpHub.removeNotificationCallback(this._mcpNotificationCb)
						this._mcpNotificationCb = undefined
					}
				},
				() => {
					if (this.FocusChainManager) this.FocusChainManager.dispose()
				},
				() => this.activityStore.dispose(),
				() => this.taskTelemetry.dispose(),
				// A coalesced view post must not outlive the task it describes.
				() => this.projectionScheduler.dispose(),
			]
			const asyncCleanups: Array<Promise<void>> = [
				withTerminateTimeout(taskCancelHookPromise, 5_000, "taskCancelHook"),
				withTerminateTimeout(
					this.checkpointHashPersistenceChain ?? Promise.resolve(),
					5_000,
					"checkpointHashPersistence",
				),
				withTerminateTimeout(this.apiRateMetricsService.dispose(), 5_000, "apiRateMetricsService.dispose"),
				withTerminateTimeout(this.apiRequestRoundLifecycle.close(), 5_000, "apiRequestRoundLifecycle.close"),
				withTerminateTimeout(this.activityStore.waitForPersistence(), 5_000, "activityStore.waitForPersistence"),
				withTerminateTimeout(this.browserSession.dispose(), 5_000, "browserSession.dispose"),
				withTerminateTimeout(this.diffViewProvider.revertChanges(), 5_000, "diffViewProvider.revertChanges"),
				withTerminateTimeout(this.presentationScheduler.dispose(), 3_000, "presentationScheduler.dispose"),
				withTerminateTimeout(this.disposePromptInputFileWatcher(), 3_000, "promptInputFileWatcher.dispose"),
				// Releases the executor's per-activity tracking and, in vscodeTerminal
				// mode, the standalone manager it created for itself. That manager is
				// not this.terminalManager, so the sync cleanup above never reaches it.
				withTerminateTimeout(this.commandExecutor.dispose(), 5_000, "commandExecutor.dispose"),
				// The standalone manager owns child processes and log descriptors, so
				// the Task waits for its release instead of leaving it to run detached
				// past termination.
				...(this.terminalManager instanceof StandaloneTerminalManager
					? [withTerminateTimeout(this.terminalManager.disposeAsync(), 5_000, "terminalManager.disposeAsync")]
					: []),
			]

			// Run sync cleanups immediately (they are non-blocking)
			for (const fn of syncCleanups) {
				try {
					fn()
				} catch (error) {
					Logger.error("[Terminate] sync cleanup failed:", error)
				}
			}

			// Wait for async cleanups with timeouts
			await Promise.allSettled(asyncCleanups)
			logTerminateStage("resource_cleanup")
		} finally {
			try {
				try {
					await Promise.all([
						this.flushTaskSnapshot(),
						this.messageStateHandler.flushApiConversationHistory(),
						this.messageStateHandler.flushUiMessages(),
					])
					logTerminateStage("final_flush")
					await this.postStateToWebview()
					logTerminateStage("final_state_publish")
				} catch (error) {
					Logger.error("Failed to post final state after terminate", error)
				}
				// Store close is the durability boundary and must not be best-effort:
				// Controller.clearTask releases the task lock only after this resolves.
				await this.messageStateHandler.close()
				logTerminateStage("stores_close")
			} finally {
				this.interactionCoordinator.completeCancellation(cancellationGeneration)
			}
		}
	}

	// Tools
	async executeCommandTool(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<CommandExecutionOutcome> {
		const outcome = await this.commandExecutor.execute(command, timeoutSeconds, options)
		if (outcome.userRejected) {
			await this.rejectCommandExecution(options?.commandTs)
		}
		return outcome
	}

	/** Terminate one running command by its canonical execute_command function identity. */
	private async killCommandTool(functionId: string): Promise<CommandCancellationResult> {
		return this.commandExecutor.cancelCommandByFunctionId(functionId)
	}

	/** Route an in-terminal command rejection through the canonical turn reducer. */
	private async rejectCommandExecution(commandTs: number | undefined): Promise<void> {
		if (commandTs === undefined) return
		const commandBlock = this.taskState.assistantMessageContent.find(
			(block): block is ToolUse =>
				block.type === "tool_use" && block.name === ClineDefaultTool.BASH && block.ts === commandTs,
		)
		if (!commandBlock?.dline_tid) return

		const state = this.taskRuntime.getState()
		const runtimeBlock = state.turn?.blocks.find((block) => block.dlineTid === commandBlock.dline_tid)
		if (!state.turn || !runtimeBlock || this.turnDriver.isTerminalRuntimeBlock(runtimeBlock.phase)) return

		const rejected = await this.dispatchRuntime({
			type: "BLOCK_EXECUTION_REJECTED",
			turnId: state.turn.turnId,
			dlineTid: runtimeBlock.dlineTid,
		})
		if (!rejected.accepted) {
			const current = this.taskRuntime.getState()
			if (this.taskState.abort || current.phase === TaskPhase.CANCELLING) return
			throw new Error(`Command rejection rejected: ${rejected.error?.code ?? "invalid_runtime_event"}`)
		}
	}

	/**
	 * Cancel a background command that is running in the background
	 * @returns true if a command was cancelled, false if no command was running
	 */
	public async cancelBackgroundCommand(): Promise<boolean> {
		return this.commandExecutor.cancelBackgroundCommand()
	}

	/** Rebind one persisted failed subagent before an Activity Retry action. */
	public restoreSubagentActivityRetry(activityId: string): Promise<boolean> {
		return this.toolExecutor.restoreSubagentRetry(activityId)
	}

	/** Return the foreground command or subagent currently eligible for manual background handoff. */
	public getReadyBackgroundHandoffActivityId(): string | undefined {
		return (
			this.commandExecutor.getReadyBackgroundHandoffActivityId() ??
			this.activityStore.getReadyBackgroundHandoffActivityId("subagent")
		)
	}

	/** Return whether the current manual handoff is already transitioning. */
	public isBackgroundHandoffRequested(activityId: string): boolean {
		return this.commandExecutor.isBackgroundHandoffRequested(activityId)
	}

	/** Request that a synchronous foreground command be handed off to background tracking. */
	public async moveCommandToBackground(activityId: string): Promise<boolean> {
		return this.commandExecutor.requestBackgroundHandoff(activityId)
	}

	/** Apply one complete terminal configuration to all task-owned terminal managers. */
	configureTerminal(configuration: TerminalManagerConfiguration): TerminalManagerConfigurationResult {
		return this.commandExecutor.configure(configuration)
	}

	/** Close idle task terminals so project startup scripts run again on the next command. */
	reinitializeTerminals(): TerminalManagerConfigurationResult {
		return this.commandExecutor.reinitializeTerminals()
	}

	/**
	 * Refresh the frozen system prompt cache immediately.
	 * @returns Promise that resolves after context.json has been updated.
	 */
	async refreshPromptCache(): Promise<void> {
		const providerInfo = this.getCurrentProviderInfo()
		const webToolsEnabled = this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true
		const webSearchRoutingPlan = resolveRequestWebSearchRoutingPlan(this.api, webToolsEnabled)
		const promptContext = await this.buildPromptContext(providerInfo, webToolsEnabled, webSearchRoutingPlan)
		await this.systemPromptCacheService.refresh({ promptContext, reason: "manual" })
		await this.postStateToWebview({ immediate: true })
	}

	/** Schedule a debounced re-evaluation after prompt-visible file inputs change. */
	invalidatePromptFreshness(source: PromptFreshnessInvalidationSource): void {
		this.promptFreshnessInvalidationCoordinator.invalidate(source)
	}

	/** Re-evaluate freshness at a durable mutation boundary and publish the result. */
	async flushPromptFreshnessInvalidation(source: PromptFreshnessInvalidationSource): Promise<void> {
		await this.promptFreshnessInvalidationCoordinator.flush(source)
	}

	/** Re-evaluate the active frozen prompt against current prompt inputs without refreshing it. */
	async reevaluatePromptFreshness(): Promise<void> {
		const startedAt = performance.now()
		const providerInfo = this.getCurrentProviderInfo()
		const webToolsEnabled = this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true
		const webSearchRoutingPlan = resolveRequestWebSearchRoutingPlan(this.api, webToolsEnabled)
		const promptContext = await this.buildPromptContext(providerInfo, webToolsEnabled, webSearchRoutingPlan)
		const buildMs = Math.round(performance.now() - startedAt)
		const cacheStartedAt = performance.now()
		await this.systemPromptCacheService.reevaluateFreshness({ promptContext })
		recordPerfPhase(
			PerfDomain.PromptFreshness,
			"reevaluate",
			performance.now() - startedAt,
			{ buildMs, cacheMs: Math.round(performance.now() - cacheStartedAt) },
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[PromptFreshnessPerf] phase=reevaluate taskId=${this.taskId} buildMs=${buildMs} cacheMs=${Math.round(performance.now() - cacheStartedAt)} totalMs=${Math.round(performance.now() - startedAt)}`,
			)
		}
	}

	private async initializePromptInputFileWatcher(): Promise<void> {
		try {
			const globalRulesDirectory = await ensureRulesDirectoryExists()
			if (this.promptFreshnessDisposed) return
			// Tasks of one workspace share a single recursive watch; only the
			// invalidation callback stays task-local.
			const subscription = await getWorkspacePromptInputWatcherRegistry().subscribe({
				taskId: this.taskId,
				cwd: this.cwd,
				globalRulesDirectory,
				workflowDirectories: getWorkflowsScanDirectories(this.cwd).map((directory) => directory.path),
				skillDirectories: getSkillsDirectoriesForScan(this.cwd).map((directory) => directory.path),
				subagentDirectories: getSubagentsScanDirectories(this.cwd).map((directory) => directory.path),
				invalidate: () => this.invalidatePromptFreshness("prompt_input_file"),
				// Pruning is a scan decision, so the recursive workspace watch never
				// descends into trees that listing would skip anyway.
				shouldIgnoreDirectory: (absolutePath) => this.ignoreController.shouldIgnoreDirectory(absolutePath),
			})
			this.promptInputWatcherSubscription = subscription
			if (this.promptFreshnessDisposed) {
				this.promptInputWatcherSubscription = undefined
				await subscription.dispose()
			}
		} catch (error) {
			Logger.error(`[Task ${this.taskId}] Failed to initialize prompt input file watcher:`, error)
		}
	}

	private async disposePromptInputFileWatcher(): Promise<void> {
		await this.promptInputFileWatcherInitialization?.catch(() => undefined)
		const subscription = this.promptInputWatcherSubscription
		this.promptInputWatcherSubscription = undefined
		await subscription?.dispose()
	}

	/**
	 * Cancel a currently running hook execution
	 * @returns true if a hook was cancelled, false if no hook was running
	 */
	/**
	 * Append injectable background results to the next user message.
	 * @param userContent Mutable user content for the next model request.
	 */
	private async appendBackgroundResults(userContent: ClineContent[], options: { preview?: boolean } = {}): Promise<void> {
		const result = await buildTaskBackgroundResults(this.toolExecutor, this.commandExecutor)
		if (!result.text) return
		userContent.push({ type: "text", text: result.text })
		if (!options.preview) {
			this.pendingBackgroundResultIds = {
				subagentIds: result.subagentIds,
				commandIds: result.commandIds,
			}
		}
	}

	/** Commit every one-shot dynamic snapshot after an ordinary request reaches the Provider. */
	private acknowledgeOrdinaryRequestSnapshots(): void {
		const recentlyModifiedFilesSnapshot = this.pendingRecentlyModifiedFilesSnapshot
		if (recentlyModifiedFilesSnapshot) {
			this.fileContextTracker.acknowledgeRecentlyModifiedFiles(recentlyModifiedFilesSnapshot)
			this.pendingRecentlyModifiedFilesSnapshot = undefined
		}
		this.markBackgroundResultsInjected()
		this.markBackgroundResultsConsumed()
		this.markBackgroundCommandOutputSent()
	}

	/**
	 * Mark pending background results as injected into a successfully sent request.
	 */
	private markBackgroundResultsInjected(): void {
		const ids = this.pendingBackgroundResultIds
		if (!ids) return
		this.toolExecutor.getSubagentJobManager().markInjected(ids.subagentIds)
		this.commandExecutor.markBackgroundCommandsInjected(ids.commandIds)
	}

	/**
	 * Mark pending background results as consumed by a successfully sent request.
	 */
	private markBackgroundResultsConsumed(): void {
		const ids = this.pendingBackgroundResultIds
		if (!ids) return
		this.toolExecutor.getSubagentJobManager().markConsumed(ids.subagentIds)
		this.commandExecutor.markBackgroundCommandsConsumed(ids.commandIds)
		this.pendingBackgroundResultIds = undefined
	}

	/** Commit the output counts represented in Environment after the request reaches the model. */
	private markBackgroundCommandOutputSent(): void {
		const snapshots = this.pendingBackgroundCommandLineCounts
		if (!snapshots) return
		this.commandExecutor.markBackgroundCommandOutputSent(snapshots)
		this.pendingBackgroundCommandLineCounts = undefined
	}

	public async cancelHookExecution(): Promise<boolean> {
		const activeHook = await this.getActiveHookExecution()
		if (!activeHook) {
			return false
		}

		const { hookName, toolName, messageTs, abortController } = activeHook

		try {
			// Abort the hook process
			abortController.abort()

			// Update hook message status to "cancelled"
			const clineMessages = this.messageStateHandler.clineMessages
			const hookMessageIndex = clineMessages.findIndex((m) => m.ts === messageTs)
			if (hookMessageIndex !== -1) {
				const cancelledMetadata = {
					hookName,
					toolName,
					status: "cancelled",
					exitCode: 130, // Standard SIGTERM exit code
				}
				await this.messageStateHandler.updateClineMessage(hookMessageIndex, {
					text: JSON.stringify(cancelledMetadata),
				})
			}

			// Notify UI that hook was cancelled
			await this.say("hook_output_stream", "\nHook execution cancelled by user")

			// Return success - let caller (abortTask) handle next steps
			// DON'T call abortTask() here to avoid infinite recursion
			return true
		} catch (error) {
			Logger.error("Failed to cancel hook execution", error)
			return false
		}
	}

	private getCurrentProviderInfo(): ApiProviderInfo {
		const model = this.api.getModel()
		const mode = this.taskSm.mode
		// Read profile from per-task cache first to avoid cross-task interference
		const currentProfile = mode === "plan" ? this.taskSm.planModeProfile : this.taskSm.actModeProfile
		const providerId = resolveProviderFromProfile(currentProfile) || DEFAULT_API_PROVIDER
		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		return { model, providerId, customPrompt, mode }
	}

	/**
	 * Build a thinking summary from the current profile's provider-specific reasoning config.
	 * Returns undefined if no profile is configured or no reasoning data is available.
	 */
	private buildThinkingSummary(): Record<string, unknown> | undefined {
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.taskSm.mode
		const profileName = mode === "plan" ? apiConfig.planModeProfile : apiConfig.actModeProfile
		if (!profileName) {
			return undefined
		}

		const profile = findEnabledProfileByName(profileName)
		if (!profile) {
			return undefined
		}

		// Provider configs use proto-generated camelCase fields when provider ids contain hyphens.
		// Keep the current profile shape and use the shared provider-id to ApiProfile-field map.
		const providerKey = PROFILE_PROVIDER_KEYS[profile.provider]
		const provCfg = providerKey ? profile[providerKey] : undefined
		const reasoning =
			provCfg && typeof provCfg === "object" ? (provCfg as { reasoning?: ReasoningConfig }).reasoning : undefined
		if (!reasoning) {
			return { enableThinking: true, effort: "medium" }
		}

		return {
			enableThinking: reasoning.enableThinking,
			effort: reasoning.effort,
			thinkingBudget: reasoning.thinkingBudget,
		}
	}

	private async writePromptMetadataArtifacts(params: { systemPrompt: string; requestScope: RequestApiScope }): Promise<void> {
		const enabledFlag = process.env.DLINE_WRITE_PROMPT_ARTIFACTS?.toLowerCase()
		const enabled = enabledFlag === "1" || enabledFlag === "true" || enabledFlag === "yes"
		if (!enabled) {
			return
		}

		try {
			const configuredDir = process.env.DLINE_PROMPT_ARTIFACT_DIR?.trim()
			const artifactDir = configuredDir
				? path.isAbsolute(configuredDir)
					? configuredDir
					: path.resolve(this.cwd, configuredDir)
				: path.resolve(this.cwd, ".cline-prompt-artifacts")

			await fs.mkdir(artifactDir, { recursive: true })

			const ts = new Date().toISOString()
			const safeTs = ts.replace(/[:.]/g, "-")
			const baseName = `task-${this.taskId}-req-${this.taskState.apiRequestCount}-${safeTs}`
			const manifestPath = path.join(artifactDir, `${baseName}.manifest.json`)
			const promptPath = path.join(artifactDir, `${baseName}.system_prompt.md`)

			const manifest = {
				taskId: this.taskId,
				ulid: this.ulid,
				apiRequestCount: this.taskState.apiRequestCount,
				ts,
				cwd: this.cwd,
				mode: params.requestScope.providerInfo.mode,
				provider: params.requestScope.providerInfo.providerId,
				model: params.requestScope.providerInfo.model.id,
				apiRequestId: this.getApiRequestIdSafe(params.requestScope.api),
				systemPromptPath: promptPath,
			}

			await Promise.all([
				fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8"),
				fs.writeFile(promptPath, params.systemPrompt, "utf8"),
			])
		} catch (error) {
			Logger.error("Failed to write prompt metadata artifacts:", error)
		}
	}

	private createProviderRequestRoundPort(): ProviderRequestRoundPort {
		return {
			admit: ({ source, apiIndex }) => {
				const resolvedApiIndex = apiIndex ?? this.nextAuxiliaryProviderRoundApiIndex++
				const logicalRequestId = `${source}:${ulid()}`
				return {
					bindAttempt: (stream, taskAttempt) =>
						bindProviderAttemptScope(
							stream,
							this.apiRequestRoundLifecycle.createObserver({
								logicalRequestId,
								apiIndex: resolvedApiIndex,
								taskAttempt,
							}),
						),
					attachExactUsage: (usage) => this.apiRequestRoundLifecycle.attachExactUsage(logicalRequestId, usage),
					completeProviderOnly: () => this.apiRequestRoundLifecycle.completeProviderOnly(logicalRequestId),
					completeTools: (summary) => this.apiRequestRoundLifecycle.completeTools(logicalRequestId, summary),
					completeTurnEndAwaitingUser: (summary) =>
						this.apiRequestRoundLifecycle.completeTurnEndAwaitingUser(logicalRequestId, summary),
				}
			},
		}
	}

	private admitOrdinaryProviderRequestRound(apiIndex: number, taskAttempt: number): ProviderRequestRoundAdmission {
		if (taskAttempt > 0) {
			const existing = this.ordinaryProviderRequestRounds.get(apiIndex)
			if (existing) return existing
		}
		const admission = this.createProviderRequestRoundPort().admit({ source: "ordinary", apiIndex })
		this.ordinaryProviderRequestRounds.set(apiIndex, admission)
		return admission
	}

	private getApiRequestIdSafe(api: ApiHandler = this.api): string | undefined {
		const apiLike = api as Partial<{
			getLastRequestId: () => string | undefined
			lastGenerationId?: string
		}>
		return apiLike.getLastRequestId?.() ?? apiLike.lastGenerationId
	}

	/**
	 * Parse the previous request's total input pressure from UI request metadata.
	 *
	 * @param previousApiReqIndex Index of the previous api_req_started UI message.
	 * @returns Total request pressure tokens, or undefined when metadata is unavailable.
	 */
	private async updateContextCompactionStatus(
		status: NonNullable<ClineSayTool["compactionStatus"]>,
		options: {
			error?: string
			retryAttempt?: number
			maxRetryAttempts?: number
			clearContent?: boolean
			content?: string
		} = {},
	): Promise<void> {
		if (!this.taskState.isInternalContextCompactionRequest && !this.taskState.isManualContextCompactionRequest) return
		const existingTs = this.taskState.contextCompactionMessageTs
		const existing = existingTs
			? this.messageStateHandler.clineMessages.find((message) => message.ts === existingTs)
			: undefined
		let content = ""
		if (!options.clearContent && existing?.text) {
			try {
				const payload = JSON.parse(existing.text) as ClineSayTool
				content = typeof payload.content === "string" ? payload.content : ""
			} catch {
				content = ""
			}
		}
		if (options.content !== undefined) {
			content = options.content
		}
		const payload = JSON.stringify({
			tool: "summarizeTask",
			content,
			compactionStatus: status,
			...(options.error ? { error: options.error } : {}),
			...(options.retryAttempt !== undefined ? { retryAttempt: options.retryAttempt } : {}),
			...(options.maxRetryAttempts !== undefined ? { maxRetryAttempts: options.maxRetryAttempts } : {}),
		} satisfies ClineSayTool)
		const ts = await this.say(
			"tool",
			payload,
			undefined,
			undefined,
			status !== "failed" && status !== "completed",
			existingTs,
		)
		if (ts !== undefined) this.taskState.contextCompactionMessageTs = ts
	}

	/** Remove failed manual compaction output while preserving its durable request for Retry. */
	private async discardFailedManualCompactionAttempt(apiIndex: number): Promise<void> {
		this.presentationScheduler.reset()
		const clineMessages = this.messageStateHandler.clineMessages
		const apiRequestMessageIndex = findLastIndex(clineMessages, (message) => message.say === "api_req_started")
		const compactionMessageTs = this.taskState.contextCompactionMessageTs
		const removableMessageTs =
			apiRequestMessageIndex < 0
				? []
				: clineMessages
						.slice(apiRequestMessageIndex + 1)
						.filter((message) => message.ts !== compactionMessageTs)
						.map((message) => message.ts)
		await this.messageStateHandler.removeMessagesByTs(removableMessageTs, { updateTaskHistory: false })

		const historyIndex = this.compactionRequestReplay.getHistoryIndex(apiIndex) ?? apiIndex
		const apiHistory = this.messageStateHandler.apiConversationHistory
		if (apiHistory[historyIndex]?.role !== "user") {
			throw new Error(`Manual compaction retry request is missing at apiIndex=${apiIndex}, historyIndex=${historyIndex}`)
		}
		if (apiHistory.length > historyIndex + 1) {
			await this.messageStateHandler.truncateApiConversationHistory(historyIndex + 1)
		}
		this.taskState.currentStreamingContentIndex = 0
		this.taskState.assistantMessageContent = []
		this.taskState.userMessageContent = []
		this.taskState.userMessageContentReady = false
		this.pendingReasoningText = undefined
		this.taskState.reasoningTs = undefined
		this.taskState.parseBlockTsByKey.clear()
		this.taskState.parseToolIdentityByKey.clear()
		this.taskState.lastRenderedPartialByTs.clear()
		this.taskState.partialToolLifecycleByTs.clear()
		this.streamHandler.reset()
	}

	/** Remove every provider-produced artifact from a failed automatic compaction attempt. */
	private async discardFailedCompactionAttempt(apiIndex: number): Promise<void> {
		if (!this.compactionRequestReplay.getDeclaration(apiIndex)) return

		this.presentationScheduler.reset()
		const clineMessages = this.messageStateHandler.clineMessages
		const apiRequestMessageIndex = findLastIndex(clineMessages, (message) => message.say === "api_req_started")
		const removableMessageTs = new Set<number>()
		const compactionMessageTs = this.taskState.contextCompactionMessageTs
		if (apiRequestMessageIndex >= 0) {
			for (const message of clineMessages.slice(apiRequestMessageIndex + 1)) {
				if (message.ts !== compactionMessageTs) {
					removableMessageTs.add(message.ts)
				}
			}
		}
		await this.messageStateHandler.removeMessagesByTs([...removableMessageTs], { updateTaskHistory: false })

		const historyIndex = this.compactionRequestReplay.getHistoryIndex(apiIndex)
		const initialConsecutiveMistakeCount = this.compactionRequestReplay.getInitialConsecutiveMistakeCount(apiIndex)
		if (historyIndex === undefined || initialConsecutiveMistakeCount === undefined) {
			throw new Error(`Compaction retry baseline is missing at apiIndex=${apiIndex}`)
		}
		const apiHistory = this.messageStateHandler.apiConversationHistory
		if (apiHistory[historyIndex]?.role !== "user") {
			throw new Error(`Compaction retry request is missing at apiIndex=${apiIndex}, historyIndex=${historyIndex}`)
		}
		if (apiHistory.length > historyIndex + 1) {
			await this.messageStateHandler.truncateApiConversationHistory(historyIndex + 1)
		}

		this.taskState.currentStreamingContentIndex = 0
		this.taskState.consecutiveMistakeCount = initialConsecutiveMistakeCount
		this.taskState.currentlySummarizing = false
		this.taskState.assistantMessageContent = []
		this.taskState.userMessageContent = []
		this.taskState.userMessageContentReady = false
		this.pendingReasoningText = undefined
		this.taskState.reasoningTs = undefined
		this.taskState.parseBlockTsByKey.clear()
		this.taskState.parseToolIdentityByKey.clear()
		this.taskState.lastRenderedPartialByTs.clear()
		this.taskState.partialToolLifecycleByTs.clear()
		this.streamHandler.reset()
	}

	private parsePreviousTokens(previousApiReqIndex: number): number | undefined {
		if (previousApiReqIndex < 0) {
			return undefined
		}

		const previousRequestText = this.messageStateHandler.clineMessages[previousApiReqIndex]?.text
		if (!previousRequestText) {
			return undefined
		}

		try {
			const requestInfo = JSON.parse(previousRequestText) as ClineApiReqInfo
			return getContextTokens(requestInfo)
		} catch {
			return undefined
		}
	}

	/**
	 * Cache the current assistant tool-use turn and remove it from history before summarizing older context.
	 *
	 * @param userContent Pending tool result content for the next request.
	 * @returns True when a current turn was cached and removed from API history.
	 */
	private async deferCurrentTurn(userContent: ClineContent[], includeUserText = true): Promise<boolean> {
		const apiHistory = this.messageStateHandler.apiConversationHistory
		const assistantMessage = apiHistory[apiHistory.length - 1]
		const hasAssistantMessage = assistantMessage?.role === "assistant"

		this.taskState.deferredCurrentTurn = {
			...(hasAssistantMessage ? { assistantMessage: cloneDeep(assistantMessage) } : {}),
			userContent: cloneDeep(userContent),
			compactionContent: includeUserText ? getCompactionUserText(userContent) : [],
		}

		if (hasAssistantMessage) {
			await this.messageStateHandler.truncateApiConversationHistory(apiHistory.length - 1)
		}
		return true
	}

	/**
	 * Restore a deferred current turn after summarize_task has produced compacted context.
	 *
	 * @param summaryContent The summarize_task tool result content containing compacted context.
	 * @returns The deferred tool result content, or the original content if no deferred turn exists.
	 */
	private async restoreDeferredTurn(summaryContent: ClineContent[]): Promise<ClineContent[]> {
		const deferredTurn = this.taskState.deferredCurrentTurn
		if (!deferredTurn) {
			return summaryContent
		}

		this.taskState.deferredCurrentTurn = undefined
		const summaryText = summaryContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n")
		if (summaryText.trim().length > 0) {
			await this.messageStateHandler.addToApiConversationHistory({
				role: "user",
				content: [{ type: "text", text: summaryText }],
				ts: Date.now(),
			})
		}

		if (deferredTurn.assistantMessage) {
			await this.messageStateHandler.addToApiConversationHistory(deferredTurn.assistantMessage)
		}
		return deferredTurn.userContent
	}

	private async handleContextWindowExceededError(
		api: ApiHandler,
		markAutomaticRetry = true,
		keepOverride?: "none" | "lastTwo" | "half" | "quarter",
	): Promise<void> {
		this.ordinaryRequestInputReplay.clear()
		const apiConversationHistory = this.messageStateHandler.apiConversationHistory
		const keep = keepOverride ?? (this.modeSwitchCompaction.shouldForce() ? "lastTwo" : "quarter")

		// Run PreCompact hook before truncation
		const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (hooksEnabled) {
			try {
				// Calculate what the new deleted range will be
				const deletedRange = this.calculatePreCompactDeletedRange(apiConversationHistory, keep)

				// Execute hook - throws HookCancellationError if cancelled
				await executePreCompactHookWithCleanup({
					taskId: this.taskId,
					ulid: this.ulid,
					modelContext: getHookModelContext(api, this.stateManager),
					apiConversationHistory,
					conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					contextManager: this.contextManager,
					clineMessages: this.messageStateHandler.clineMessages,
					messageStateHandler: this.messageStateHandler,
					compactionStrategy: "standard-truncation-lastquarter",
					deletedRange,
					say: this.say.bind(this),
					setActiveHookExecution: async (hookExecution: HookExecution | undefined) => {
						if (hookExecution) {
							await this.setActiveHookExecution(hookExecution)
						}
					},
					clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
					postStateToWebview: this.postStateToWebview.bind(this),
					taskState: this.taskState,
					cancelTask: this.cancelTask.bind(this),
					hooksEnabled,
				})
			} catch (error) {
				// If hook was cancelled, re-throw to stop compaction
				if (error instanceof HookCancellationError) {
					throw error
				}

				// Graceful degradation: Log error but continue with truncation
				Logger.error("[PreCompact] Hook execution failed:", error)
			}
		}

		// A forced mode compaction already selected a pairing-safe tail. Advancing
		// the range here would orphan and drop that latest tool-result turn.
		if (!(this.modeSwitchCompaction.shouldForce() && this.taskState.conversationHistoryDeletedRange)) {
			const candidateDeletedRange = this.contextManager.getNextTruncationRange(
				apiConversationHistory,
				this.taskState.conversationHistoryDeletedRange,
				keep,
			)
			if (candidateDeletedRange[1] >= candidateDeletedRange[0]) {
				this.taskState.conversationHistoryDeletedRange = candidateDeletedRange
			}
		}

		await this.messageStateHandler.updateTaskHistory()
		await this.contextManager.triggerApplyStandardContextTruncationNoticeChange(
			Date.now(),
			await ensureTaskDirectoryExists(this.taskId),
			apiConversationHistory,
		)

		if (markAutomaticRetry) {
			this.taskState.didAutomaticallyRetryFailedApiRequest = true
		}
	}

	/**
	 * Build the current system prompt context for cache creation or refresh.
	 * @returns Prompt context containing current rules, tools, model, and workspace state.
	 */
	private shouldUseNativeToolCalls(providerInfo: Readonly<ApiProviderInfo>): boolean {
		const apiFormat = providerInfo.model.info.apiFormats?.[0]
		const requested =
			apiFormat === ApiFormat.OPENAI_RESPONSES ||
			apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE ||
			this.stateManager.getGlobalStateKey("nativeToolCallEnabled")
		return isNativeToolCallingConfig(providerInfo, requested)
	}

	private getTaskCapabilityToggles(): TaskCapabilityToggles {
		return parseTaskCapabilityToggles(this.taskSm.taskCapabilityToggles) ?? emptyTaskCapabilityToggles()
	}

	private async buildPromptContext(
		providerInfo: Readonly<ApiProviderInfo>,
		webToolsEnabled: boolean,
		webSearchRoutingPlan: WebSearchRoutingPlan,
	): Promise<SystemPromptContext> {
		const startedAt = performance.now()
		let stageStartedAt = startedAt
		const host = await HostProvider.env.getHostVersion({})
		const hostMs = Math.round(performance.now() - stageStartedAt)
		const ide = host?.platform || "Unknown"
		const isCliEnvironment = host.clineType === ClineClient.Cli
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const disableBrowserTool = browserSettings.disableToolUse ?? false
		// Older model metadata only declared image support, so retain that as a compatibility fallback.
		const modelSupportsBrowserUse =
			providerInfo.model.info.capabilities?.supportsBrowserAction ??
			providerInfo.model.info.capabilities?.supportsImages ??
			false

		const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool // only enable browser use if the model supports it and the user hasn't disabled it
		const preferredLanguageRaw = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
				: ""

		stageStartedAt = performance.now()
		const { globalToggles, localToggles } = await refreshClineRulesToggles(this.controller, this.cwd)
		const dlineRulesDiscoveryMs = Math.round(performance.now() - stageStartedAt)
		stageStartedAt = performance.now()
		const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
			this.controller,
			this.cwd,
		)
		const externalRulesDiscoveryMs = Math.round(performance.now() - stageStartedAt)
		stageStartedAt = performance.now()
		const { globalWorkflowToggles, localWorkflowToggles } = await refreshWorkflowToggles(this.controller, this.cwd)
		const workflowsDiscoveryMs = Math.round(performance.now() - stageStartedAt)
		stageStartedAt = performance.now()
		const refreshedSkills = await refreshSkills(this.controller)
		const skillsRefreshMs = Math.round(performance.now() - stageStartedAt)
		stageStartedAt = performance.now()
		const refreshedSubagents = await refreshSubagents(this.controller)
		const subagentsRefreshMs = Math.round(performance.now() - stageStartedAt)
		const remoteConfigSettings = this.stateManager.getRemoteConfigSettings()
		const remoteRulesToggles = this.stateManager.getGlobalStateKey("remoteRulesToggles") ?? {}
		const remoteWorkflowToggles = this.stateManager.getGlobalStateKey("remoteWorkflowToggles") ?? {}
		const currentTaskToggles = this.getTaskCapabilityToggles()
		const discoveredTaskToggles = createTaskCapabilityToggles({
			globalClineRulesToggles: globalToggles,
			localClineRulesToggles: localToggles,
			localCursorRulesToggles: cursorLocalToggles,
			localWindsurfRulesToggles: windsurfLocalToggles,
			localAgentsRulesToggles: agentsLocalToggles,
			globalWorkflowToggles,
			localWorkflowToggles,
			globalSkillsToggles: Object.fromEntries(
				refreshedSkills.globalSkills
					.filter((skill) => !skill.path.startsWith("remote:"))
					.map((skill) => [skill.path, skill.enabled]),
			),
			localSkillsToggles: Object.fromEntries(refreshedSkills.localSkills.map((skill) => [skill.path, skill.enabled])),
			remoteSkillsToggles: Object.fromEntries(
				refreshedSkills.globalSkills
					.filter((skill) => skill.path.startsWith("remote:"))
					.map((skill) => [skill.name, skill.enabled]),
			),
			remoteRulesToggles: Object.fromEntries(
				(remoteConfigSettings.remoteGlobalRules ?? []).map((rule) => [
					rule.name,
					rule.alwaysEnabled || remoteRulesToggles[rule.name] !== false,
				]),
			),
			remoteWorkflowToggles: Object.fromEntries(
				(remoteConfigSettings.remoteGlobalWorkflows ?? []).map((workflow) => [
					workflow.name,
					workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false,
				]),
			),
			globalSubagentsToggles: Object.fromEntries(
				refreshedSubagents.globalSubagents.map((agent) => [agent.path, agent.enabled]),
			),
			localSubagentsToggles: Object.fromEntries(
				refreshedSubagents.localSubagents.map((agent) => [agent.path, agent.enabled]),
			),
			mcpServers: Object.fromEntries(
				this.controller.getMcpServersForOwner().map((server) => [server.name, server.disabled !== true]),
			),
		})
		const taskCapabilityToggles = reconcileTaskCapabilityToggles(currentTaskToggles, discoveredTaskToggles)
		const serializedTaskToggles = serializeTaskCapabilityToggles(taskCapabilityToggles)
		if (serializedTaskToggles !== this.taskSm.taskCapabilityToggles) {
			this.taskSm.setTaskCapabilityToggles(serializedTaskToggles)
		}

		stageStartedAt = performance.now()
		const evaluationContext = await RuleContextBuilder.buildEvaluationContext({
			cwd: this.cwd,
			messageStateHandler: this.messageStateHandler,
			workspaceManager: this.workspaceManager,
		})
		const evaluationContextMs = Math.round(performance.now() - stageStartedAt)

		stageStartedAt = performance.now()
		const globalClineRulesFilePath = await ensureRulesDirectoryExists()
		const globalRules = await getGlobalClineRules(globalClineRulesFilePath, taskCapabilityToggles.globalClineRulesToggles, {
			evaluationContext,
			remoteToggles: taskCapabilityToggles.remoteRulesToggles,
		})
		const globalRulesLoadMs = Math.round(performance.now() - stageStartedAt)
		let globalClineRulesFileInstructions = globalRules.instructions

		// Inject Lazy Teammate Mode rules if enabled
		const lazyTeammateModeEnabled = this.stateManager.getGlobalSettingsKey("lazyTeammateModeEnabled")
		if (lazyTeammateModeEnabled) {
			const { LAZY_TEAMMATE_RULES } = await import("@/core/context/instructions/lazy-teammate-rules")
			globalClineRulesFileInstructions = globalClineRulesFileInstructions
				? `${globalClineRulesFileInstructions}\n\n${LAZY_TEAMMATE_RULES}`
				: LAZY_TEAMMATE_RULES
		}

		const primaryRoot = this.workspaceManager?.getPrimaryRoot()
		const workspaceName = this.getPrimaryWorkspaceName(primaryRoot)
		stageStartedAt = performance.now()
		const localRules = await getLocalClineRules(this.cwd, taskCapabilityToggles.localClineRulesToggles, workspaceName, {
			evaluationContext,
		})
		const localClineRulesFileInstructions = localRules.instructions
		const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
			this.cwd,
			taskCapabilityToggles.localCursorRulesToggles,
		)
		const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(
			this.cwd,
			taskCapabilityToggles.localWindsurfRulesToggles,
		)

		const localAgentsRulesFileInstructions = await getLocalAgentsRules(
			this.cwd,
			taskCapabilityToggles.localAgentsRulesToggles,
			this.ignoreController,
		)
		const localRulesLoadMs = Math.round(performance.now() - stageStartedAt)

		// The prompt describes what the agent may not open, so it carries the read
		// rules rather than the wider scan rules that also hide generated trees.
		const agentIgnoreContent = this.ignoreController.getIgnoreContent("read")
		let clineIgnoreInstructions: string | undefined
		if (agentIgnoreContent) {
			clineIgnoreInstructions = formatResponse.clineIgnoreInstructions(agentIgnoreContent)
		}

		// Prepare multi-root workspace information if enabled
		let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		if (multiRootEnabled && this.workspaceManager) {
			workspaceRoots = this.workspaceManager.getRoots().map((root) => ({
				path: root.path,
				name: root.name || path.basename(root.path), // Fallback to basename if name is undefined
				vcs: root.vcs as string | undefined, // Cast VcsType to string
			}))
		}

		// Discover and filter available skills
		const remoteSkillEntries = this.stateManager.getRemoteConfigSettings().remoteGlobalSkills || []
		const capabilityToggleState = {
			remoteSkillEntries,
			globalSkillsToggles: taskCapabilityToggles.globalSkillsToggles,
			localSkillsToggles: taskCapabilityToggles.localSkillsToggles,
			remoteSkillsToggles: taskCapabilityToggles.remoteSkillsToggles,
			workflowToggles: taskCapabilityToggles.localWorkflowToggles,
			globalWorkflowToggles: taskCapabilityToggles.globalWorkflowToggles,
			remoteWorkflowEntries: remoteConfigSettings.remoteGlobalWorkflows ?? [],
			remoteWorkflowToggles: taskCapabilityToggles.remoteWorkflowToggles,
			subagentToggles: taskCapabilityToggles.localSubagentsToggles,
			globalSubagentToggles: taskCapabilityToggles.globalSubagentsToggles,
		}
		stageStartedAt = performance.now()
		const availableSkills = await discoverAvailableSkills(this.cwd, capabilityToggleState)
		const duplicateSkillsDiscoveryMs = Math.round(performance.now() - stageStartedAt)
		recordPerfPhase(
			PerfDomain.PromptBuild,
			"capability_context",
			performance.now() - startedAt,
			{
				hostMs,
				dlineRulesDiscoveryMs,
				externalRulesDiscoveryMs,
				workflowsDiscoveryMs,
				skillsRefreshMs,
				subagentsRefreshMs,
				evaluationContextMs,
				globalRulesLoadMs,
				localRulesLoadMs,
				duplicateSkillsDiscoveryMs,
				rules: Object.keys(globalToggles).length + Object.keys(localToggles).length,
				workflows: Object.keys(globalWorkflowToggles).length + Object.keys(localWorkflowToggles).length,
				skills: refreshedSkills.globalSkills.length + refreshedSkills.localSkills.length,
				availableSkills: availableSkills.length,
				subagents: refreshedSubagents.globalSubagents.length + refreshedSubagents.localSubagents.length,
			},
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[PromptBuildPerf] phase=capability_context taskId=${this.taskId} hostMs=${hostMs} dlineRulesDiscoveryMs=${dlineRulesDiscoveryMs} externalRulesDiscoveryMs=${externalRulesDiscoveryMs} workflowsDiscoveryMs=${workflowsDiscoveryMs} skillsRefreshMs=${skillsRefreshMs} subagentsRefreshMs=${subagentsRefreshMs} evaluationContextMs=${evaluationContextMs} globalRulesLoadMs=${globalRulesLoadMs} localRulesLoadMs=${localRulesLoadMs} duplicateSkillsDiscoveryMs=${duplicateSkillsDiscoveryMs} totalMs=${Math.round(performance.now() - startedAt)} rules=${Object.keys(globalToggles).length + Object.keys(localToggles).length} workflows=${Object.keys(globalWorkflowToggles).length + Object.keys(localWorkflowToggles).length} skills=${refreshedSkills.globalSkills.length + refreshedSkills.localSkills.length} availableSkills=${availableSkills.length} subagents=${refreshedSubagents.globalSubagents.length + refreshedSubagents.localSubagents.length}`,
			)
		}

		// Disable spawn_task for child tasks to prevent recursive spawn explosion.
		// A spawned task inherits the parent's provider and should focus on its
		// assigned sub-problem without spawning further tasks.
		const disableTools: ClineDefaultTool[] = []
		if (providerInfo.mode === "plan") {
			disableTools.push(ClineDefaultTool.ACT_MODE)
		}
		const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
		const parentTaskId = OrchestratorController.getInstance().getParentTaskId(this.taskId)
		if (parentTaskId) {
			disableTools.push(ClineDefaultTool.SPAWN_TASK)
		}

		const boundImageModelId = resolveAvailableImageModelId(this.stateManager, {
			taskId: this.taskId,
			getCurrentMode: () => this.getMode(),
		})

		const promptContext: SystemPromptContext = {
			taskId: this.taskId,
			promptProfile: resolvePromptProfile({
				modelId: providerInfo.model.id,
				contextWindow: providerInfo.model.info.capabilities?.contextWindow,
			}),
			cwd: this.cwd,
			ide,
			providerInfo,
			supportsBrowserUse,
			mcpHub:
				this.stateManager.getGlobalSettingsKey("mcpEnabled") === true
					? {
							getServers: () =>
								this.mcpHub
									.getServersForOwner(this.controller.mcpOwnerId)
									.filter((server) => taskCapabilityToggles.mcpServers[server.name] === true),
						}
					: undefined,
			skills: availableSkills,
			focusChainSettings: this.stateManager.getGlobalSettingsKey("focusChainSettings"),
			globalClineRulesFileInstructions,
			localClineRulesFileInstructions,
			localCursorRulesFileInstructions,
			localCursorRulesDirInstructions,
			localWindsurfRulesFileInstructions,
			localAgentsRulesFileInstructions,
			clineIgnoreInstructions,
			preferredLanguageInstructions,
			browserSettings: this.stateManager.getGlobalSettingsKey("browserSettings"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			subagentsEnabled: this.stateManager.getGlobalSettingsKey("subagentsEnabled"),
			clineWebToolsEnabled: webToolsEnabled,
			webSearchRoutingPlan,
			imageGenerationAvailable: boundImageModelId !== undefined,
			imageModelId: boundImageModelId,
			isMultiRootEnabled: multiRootEnabled,
			workspaceRoots,
			isSubagentRun: false,
			isCliEnvironment,
			enableNativeToolCalls: this.shouldUseNativeToolCalls(providerInfo),
			enableParallelToolCalling: this.resolveParallelToolCallingEnabled(providerInfo),
			terminalExecutionMode: this.terminalExecutionMode,
			defaultTerminalProfile: this.stateManager.getGlobalSettingsKey("defaultTerminalProfile") ?? "default",
			terminalCommandTimeoutSeconds:
				this.stateManager.getGlobalSettingsKey("terminalCommandTimeoutSeconds") ??
				DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS,
			disableTools,
			capabilityToggleState,
			taskCapabilityToggles,
		}

		return promptContext
	}

	/** Build one complete provider-neutral request input from an explicit conversation snapshot. */
	private async buildProviderInput(
		previousApiReqIndex: number,
		requestScope: RequestApiScope,
		options: {
			apiConversationHistory?: ClineStorageMessage[]
			applyContextManagement?: boolean
			applyCompactionProjection?: boolean
			preview?: boolean
			conversationHistoryDeletedRange?: [number, number] | null
		} = {},
	): Promise<CompactionProviderInput> {
		const { api, providerInfo } = requestScope
		const apiConversationHistory = options.apiConversationHistory ?? this.messageStateHandler.apiConversationHistory
		const applyContextManagement = options.applyContextManagement !== false
		const applyCompactionProjection = options.applyCompactionProjection !== false
		const promptContext = await this.buildPromptContext(
			providerInfo,
			requestScope.webToolsEnabled,
			requestScope.webSearchRoutingPlan,
		)
		const refreshReason = options.preview ? undefined : this.pendingSystemPromptRefreshReason
		let frozenPrompt: FrozenSystemPromptCache
		if (refreshReason) {
			try {
				frozenPrompt = await this.systemPromptCacheService.refresh({ promptContext, reason: refreshReason })
			} catch (error) {
				Logger.warn(`[Task ${this.taskId}] Failed to refresh frozen system prompt after ${refreshReason}:`, error)
				frozenPrompt = await this.systemPromptCacheService.getOrCreate({ promptContext })
			} finally {
				if (!options.preview) this.pendingSystemPromptRefreshReason = undefined
			}
		} else {
			frozenPrompt = await this.systemPromptCacheService.getOrCreate({ promptContext })
		}

		const systemPrompt = frozenPrompt.text
		const runtime = resolveFrozenPromptRuntime(frozenPrompt, promptContext)
		const toolPromptGenerator = new ToolPromptGenerator()
		const selectedTools = toolPromptGenerator.generateToolsForRequest(
			promptContext.promptProfile,
			promptContext,
			this.systemPromptCacheService.getLastTools(),
		)
		const tools = selectedTools ? [...selectedTools] : undefined
		let managedMessages: ClineStorageMessage[]
		if (applyContextManagement) {
			const contextManagementMetadata = await this.contextManager.getNewContextMessagesAndMetadata(
				apiConversationHistory,
				this.messageStateHandler.clineMessages,
				api,
				this.taskState.conversationHistoryDeletedRange,
				previousApiReqIndex,
				await ensureTaskDirectoryExists(this.taskId),
				this.modeSwitchCompaction.shouldForce() || this.stateManager.getGlobalSettingsKey("useAutoCondense"),
				this.getAutoCondenseTriggerOptions(),
			)
			if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
				this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
				await this.messageStateHandler.updateTaskHistory()
			}
			managedMessages = applyCompactionProjection
				? this.projectCanonicalContext(apiConversationHistory)
				: contextManagementMetadata.truncatedConversationHistory
		} else if (applyCompactionProjection) {
			managedMessages = this.projectCanonicalContext(apiConversationHistory)
		} else {
			const deletedRange =
				options.conversationHistoryDeletedRange === undefined
					? this.taskState.conversationHistoryDeletedRange
					: options.conversationHistoryDeletedRange
			managedMessages =
				deletedRange === null
					? cloneDeep(apiConversationHistory)
					: this.contextManager.getTruncatedMessages(cloneDeep(apiConversationHistory), deletedRange)
		}

		const messages = ensureApiMessages(managedMessages, apiConversationHistory)
		const serverTools = Object.freeze([
			...new Set([...runtime.webSearchRoutingPlan.serverTools, ...requestScope.hostedImageGenerationPlan.serverTools]),
		])

		return { systemPrompt, messages, tools, serverTools, runtime, providerOutputCap: undefined }
	}

	/** Build the exact ordinary candidate used by the final admission projection. */
	private buildOrdinaryProviderInput(
		previousApiReqIndex: number,
		requestScope: RequestApiScope,
		apiConversationHistory: ClineStorageMessage[],
		options: { preview?: boolean } = {},
	): Promise<CompactionProviderInput> {
		return this.buildProviderInput(previousApiReqIndex, requestScope, {
			apiConversationHistory,
			applyContextManagement: false,
			preview: options.preview,
		})
	}

	async *attemptApiRequest(
		previousApiReqIndex: number,
		requestScope: RequestApiScope,
		apiIndex = this.messageStateHandler.apiConversationHistory.length - 1,
		providerAttempt = 0,
	): ApiStream {
		const apiReqStart = performance.now()
		const { api, providerInfo } = requestScope
		Logger.debug(`[Task ${this.taskId}] attemptApiRequest: start (req #${this.taskState.apiRequestCount})`)

		const replayProviderInput = this.compactionRequestReplay.getProviderInput(apiIndex)
		let providerInput: CompactionProviderInput
		let providerInputSource: "compaction_replay" | "prepared" | "rebuilt"
		if (replayProviderInput) {
			providerInput = replayProviderInput
			providerInputSource = "compaction_replay"
		} else {
			const preparedProviderInput = this.ordinaryRequestInputReplay.get(apiIndex)
			if (preparedProviderInput) {
				providerInput = preparedProviderInput
				providerInputSource = "prepared"
			} else {
				providerInput = await this.buildProviderInput(previousApiReqIndex, requestScope)
				providerInputSource = "rebuilt"
			}
			// Capture the canonical compaction input only while a replay owner is
			// actually active for this API index. A stale compaction flag from an
			// earlier turn must not throw here; it just skips caching.
			const replayOwnsIndex = this.compactionRequestReplay.getHistoryIndex(apiIndex) !== undefined
			if (
				replayOwnsIndex &&
				(this.taskState.isInternalContextCompactionRequest || this.taskState.isManualContextCompactionRequest)
			) {
				providerInput = this.compactionRequestReplay.captureProviderInput(apiIndex, providerInput)
			}
		}

		const { systemPrompt, messages: apiConversationMessages, tools, serverTools, runtime, providerOutputCap } = providerInput
		this.activeProviderInputRuntime = runtime
		this.toolExecutor.setAllowedNativeToolNames(getAdvertisedNativeToolNames(tools))
		requestScope.explicitInstructions.beginProviderAttempt(providerAttempt === 0 ? undefined : `attempt-${providerAttempt}`)
		if (this.taskState.isInternalContextCompactionRequest && this.taskState.targetWindowFittingState) {
			const authorization = requestScope.explicitInstructions.getPendingToolAuthorization(ClineDefaultTool.SUMMARIZE_TASK)
			if (!authorization) {
				throw new Error("Current fitting Pass is missing summarize_task authorization")
			}
			this.compactionRequestReplay.beginAttempt(apiIndex, authorization.attemptId)
		}
		this.toolExecutor.setExplicitInstructionConsumePort(requestScope.explicitInstructions.createConsumePort())
		if (runtime) {
			this.toolExecutor.setPromptRuntime(runtime)
		} else {
			this.toolExecutor.setWebSearchRoutingPlan(requestScope.webSearchRoutingPlan, requestScope.webToolsEnabled)
		}
		this.toolExecutor.setHostedImageGenerationContext({
			enabled: serverTools.includes(ServerTool.IMAGE_GENERATION),
			providerId: providerInfo.providerId,
			modelId: providerInfo.model.id,
		})
		Logger.debug(
			`[Task ${this.taskId}] attemptApiRequest: after systemPrompt +${Math.round(performance.now() - apiReqStart)}ms`,
		)
		this.useNativeToolCalls = !!tools?.length
		await this.writePromptMetadataArtifacts({ systemPrompt, requestScope })

		const roundContext = {
			taskId: this.taskId,
			requestIndex: this.taskState.apiRequestCount,
			provider: providerInfo.providerId,
			model: providerInfo.model.id,
		}
		await recordProviderAdapterInput(roundContext, { systemPrompt, messages: apiConversationMessages, tools })
		// Log the API request context: profile, provider, model, and thinking status
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = providerInfo.mode
		const profileName = mode === "plan" ? apiConfig.planModeProfile : apiConfig.actModeProfile
		const thinkingSummary = this.buildThinkingSummary()
		Logger.info(`[Task ${this.taskId}] sending API request`, {
			taskId: this.taskId,
			apiRequestCount: this.taskState.apiRequestCount,
			mode,
			profileName: profileName ?? "(none)",
			provider: providerInfo.providerId,
			modelId: providerInfo.model.id,
			thinking: thinkingSummary ?? null,
		})

		const isOrdinaryIndicatorRequest =
			!this.taskState.isInternalContextCompactionRequest && !this.taskState.isManualContextCompactionRequest
		const ordinaryIndicatorLineage = isOrdinaryIndicatorRequest
			? await this.beginOrdinaryContextWindowIndicator(apiIndex, providerAttempt, requestScope, providerInput)
			: undefined

		if (isCompactionDevDiagnosticsEnabled()) {
			const requestKind = this.taskState.isInternalContextCompactionRequest
				? "automatic_compaction"
				: this.taskState.isManualContextCompactionRequest
					? "manual_compaction"
					: "ordinary"
			const snapshot = createCompactionProviderDiagnosticSnapshot({
				requestKind,
				providerId: providerInfo.providerId,
				modelId: providerInfo.model.id,
				apiFormat: api.getSelectedApiFormat?.(),
				systemPrompt,
				messages: apiConversationMessages,
				tools,
				serverTools,
			})
			const ordinaryBaseline = requestKind === "ordinary" ? undefined : this.latestOrdinaryCompactionDiagnostic
			const fittingState = this.taskState.targetWindowFittingState
			const completedCards = readCompletedCompactionCards(this.messageStateHandler.clineMessages)
			Logger.debug(`[CompactionDiag] provider-input`, {
				taskId: this.taskId,
				apiIndex,
				providerAttempt,
				providerInputSource,
				requestKind,
				restoredFromHistory: this.restoredFromHistory,
				provider: snapshot.providerId,
				modelId: snapshot.modelId,
				apiFormat: snapshot.apiFormat,
				operationId: fittingState?.operationId ?? null,
				passIndex: fittingState?.passIndex ?? null,
				passStartTurnIndex: fittingState?.passStartTurnIndex ?? null,
				passEndTurnIndex: fittingState?.passEndTurnIndex ?? null,
				coveredTurnCount: fittingState?.coveredTurnCount ?? null,
				passStartMessageIndex: fittingState?.passStartMessageIndex ?? null,
				passEndMessageIndex: fittingState?.passEndMessageIndex ?? null,
				passInputCeiling: fittingState?.passInputCeiling ?? null,
				estimatedInputTokens: fittingState?.estimatedInputTokens ?? null,
				candidateEstimateCount: fittingState?.candidateEstimateCount ?? null,
				deletedRange: this.taskState.conversationHistoryDeletedRange ?? null,
				completedCards: completedCards.map((card) => ({
					range: card.range,
					summaryHash: hashCompactionDiagnosticValue(card.summary),
				})),
				cumulativeSummaryHash: fittingState?.cumulativeSummary
					? hashCompactionDiagnosticValue(fittingState.cumulativeSummary)
					: null,
				pendingPromptRefreshReason: this.pendingSystemPromptRefreshReason ?? null,
				runtimeHash: hashCompactionDiagnosticValue(runtime ?? null),
				promptIdentityHash: snapshot.promptIdentityHash,
				systemPromptHash: snapshot.systemPromptHash,
				toolsHash: snapshot.toolsHash,
				serverToolsHash: snapshot.serverToolsHash,
				messageCount: snapshot.messageHashes.length,
				firstMessageHash: snapshot.messageHashes[0] ?? null,
				ordinaryBaselineAvailable: ordinaryBaseline !== undefined,
				firstDivergence: ordinaryBaseline ? findCompactionProviderFirstDivergence(ordinaryBaseline, snapshot) : null,
			})
			if (requestKind === "ordinary") this.latestOrdinaryCompactionDiagnostic = snapshot
		}

		if (Logger.isDebugEnabled()) {
			const rawMessages = this.messageStateHandler.apiConversationHistory
			const toolNameByFunctionId = new Map<string, string>()
			for (const history of [rawMessages, apiConversationMessages]) {
				for (const message of history) {
					if (message.role !== "assistant" || !Array.isArray(message.content)) continue
					for (const block of message.content) {
						if (block.type === "tool_use") toolNameByFunctionId.set(block.function_id, block.name)
					}
				}
			}
			const summarizeHistory = (history: ClineStorageMessage[]) => {
				let toolResultCount = 0
				let toolResultBytes = 0
				let readFileResultCount = 0
				let readFileResultBytes = 0
				for (const message of history) {
					if (message.role !== "user" || !Array.isArray(message.content)) continue
					for (const block of message.content) {
						if (block.type !== "tool_result") continue
						const blockBytes = Buffer.byteLength(JSON.stringify(block), "utf8")
						toolResultCount += 1
						toolResultBytes += blockBytes
						if (toolNameByFunctionId.get(block.function_id) === ClineDefaultTool.FILE_READ) {
							readFileResultCount += 1
							readFileResultBytes += blockBytes
						}
					}
				}
				const bytes = Buffer.byteLength(JSON.stringify(history), "utf8")
				return { bytes, toolResultCount, toolResultBytes, readFileResultCount, readFileResultBytes }
			}
			const rawHistory = summarizeHistory(rawMessages)
			const sentHistory = summarizeHistory(apiConversationMessages)
			const systemPromptBytes = Buffer.byteLength(systemPrompt, "utf8")
			const toolsBytes = Buffer.byteLength(JSON.stringify(tools ?? []), "utf8")
			const serverToolsBytes = Buffer.byteLength(JSON.stringify(serverTools ?? []), "utf8")
			const contextBytes = systemPromptBytes + sentHistory.bytes + toolsBytes + serverToolsBytes
			Logger.debug(`[ContextDiag] pre-send`, {
				taskId: this.taskId,
				apiIndex,
				providerAttempt,
				providerInputSource,
				provider: providerInfo.providerId,
				modelId: providerInfo.model.id,
				deletedRange: this.taskState.conversationHistoryDeletedRange ?? null,
				rawMessageCount: rawMessages.length,
				sentMessageCount: apiConversationMessages.length,
				rawHistoryBytes: rawHistory.bytes,
				sentHistoryBytes: sentHistory.bytes,
				sentMinusRawHistoryBytes: sentHistory.bytes - rawHistory.bytes,
				rawToolResultCount: rawHistory.toolResultCount,
				sentToolResultCount: sentHistory.toolResultCount,
				rawToolResultBytes: rawHistory.toolResultBytes,
				sentToolResultBytes: sentHistory.toolResultBytes,
				rawReadFileResultCount: rawHistory.readFileResultCount,
				sentReadFileResultCount: sentHistory.readFileResultCount,
				rawReadFileResultBytes: rawHistory.readFileResultBytes,
				sentReadFileResultBytes: sentHistory.readFileResultBytes,
				toolCount: tools?.length ?? 0,
				serverToolCount: serverTools?.length ?? 0,
				systemPromptBytes,
				toolsBytes,
				serverToolsBytes,
				contextBytes,
				estimatedContextTokensByBytes: Math.ceil(contextBytes / 4),
				providerOutputCap: providerOutputCap ?? null,
			})
		}
		const providerRequestStartedAtMs = performance.now()
		const providerRequestRound = this.admitOrdinaryProviderRequestRound(apiIndex, providerAttempt)
		const providerStream = providerRequestRound.bindAttempt(
			recordProviderAdapterOutput(
				roundContext,
				api.createMessage(systemPrompt, apiConversationMessages, tools, {
					serverTools,
					taskNamespace: this.taskId,
					retryOwner: "task",
					...(providerOutputCap === undefined
						? {}
						: { generation: { purpose: "compaction", maxOutputTokens: providerOutputCap } as const }),
				}),
			),
			providerAttempt,
		)
		const stream = this.apiRateMetricsService.trackProviderStream(providerStream)

		const iterator = stream[Symbol.asyncIterator]()
		let firstChunkAtMs = providerRequestStartedAtMs

		try {
			// awaiting first chunk to see if it will throw an error
			this.taskState.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			firstChunkAtMs = performance.now()
			// A first chunk proves that the request in the active retry sequence
			// reached the provider. Keep Cancel for the live stream, but release
			// the retry-sequence-owned Retry action.
			if (!firstChunk.done) {
				if (isOrdinaryIndicatorRequest) this.ordinaryRequestInputReplay.acknowledge(apiIndex)
				this.endAutoRetrySequence(false)
				await this.clearAutoRetryMessages()
				await this.postStateToWebview()
			}
			// A provider stream that ends without yielding any chunk (e.g. a
			// Responses stream that only emitted codex.rate_limits / metadata /
			// response.failed events) must fail explicitly. Yielding undefined
			// here would surface as "Cannot read properties of undefined
			// (reading 'type')" in the stream normalizer downstream.
			if (firstChunk.done) {
				throw new Error("API stream ended without producing any content")
			}
			if (ordinaryIndicatorLineage) {
				await this.receiveOrdinaryContextWindowIndicator(apiIndex, ordinaryIndicatorLineage, firstChunk.value)
			}
			yield firstChunk.value
			if (!this.taskState.isInternalContextCompactionRequest && !this.taskState.isManualContextCompactionRequest) {
				this.acknowledgeOrdinaryRequestSnapshots()
			}
			this.taskState.isWaitingForFirstChunk = false
			Logger.debug(
				`[Task ${this.taskId}] attemptApiRequest: upstream TTFB ${Math.round(firstChunkAtMs - providerRequestStartedAtMs)}ms`,
			)
		} catch (error) {
			this.taskState.isWaitingForFirstChunk = false
			if (ordinaryIndicatorLineage) {
				await this.rollbackOrdinaryContextWindowIndicator(apiIndex, ordinaryIndicatorLineage)
			}
			if (this.taskState.abort) {
				Logger.debug(`[Task ${this.taskId}] API request stopped after task cancellation`)
				throw new Error("Dline instance aborted")
			}
			if (isOrdinaryIndicatorRequest && isDeterministicToolPairingError(error)) {
				const rebuildDecision = this.ordinaryRequestInputReplay.prepareCanonicalRebuild(apiIndex)
				if (rebuildDecision === "rebuild") {
					const frozenInput = this.ordinaryRequestInputReplay.get(apiIndex)
					if (!frozenInput) throw new Error(`Frozen ordinary request is unavailable for apiIndex=${apiIndex}`)
					this.ordinaryRequestInputReplay.replaceAfterCanonicalRebuild(apiIndex, {
						...frozenInput,
						messages: this.projectCanonicalContext(),
					})
					Logger.warn(`[Task ${this.taskId}] Replaying one canonical tool-pairing rebuild`, { apiIndex })
					yield* this.attemptApiRequest(previousApiReqIndex, requestScope, apiIndex, providerAttempt + 1)
					return
				}
				if (rebuildDecision === "exhausted") throw error
			}
			const openAiMaxOutputReplayDecision = this.taskState.isInternalContextCompactionRequest
				? this.compactionRequestReplay.prepareOpenAiMaxOutputReplay(apiIndex, error)
				: "not_applicable"
			if (this.taskState.isInternalContextCompactionRequest) {
				await this.discardFailedCompactionAttempt(apiIndex)
			}
			if (openAiMaxOutputReplayDecision === "replay") {
				await this.updateContextCompactionStatus("retrying", {
					error: error instanceof Error ? error.message : "OpenAI output limit exceeded",
					retryAttempt: 1,
					maxRetryAttempts: 1,
					clearContent: true,
				})
				yield* this.attemptApiRequest(previousApiReqIndex, requestScope, apiIndex, providerAttempt + 1)
				return
			}
			if (openAiMaxOutputReplayDecision === "exhausted") {
				throw error
			}

			const isContextWindowExceededError = checkContextWindowExceededError(error)
			const autoCondenseEnabled = this.stateManager.getGlobalSettingsKey("useAutoCondense") === true
			const { model, providerId } = providerInfo
			// Use provider-specific parseError if available, otherwise fall back to generic classification.
			// Telemetry: toClineError logs internally; parseError must log manually when used.
			const clineError = api.parseError?.(error, model.id) ?? ErrorService.get().toClineError(error, model.id, providerId)
			if (api.parseError) {
				ErrorService.get().logException(clineError, { modelId: model.id, providerId })
			}

			// Capture provider failure telemetry using clineError
			ErrorService.get().logMessage(clineError.message)

			if (this.taskState.isManualContextCompactionRequest) {
				// The outer request boundary removes partial manual summary UI and reports one terminal failure.
				throw error
			}

			if (
				isContextWindowExceededError &&
				!autoCondenseEnabled &&
				!this.taskState.isInternalContextCompactionRequest &&
				!this.taskState.didAutomaticallyRetryFailedApiRequest
			) {
				await this.handleContextWindowExceededError(api)
			} else {
				// request failed after retrying automatically once, ask user if they want to retry again
				// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.

				if (isContextWindowExceededError && !autoCondenseEnabled && !this.taskState.isInternalContextCompactionRequest) {
					const truncatedConversationHistory = this.contextManager.getTruncatedMessages(
						this.messageStateHandler.apiConversationHistory,
						this.taskState.conversationHistoryDeletedRange,
					)

					// If the conversation has more than 3 messages, we can truncate again. If not, then the conversation is bricked.
					// ToDo: Allow the user to change their input if this is the case.
					if (truncatedConversationHistory.length > 3) {
						clineError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
						this.taskState.didAutomaticallyRetryFailedApiRequest = false
					}
				}

				const streamingFailedMessage = clineError.serialize()

				// Update the 'api_req_started' message to reflect final failure before asking user to manually retry
				const lastApiReqStartedIndex = findLastIndex(
					this.messageStateHandler.clineMessages,
					(m) => m.say === "api_req_started",
				)
				if (lastApiReqStartedIndex !== -1) {
					const clineMessages = this.messageStateHandler.clineMessages
					const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[lastApiReqStartedIndex].text || "{}")
					delete currentApiReqInfo.retryStatus

					await this.messageStateHandler.updateClineMessage(lastApiReqStartedIndex, {
						text: JSON.stringify({
							...currentApiReqInfo, // Spread the modified info (with retryStatus removed)
							// cancelReason: "retries_exhausted", // Indicate that automatic retries failed
							streamingFailedMessage,
						} satisfies ClineApiReqInfo),
					})
					// this.ask will trigger postStateToWebview, so this change should be picked up.
				}

				const isAuthError = clineError.isErrorType(ClineErrorType.Auth)
				const isSpendLimitError = clineError.isErrorType(ClineErrorType.SpendLimit)
				const quotaExceeded = clineError.isErrorType(ClineErrorType.QuotaExceeded)

				// Check if this is an insufficient credits / balance error - don't auto-retry these
				const isInsufficientCredits = clineError.isErrorType(ClineErrorType.Balance)

				let response: ClineAskResponse
				const manualRetryTakeover = this.hasManualRetryTakeover()
				// Skip auto-retry after explicit user takeover or for non-recoverable account errors.
				const shouldRetry =
					!manualRetryTakeover &&
					this.taskState.autoRetryAttempts < MAX_AUTO_RETRY_ATTEMPTS &&
					(!isContextWindowExceededError ||
						!autoCondenseEnabled ||
						this.taskState.isInternalContextCompactionRequest) &&
					(this.taskState.isInternalContextCompactionRequest ||
						(!isInsufficientCredits && !isAuthError && !isSpendLimitError && !quotaExceeded))
				if (shouldRetry) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++
					await this.updateContextCompactionStatus("retrying", {
						error: clineError.message,
						retryAttempt: this.taskState.autoRetryAttempts,
						maxRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS,
						clearContent: true,
					})

					// Calculate delay: 2s, 4s, 8s
					const delay = getRetryDelay(this.taskState.autoRetryAttempts)

					await updateApiReqMsg({
						messageStateHandler: this.messageStateHandler,
						lastApiReqIndex: lastApiReqStartedIndex,
						inputTokens: 0,
						outputTokens: 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
						contextTokens: 0,
						totalCost: undefined,
						api,
						cancelReason: "streaming_failed",
						streamingFailedMessage,
					})
					await this.messageStateHandler.updateTaskHistory()
					await this.postStateToWebview()

					response = "yesButtonClicked"
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: streamingFailedMessage,
						}),
					)

					// Clear streamingFailedMessage now that error_retry contains it
					// This prevents showing the error in both ErrorRow and error_retry
					const autoRetryApiReqIndex = findLastIndex(
						this.messageStateHandler.clineMessages,
						(m) => m.say === "api_req_started",
					)
					if (autoRetryApiReqIndex !== -1) {
						const clineMessages = this.messageStateHandler.clineMessages
						const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[autoRetryApiReqIndex].text || "{}")
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateClineMessage(autoRetryApiReqIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})
					}

					if (!(await this.waitForAutoRetry(delay))) {
						throw new Error("Dline instance aborted")
					}
				} else {
					await this.updateContextCompactionStatus("failed", {
						error: clineError.message,
					})
					if (!manualRetryTakeover && this.taskState.autoRetryAttempts >= MAX_AUTO_RETRY_ATTEMPTS) {
						await this.markAutoRetryExhausted(streamingFailedMessage)
					}
					this.endAutoRetrySequence(false)
					// The outer stream boundary owns canonical API recovery. Opening the
					// retained Task.ask waiter here creates a second, divergent phase state.
					this.taskState.autoRetryAttempts = MAX_AUTO_RETRY_ATTEMPTS
					throw error
				}

				if (response !== "yesButtonClicked") {
					// this will never happen since if noButtonClicked, we will clear current task, aborting this instance
					throw new Error("API request failed")
				}

				// Clear streamingFailedMessage when user manually retries
				const manualRetryApiReqIndex = findLastIndex(
					this.messageStateHandler.clineMessages,
					(m) => m.say === "api_req_started",
				)
				if (manualRetryApiReqIndex !== -1) {
					const clineMessages = this.messageStateHandler.clineMessages
					const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[manualRetryApiReqIndex].text || "{}")
					delete currentApiReqInfo.streamingFailedMessage
					await this.messageStateHandler.updateClineMessage(manualRetryApiReqIndex, {
						text: JSON.stringify(currentApiReqInfo),
					})
				}

				await this.say("api_req_retried")

				// Reset the automatic retry flag so the request can proceed
				this.taskState.didAutomaticallyRetryFailedApiRequest = false
			}
			// delegate generator output from the recursive call
			yield* this.attemptApiRequest(previousApiReqIndex, requestScope, apiIndex, providerAttempt + 1)
			return
		}

		// no error, so we can continue to yield all remaining chunks
		// (needs to be placed outside of try/catch since it we want caller to handle errors not with api_req_failed as that is reserved for first chunk failures only)
		// this delegates to another generator or iterable object. In this case, it's saying "yield all remaining values from this iterator". This effectively passes along all subsequent chunks from the original stream.
		for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
			if (ordinaryIndicatorLineage) {
				await this.receiveOrdinaryContextWindowIndicator(apiIndex, ordinaryIndicatorLineage, chunk)
			}
			yield chunk
		}
		const timing = calculateApiRequestTiming({
			requestStartedAtMs: apiReqStart,
			providerRequestStartedAtMs,
			firstChunkAtMs,
			streamCompletedAtMs: performance.now(),
		})
		let activeTasks = 1
		try {
			activeTasks = OrchestratorController.getInstance().getControllerCount()
		} catch {
			// Unit and CLI contexts may not initialize the VS Code orchestrator.
		}
		Logger.debug(
			`[Task ${this.taskId}] API timing: request=${this.taskState.apiRequestCount}, localPrepareMs=${timing.localPrepareMs}, upstreamTtfbMs=${timing.upstreamTtfbMs}, streamMs=${timing.streamMs}, totalMs=${timing.totalMs}, activeTasks=${activeTasks}`,
		)
	}

	// Block identity is now assigned at parse time via parseAssistantMessageV2's
	// source-offset ts registry. No post-hoc matching needed.

	/**
	 * Compute a stable render signature for same-ts content dedup.
	 * Used only to skip re-sending identical partial events — never for block identity.
	 */
	private computeBlockRenderSignature(block: AssistantMessageContent): string {
		if (block.type === "text") {
			return `text:${(block as TextStreamContent).content}`
		}
		if (block.type === "tool_use") {
			const tool = block as ToolUse
			return JSON.stringify({ name: tool.name, params: tool.params })
		}
		return ""
	}

	/**
	 * Keep every mutating tool side effect behind the durable initial checkpoint.
	 *
	 * Provider inference and read-only tool presentation may overlap checkpoint
	 * initialization, but partial edit rendering can already open a DiffView and
	 * create a worktree placeholder before the finalized tool executes. Gating at
	 * the Task-to-ToolExecutor boundary keeps both partial and complete paths under
	 * the same baseline contract.
	 */
	private async awaitInitialCheckpointBeforeToolSideEffects(toolName: string): Promise<void> {
		const checkpointCommit = this.initialCheckpointCommitPromise
		if (!checkpointCommit || READ_ONLY_TOOLS.some((readOnlyTool) => readOnlyTool === toolName)) {
			return
		}

		await checkpointCommit
		if (this.initialCheckpointCommitPromise === checkpointCommit) {
			this.initialCheckpointCommitPromise = undefined
		}
	}

	/** Return whether the current assistant turn may have changed workspace files. */
	private assistantTurnMayModifyWorkspace(): boolean {
		return this.taskState.assistantMessageContent.some(
			(block) => block.type === "tool_use" && !READ_ONLY_TOOLS.some((readOnlyTool) => readOnlyTool === block.name),
		)
	}

	/**
	 * Re-render partial blocks whose content has changed since last presentation,
	 * and replay complete execution for tool blocks that transitioned from partial
	 * to non-partial after the presentation index advanced past them.
	 */
	private async reRenderUpdatedPartialBlocks(blocks: AssistantMessageContent[]): Promise<void> {
		for (let i = 0; i < this.taskState.currentStreamingContentIndex; i++) {
			const block = blocks[i]
			if (block === undefined) continue
			if (block.type === "reasoning") continue

			const blockTs = (block as TextStreamContent | ToolUse).ts
			if (blockTs === undefined) continue

			// ── Non-partial: tool lifecycle complete execution ──
			if (!(block as TextStreamContent | ToolUse).partial) continue

			// ── Partial: existing content-change rerender ──
			const newSig = this.computeBlockRenderSignature(block as TextStreamContent | ToolUse)
			const oldSig = this.taskState.lastRenderedPartialByTs.get(blockTs)
			if (newSig === oldSig) continue

			if (block.type === "text") {
				const textBlock = block as TextStreamContent
				await this.say("text", textBlock.content, undefined, undefined, true, blockTs)
				this.taskState.lastRenderedPartialByTs.set(blockTs, newSig)
			} else if (block.type === "tool_use") {
				await this.awaitInitialCheckpointBeforeToolSideEffects(block.name)
				if (this.taskState.abort) return
				await this.toolExecutor.reRenderPartialBlock(block as ToolUse, blockTs)
				this.taskState.lastRenderedPartialByTs.set(blockTs, newSig)
			}
		}
	}

	async presentAssistantMessage(context?: PresentationFlushContext) {
		if (context && !context.isCurrent()) return
		if (this.taskState.abort) {
			throw new Error("Dline instance aborted")
		}

		// If we're locked, mark pending and return
		if (this.taskState.presentAssistantMessageLocked) {
			this.taskState.presentAssistantMessageHasPendingUpdates = true
			return
		}

		this.taskState.presentAssistantMessageLocked = true
		this.taskState.presentAssistantMessageHasPendingUpdates = false

		// Frame-local flags: state mutations happen inside try, recursive calls
		// happen after finally releases the lock.
		let shouldRecurse = false
		let didAdvance = false

		try {
			if (context && !context.isCurrent()) return
			// Re-render blocks that have changed since last presentation
			await this.reRenderUpdatedPartialBlocks(this.taskState.assistantMessageContent)
			if (context && !context.isCurrent()) return

			if (this.taskState.currentStreamingContentIndex >= this.taskState.assistantMessageContent.length) {
				return
			}

			const block = cloneDeep(this.taskState.assistantMessageContent[this.taskState.currentStreamingContentIndex])
			switch (block.type) {
				case "text": {
					if (
						this.taskController.hasAnyRejection() ||
						(!this.isParallelToolCallingEnabled() && this.taskState.didAlreadyUseTool)
					) {
						break
					}
					const textBlock = block as TextStreamContent
					let content = textBlock.content
					if (content) {
						content = content.replace(/<thinking>\s?/g, "")
						content = content.replace(/\s?<\/thinking>/g, "")
						content = content.replace(/<think>\s?/g, "")
						content = content.replace(/\s?<\/think>/g, "")
						content = content.replace(/<function_calls>\s?/g, "")
						content = content.replace(/\s?<\/function_calls>/g, "")
						const lastOpenBracketIndex = content.lastIndexOf("<")
						if (lastOpenBracketIndex !== -1) {
							const possibleTag = content.slice(lastOpenBracketIndex)
							const hasCloseBracket = possibleTag.includes(">")
							if (!hasCloseBracket) {
								let tagContent: string
								if (possibleTag.startsWith("</")) {
									tagContent = possibleTag.slice(2).trim()
								} else {
									tagContent = possibleTag.slice(1).trim()
								}
								const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
								const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
								if (isOpeningOrClosing || isLikelyTagName) {
									content = content.slice(0, lastOpenBracketIndex).trim()
								}
							}
						}
					}
					if (!block.partial) {
						const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
						if (match) {
							content = content.trimEnd().slice(0, -match[0].length)
						}
					}
					// Use block.ts assigned at parse time for identity.
					// Use block.ts assigned at parse time for identity.
					const existingTs = (block as TextStreamContent).ts
					if (context && !context.isCurrent()) return
					const returnedTs = await this.say("text", content, undefined, undefined, block.partial, existingTs)
					if (context && !context.isCurrent()) return
					if (block.partial) {
						if (returnedTs !== undefined) {
							this.taskState.lastRenderedPartialByTs.set(returnedTs, this.computeBlockRenderSignature(block))
						}
					}
					break
				}
				case "tool_use":
					// Partial tools may stream UI immediately. Complete tools wait until
					// stream finalization and are executed by the extracted turn driver.
					if (!block.partial && !this.taskState.didCompleteReadingStream) {
						return
					}

					if (block.partial) {
						await this.awaitInitialCheckpointBeforeToolSideEffects(block.name)
						if (this.taskState.abort) return
						if (context && !context.isCurrent()) return
						await this.toolExecutor.executeTool(block)
						if (block.ts !== undefined) {
							this.taskState.partialToolLifecycleByTs.set(block.ts, "partial-shown")
						}
					}
					break
			}

			// Determine whether to advance to next block (all state mutations
			// happen here inside the try block).
			const _isToolPartial = block.type === "tool_use" && block.partial
			if (
				!block.partial ||
				this.taskController.hasAnyRejection() ||
				(!this.isParallelToolCallingEnabled() && this.taskState.didAlreadyUseTool)
			) {
				this.taskState.currentStreamingContentIndex++
				didAdvance = true
				if (this.taskState.currentStreamingContentIndex < this.taskState.assistantMessageContent.length) {
					shouldRecurse = true
				}
			}
		} finally {
			// Always release the lock, even if reRender, say(), or executeTool throws.
			this.taskState.presentAssistantMessageLocked = false
		}

		// Safe to recurse now that the lock is released.
		if (context && !context.isCurrent()) return
		if (shouldRecurse) {
			await this.presentAssistantMessage(context)
		} else if (!didAdvance && this.taskState.presentAssistantMessageHasPendingUpdates) {
			await this.presentAssistantMessage(context)
		}
	}

	private completeProviderExecutionAtAwaitingUser(turnId: string, interactionId: string): void {
		const execution = this.turnEndProviderExecutions.get(interactionId)
		if (!execution || execution.turnId !== turnId) return
		execution.admission.completeTurnEndAwaitingUser(
			this.summarizeProviderExecutionTools(turnId, interactionId, execution.toolCount),
		)
		this.turnEndProviderExecutions.delete(interactionId)
	}

	private completeProviderExecutionTurn(admission?: ProviderRequestRoundAdmission): void {
		if (!admission) return
		const execution = this.activeProviderExecutionTurns.get(admission)
		if (this.taskState.abort || this.taskRuntime.getState().phase === TaskPhase.CANCELLING) {
			if (execution) {
				for (const interactionId of execution.turnEndInteractionIds) this.turnEndProviderExecutions.delete(interactionId)
				this.activeProviderExecutionTurns.delete(admission)
			}
			return
		}
		if (!execution) {
			admission.completeProviderOnly()
			return
		}
		admission.completeTools(this.summarizeProviderExecutionTools(execution.turnId, undefined, execution.toolCount))
		for (const interactionId of execution.turnEndInteractionIds) this.turnEndProviderExecutions.delete(interactionId)
		this.activeProviderExecutionTurns.delete(admission)
	}

	private summarizeProviderExecutionTools(
		turnId: string,
		awaitingInteractionId?: string,
		fallbackToolCount = 0,
	): ApiResponseExecutionToolSummary {
		const runtimeTurn = this.taskRuntime.getState().turn
		const blocks = runtimeTurn?.turnId === turnId ? runtimeTurn.blocks : this.taskController.getBlocks()
		let completedToolCount = 0
		let failedToolCount = 0
		let cancelledToolCount = 0
		for (const block of blocks) {
			if (block.dlineTid === awaitingInteractionId || block.phase === BlockPhase.COMPLETED) {
				completedToolCount += 1
				continue
			}
			if (
				block.phase === BlockPhase.EXECUTING ||
				block.phase === BlockPhase.AUTO_EXECUTING ||
				block.phase === BlockPhase.REJECTED
			) {
				failedToolCount += 1
				continue
			}
			if (
				block.phase === BlockPhase.SKIPPED ||
				block.phase === BlockPhase.CANCELLED ||
				block.phase === BlockPhase.AWAITING_APPROVAL ||
				block.phase === BlockPhase.STREAMING
			) {
				cancelledToolCount += 1
			}
		}
		if (blocks.length === 0 && fallbackToolCount > 0) {
			const fallbackCompletedToolCount = awaitingInteractionId ? 1 : 0
			return {
				toolCount: fallbackToolCount,
				completedToolCount: fallbackCompletedToolCount,
				failedToolCount: 0,
				cancelledToolCount: fallbackToolCount - fallbackCompletedToolCount,
			}
		}
		const toolCount = completedToolCount + failedToolCount + cancelledToolCount
		return { toolCount, completedToolCount, failedToolCount, cancelledToolCount }
	}

	/** Present one request-local Profile admission failure without locking future sends. */
	private async presentApiProfileAdmissionFailure(
		userContent: ClineContent[],
		apiIndex: number,
		validity: ApiProfileValidity,
		persistedRequest: boolean,
	): Promise<boolean> {
		const presentation = validity.message ?? "Profile not valid: the current Profile is unavailable."
		if (!persistedRequest) {
			const request = userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n")
			await this.say(
				"api_req_started",
				JSON.stringify({ request, streamingFailedMessage: presentation } satisfies ClineApiReqInfo),
			)
			await this.messageStateHandler.addToApiConversationHistory({ role: "user", content: userContent, ts: Date.now() })
			await this.messageStateHandler.flushApiConversationHistory()
		}
		await this.admitApiRequest(apiIndex)
		const interactionId = `profile-admission:${this.taskId}:${this.getRuntimeState().revision}`
		try {
			await this.recoverApiFailure({
				turnId: interactionId,
				interactionId,
				apiIndex,
				presentation,
				persistedRequest: true,
			})
			return true
		} catch (error) {
			if (!isInteractionCancellationError(error) || error.reason !== "profile_recovered") {
				throw error
			}
		}

		// A Profile switch resolves only the failed request. Keep this Task loop
		// alive until the user submits a new request, which will validate the new binding.
		this.taskState.userMessageContent = []
		this.taskState.userMessageContentReady = false
		await pWaitFor(() => this.taskState.abort || this.taskState.userMessageContentReady, { interval: 10 })
		if (this.taskState.abort) return true
		const continuationContent = [...this.taskState.userMessageContent]
		this.taskState.userMessageContentReady = false
		return this.recursivelyMakeClineRequests(continuationContent)
	}

	/** Admit one provider request through the canonical runtime gate. */
	private async admitApiRequest(apiIndex: number): Promise<void> {
		const apiStarted = await this.dispatchRuntime({ type: "API_REQUEST_STARTED", apiIndex })
		if (!apiStarted.accepted) {
			throw new Error(`API request start rejected: ${apiStarted.error?.code ?? "invalid_runtime_event"}`)
		}
	}

	/** Finish every request-local write-ahead gate before the Provider request is admitted. */
	private async completeApiRequestGate(
		requestScope: RequestApiScope,
		apiIndex: number,
		beforeApiRequestStarted?: () => Promise<void>,
	): Promise<boolean> {
		// The gate sits between the context projection and the provider request,
		// and it can wait on an interaction. Without entry and exit records a
		// wait here reads in the log as a request that was simply never sent,
		// with the previous line hours earlier and nothing naming this stage.
		const gateEnteredAt = performance.now()
		Logger.debug(`[Task ${this.taskId}] requestGate phase=enter apiIndex=${apiIndex}`)
		await beforeApiRequestStarted?.()
		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const settingsVersion = autoApprovalSettings.version ?? 1
		const hostedWebAdmission = this.toolExecutor.prepareAdmission({
			type: "tool_use",
			name: ClineDefaultTool.WEB_SEARCH,
			params: { query: "Hosted Web Search" },
			partial: false,
			ts: Date.now(),
			function_id: `hosted-web:${this.taskId}:${apiIndex}`,
			dline_tid: `hosted-web:${this.taskId}:${apiIndex}`,
		})
		const webSearchAutoApproved =
			hostedWebAdmission.outcome === "admitted" &&
			(hostedWebAdmission.decision.kind === "automatic" || hostedWebAdmission.decision.kind === "none")
		const hostedApprovalLeased = this.taskState.hostedWebApprovalLeaseVersion === settingsVersion
		const hostedApprovalSatisfied = webSearchAutoApproved || hostedApprovalLeased
		const routingPlan =
			this.ordinaryRequestInputReplay.get(apiIndex)?.runtime?.webSearchRoutingPlan ??
			this.compactionRequestReplay.getProviderInput(apiIndex)?.runtime?.webSearchRoutingPlan ??
			requestScope.webSearchRoutingPlan
		if (routingPlan.route === "hosted" && !hostedApprovalSatisfied) {
			await this.interactionCoordinator.releaseApiContinuationForRequestGate()
		}
		const approvalRequestedAt = performance.now()
		const approval = await requestHostedWebApproval(this.interactionCoordinator, {
			taskId: this.taskId,
			apiIndex,
			providerId: requestScope.providerInfo.providerId,
			routingPlan,
			autoApproved: hostedApprovalSatisfied,
		})
		// Approval duration separates a gate blocked on a user decision from one
		// blocked on a response that never arrived. Both stall the request, but
		// only the second one is a defect.
		Logger.debug(
			`[Task ${this.taskId}] requestGate phase=approval apiIndex=${apiIndex} route=${routingPlan.route} ` +
				`autoApproved=${hostedApprovalSatisfied} approved=${approval.approved} required=${approval.required} ` +
				`waitedMs=${Math.round(performance.now() - approvalRequestedAt)}`,
		)
		if (!approval.approved) {
			Logger.debug(
				`[Task ${this.taskId}] requestGate phase=exit apiIndex=${apiIndex} outcome=rejected ` +
					`elapsedMs=${Math.round(performance.now() - gateEnteredAt)}`,
			)
			const interactionId = `hosted-web-rejected:${this.taskId}:${apiIndex}`
			const rejected = await this.dispatchRuntime({
				type: "HOSTED_WEB_REQUEST_REJECTED",
				apiIndex,
				turnId: interactionId,
				interactionId,
				presentation: "Hosted Web Search was rejected. Resume when you are ready to continue without this request.",
			})
			if (!rejected.accepted) {
				throw new Error(`Hosted Web rejection recovery rejected: ${rejected.error?.code ?? "invalid_runtime_event"}`)
			}
			return false
		}
		if (approval.required) this.taskState.hostedWebApprovalLeaseVersion = settingsVersion
		await this.admitApiRequest(apiIndex)
		Logger.debug(
			`[Task ${this.taskId}] requestGate phase=exit apiIndex=${apiIndex} outcome=admitted ` +
				`elapsedMs=${Math.round(performance.now() - gateEnteredAt)}`,
		)
		return true
	}

	/** Persist the request user message and finish any write-ahead transaction before API admission. */
	private isTrustedUserFeedbackResult(block: ClineUserToolResultContentBlock): boolean {
		return this.taskState.assistantMessageContent.some(
			(candidate): candidate is ToolUse =>
				candidate.type === "tool_use" &&
				candidate.function_id === block.function_id &&
				candidate.dline_tid === block.dline_tid &&
				CONVERSATIONAL_TOOL_NAMES.has(candidate.name as ClineDefaultTool),
		)
	}

	/** Parse the persisted API request pressure records that still describe the live conversation. */
	private getContextWindowRequestPressures() {
		return collectContextWindowRequestPressures(this.messageStateHandler.clineMessages)
	}

	/** Append one high-pressure warning to the dynamic environment block. */
	private appendHighContextPressureWarning(userContent: ClineContent[], warning: string): void {
		if (!warning || userContent.some((block) => block.type === "text" && block.text.includes("# High Context Pressure"))) {
			return
		}
		const environmentBlock = [...userContent]
			.reverse()
			.find(
				(block): block is ClineTextContentBlock => block.type === "text" && block.text.includes("<environment_details>"),
			)
		if (!environmentBlock) {
			userContent.push({ type: "text", text: warning })
			return
		}
		environmentBlock.text = environmentBlock.text.replace("</environment_details>", `\n\n${warning}\n</environment_details>`)
	}

	/** Build one durable Retry candidate without repeating request preprocessing or persistence. */
	private async buildPersistedRequestCandidate(
		previousApiReqIndex: number,
		requestScope: RequestApiScope,
		apiIndex: number,
		persistedRequestApiIndex: number,
	): Promise<CompactionProviderInput> {
		const frozen = this.ordinaryRequestInputReplay.get(apiIndex)
		if (frozen) return frozen
		if (persistedRequestApiIndex !== this.messageStateHandler.apiConversationHistory.length - 1) {
			throw new Error(`Persisted API request is not the active history tail at historyIndex=${persistedRequestApiIndex}`)
		}
		return this.buildOrdinaryProviderInput(
			previousApiReqIndex,
			requestScope,
			cloneDeep(this.messageStateHandler.apiConversationHistory),
		)
	}

	/** Project one durable Retry candidate without rebuilding dynamic request context. */
	private projectPersistedRequestContextWindow(
		providerInput: CompactionProviderInput,
		requestScope: RequestApiScope,
		apiIndex: number,
	): { projection: ContextWindowProjection; candidateEstimatedTokens: number } {
		const candidateEstimatedTokens = estimateContextWindowCandidate(providerInput, {
			providerId: requestScope.providerInfo.providerId,
			modelId: requestScope.providerInfo.model.id,
		})
		const { contextWindow } = getContextWindowInfo(requestScope.api)
		const projection = resolveContextWindowProjection({
			requestInfos: this.getContextWindowRequestPressures(),
			candidateEstimatedTokens,
			contextWindow,
			triggerTokens: computeCompactTrigger(contextWindow, computeSummarizeBudget(), this.getAutoCondenseTriggerOptions()),
		})
		this.ordinaryRequestInputReplay.freeze(apiIndex, providerInput)
		return { projection, candidateEstimatedTokens }
	}

	/** Evaluate the complete unsent ordinary candidate and freeze the exact admitted provider input. */
	private async evaluateFinalContextWindowGuard(
		userContent: ClineContent[],
		previousApiReqIndex: number,
		requestScope: RequestApiScope,
		apiIndex: number,
	): Promise<{ projection: ContextWindowProjection; candidateEstimatedTokens: number }> {
		const buildCandidate = () => {
			const prospectiveHistory: ClineStorageMessage[] = [
				...cloneDeep(this.messageStateHandler.apiConversationHistory),
				{ role: "user", content: cloneDeep(userContent), ts: Date.now() },
			]
			return this.buildOrdinaryProviderInput(previousApiReqIndex, requestScope, prospectiveHistory)
		}
		const { contextWindow } = getContextWindowInfo(requestScope.api)
		const triggerTokens = computeCompactTrigger(contextWindow, computeSummarizeBudget(), this.getAutoCondenseTriggerOptions())
		let candidateInput = await buildCandidate()
		const candidateEstimator = {
			providerId: requestScope.providerInfo.providerId,
			modelId: requestScope.providerInfo.model.id,
		}
		let candidateEstimatedTokens = estimateContextWindowCandidate(candidateInput, candidateEstimator)
		let projection = resolveContextWindowProjection({
			requestInfos: this.getContextWindowRequestPressures(),
			candidateEstimatedTokens,
			contextWindow,
			triggerTokens,
		})
		const warning = getHighContextPressureWarning({
			contextWindow,
			lastApiReqTotalTokens: projection.projectedUsageTokens,
			modelId: requestScope.providerInfo.model.id,
		})
		if (warning) {
			this.appendHighContextPressureWarning(userContent, warning)
			candidateInput = await buildCandidate()
			candidateEstimatedTokens = estimateContextWindowCandidate(candidateInput, candidateEstimator)
			projection = resolveContextWindowProjection({
				requestInfos: this.getContextWindowRequestPressures(),
				candidateEstimatedTokens,
				contextWindow,
				triggerTokens,
			})
		}
		this.ordinaryRequestInputReplay.freeze(apiIndex, candidateInput)
		Logger.debug(`[Task ${this.taskId}] final context-window projection`, {
			apiIndex,
			candidateEstimatedTokens,
			contextWindow,
			baselineTokens: projection.baselineTokens,
			pendingDeltaTokens: projection.pendingDeltaTokens,
			candidateDeltaTokens: projection.candidateDeltaTokens,
			projectedUsageTokens: projection.projectedUsageTokens,
			pressureSource: projection.pressureSource,
			shouldCompact: projection.shouldCompact,
		})
		return { projection, candidateEstimatedTokens }
	}

	private async persistApiRequestUserMessage(
		userContent: ClineContent[],
		apiIndex: number,
		requestScope: RequestApiScope,
		beforeApiRequestStarted?: () => Promise<void>,
	): Promise<boolean> {
		await this.messageStateHandler.addToApiConversationHistory({
			role: "user",
			content: userContent,
			ts: Date.now(),
		})
		// The queued input is now part of the conversation, which is the point
		// at which it has actually been handed over. Settling here rather than
		// on the recursion's return value matters because that value only says
		// whether the loop ended: several paths return normally without ever
		// sending a request, and treating those as delivered would consume the
		// input for nothing.
		//
		// This runs before the flush on purpose. The append is what puts the
		// text into the conversation; if the flush then fails, releasing the
		// claim would put the entry back in the queue while the round still
		// carries it, and it would be sent a second time. An entry that is
		// dropped here is at least visibly gone, and the user still has what
		// they typed.
		if (this.inputQueueCoordinator.hasStagedDelivery) {
			await this.settleStagedQueueDelivery(true)
		}
		await this.messageStateHandler.flushApiConversationHistory()
		return this.completeApiRequestGate(requestScope, apiIndex, beforeApiRequestStarted)
	}

	async recursivelyMakeClineRequests(
		userContent: ClineContent[],
		includeFileDetails = false,
		transaction: ApiRequestTransactionOptions = {},
	): Promise<boolean> {
		// Check abort flag at the very start to prevent any execution after cancellation
		if (this.taskState.abort) {
			throw new Error("Task instance aborted")
		}
		// Internal transition compaction owns a frozen target scope; user requests revalidate the current binding.
		const transitionScope = this.modeSwitchCompaction.getExecutionScope()
		const requestMode = transitionScope?.mode ?? this.taskSm.mode
		const profileValidity: ApiProfileValidity = transitionScope
			? { status: "valid" }
			: await this.rebuildApiHandler({ validateCredentials: true })
		if (!transitionScope && this.syncContextWindowIndicatorScope()) {
			await this.postStateToWebview({ immediate: true })
		}
		const persistedRequestApiIndex = transaction.persistedRequestApiIndex
		const persistedRequest = persistedRequestApiIndex !== undefined
		if (!persistedRequest) {
			userContent = await this.consumeModeSwitchChatContent(userContent)
		}
		const originalUserContent = cloneDeep(userContent)

		// Ensure remote workspace detection completes before streaming begins so
		// the presentation scheduler uses the correct cadence from the first flush.
		await this.remoteWorkspaceDetectionPromise

		// Increment API request counters once, even when a pre-request gate resumes through a runtime effect.
		if (!transaction.reuseRequestAccounting) {
			this.taskState.apiRequestCount++
			this.taskState.apiRequestsSinceLastTodoUpdate++
		}
		const apiIndex =
			transaction.logicalApiIndex ?? persistedRequestApiIndex ?? this.messageStateHandler.apiConversationHistory.length
		if (
			persistedRequest &&
			(persistedRequestApiIndex < 0 ||
				persistedRequestApiIndex !== this.messageStateHandler.apiConversationHistory.length - 1)
		) {
			throw new Error(
				`Persisted API request is not the active history tail: logicalApiIndex=${apiIndex}, historyIndex=${persistedRequestApiIndex}`,
			)
		}
		if (profileValidity.status === "invalid") {
			return this.presentApiProfileAdmissionFailure(userContent, apiIndex, profileValidity, persistedRequest)
		}
		// Capture the request boundary from the same Profile snapshot that passed admission.
		const requestScope = createRequestApiScope(
			transitionScope?.api ?? this.api,
			requestMode,
			this.stateManager.getGlobalSettingsKey("customPrompt"),
			this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled"),
			this.explicitInstructionRegistry,
			this.stateManager.getCanonicalSettingsKey("imageGenerationEnabled"),
		)
		if (persistedRequest) {
			const replayDeclaration = this.compactionRequestReplay.getDeclaration(apiIndex)
			if (replayDeclaration) {
				requestScope.explicitInstructions.register(replayDeclaration)
				const isManualCompaction =
					replayDeclaration.source === "manual_compact_command" || replayDeclaration.source === "task_header"
				this.taskState.isManualContextCompactionRequest = isManualCompaction
				this.taskState.isInternalContextCompactionRequest = !isManualCompaction
			}
		}

		// Used to know what models were used in the task if user wants to export metadata for error reporting purposes
		const { model, providerId, customPrompt, mode } = requestScope.providerInfo
		if (providerId && model.id) {
			try {
				await this.modelContextTracker.recordModelUsage(providerId, model.id, mode)
			} catch {}
		}

		const modelInfo: ClineMessageModelInfo = {
			modelId: model.id,
			providerId: providerId,
			mode: mode,
		}

		if (
			!persistedRequest &&
			this.taskState.consecutiveMistakeCount >= this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")
		) {
			// In yolo mode, don't wait for user input - fail the task
			if (this.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
				const errorMessage =
					`[YOLO MODE] Task failed: Too many consecutive mistakes (${this.taskState.consecutiveMistakeCount}). ` +
					`The model may not be capable enough for this task. Consider using a more capable model.`
				await this.say("error", errorMessage)
				// End the task loop with failure
				return true // didEndLoop = true, signals task completion/failure
			}

			const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
			if (autoApprovalSettings.enableNotifications) {
				showSystemNotification({
					subtitle: "Error",
					message: "Cline is having trouble. Would you like to continue the task?",
				})
			}
			const presentation = model.id.includes("claude")
				? `This may indicate a failure in Dline's thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
				: "Dline uses complex prompts and iterative task execution. Verify your chosen model supports advanced agentic coding and complex prompt following."
			const interactionId = `mistake-limit:${this.taskId}:${this.getRuntimeState().revision}`
			await this.interactionCoordinator.recoverMistakeLimit({
				turnId: interactionId,
				interactionId,
				apiIndex,
				presentation,
			})
			return true
		}

		// get previous api req's index to check token usage and determine if we need to truncate conversation history
		const previousApiReqIndex = findLastIndex(this.messageStateHandler.clineMessages, (m) => m.say === "api_req_started")

		// Save checkpoint if this is the first API request
		const isFirstRequest =
			!persistedRequest && this.messageStateHandler.clineMessages.filter((m) => m.say === "api_req_started").length === 0

		const checkpointsEnabled = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
		const checkpointManager = this.checkpointManager
		let checkpointInitializationPromise: Promise<boolean> | undefined
		if (isFirstRequest && checkpointsEnabled && checkpointManager && !this.taskState.checkpointManagerErrorMessage) {
			// Initialization and baseline creation may overlap the first provider request.
			// The first non-read-only tool still awaits initialCheckpointCommitPromise,
			// so the model cannot modify the workspace before the baseline is durable.
			checkpointInitializationPromise = ensureCheckpointInitialized({ checkpointManager })
				.then(() => true)
				.catch((error) => {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					Logger.error("Failed to initialize checkpoint manager:", errorMessage)
					this.taskState.checkpointManagerErrorMessage = errorMessage
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Checkpoint initialization timed out: ${errorMessage}`,
					})
					return false
				})
		}

		// The chat checkpoint remains available even when the file checkpoint backend failed.
		if (isFirstRequest && checkpointsEnabled && checkpointManager) {
			await this.say("checkpoint_created")
			const lastCheckpointMessageIndex = findLastIndex(
				this.messageStateHandler.clineMessages,
				(m) => m.say === "checkpoint_created",
			)
			if (checkpointInitializationPromise) {
				const persistCommitPromise = checkpointInitializationPromise.then(async (initialized) => {
					if (!initialized) return undefined
					const commitHash = await checkpointManager.commit()
					if (commitHash && lastCheckpointMessageIndex !== -1) {
						await this.persistCheckpointHashToMessage(lastCheckpointMessageIndex, commitHash)
					}
					return commitHash
				})
				this.initialCheckpointCommitPromise = persistCommitPromise
				// Observe baseline failures even when no mutating tool ever awaits the
				// commit. Hash persistence owns its own store-bound chain above.
				void persistCommitPromise.catch((error) => {
					Logger.error(`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.taskId}:`, error)
				})
			}
		} else if (
			isFirstRequest &&
			this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") &&
			!this.checkpointManager &&
			this.taskState.checkpointManagerErrorMessage
		) {
			// Checkpoints are enabled, but tracker failed to initialize.
			// checkpointManagerErrorMessage is already set and will be part of the state.
			// No explicit UI message here, error message will be in ExtensionState.
		}

		// Determine if we should compact context window
		// Note: We delay context loading until we know if we're compacting (performance optimization)
		const useCompactPrompt = customPrompt === "compact" && isLocalModel(requestScope.providerInfo)
		let shouldCompact = false
		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")
		const autoCondenseTriggerOptions = this.getAutoCondenseTriggerOptions()
		const targetWindowFittingCommitted = this.taskState.targetWindowFittingCommitted
		this.taskState.targetWindowFittingCommitted = false
		const forceFinalGuardCompact = transaction.forceCompaction === true
		const canCompactBeforeAdmission = transaction.beforeApiRequestStarted === undefined
		const manualCompactionRequested =
			!persistedRequest && hasManualCompactionIntent(userContent, (block) => this.isTrustedUserFeedbackResult(block))
		const manualCompactionCommitted = !persistedRequest && this.taskState.manualCompactionCommitted
		const manualHistoryTruncationCommitted = !persistedRequest && this.taskState.manualHistoryTruncationCommitted
		if (!persistedRequest) {
			this.taskState.manualCompactionCommitted = false
			this.taskState.manualHistoryTruncationCommitted = false
		}
		// An ordinary turn that follows a completed manual compaction must not
		// keep the stale manual flag; it would otherwise make the next request
		// attempt to capture a replay that has already been cleared.
		if (
			!persistedRequest &&
			!this.taskState.isInternalContextCompactionRequest &&
			this.taskState.isManualContextCompactionRequest &&
			!manualCompactionRequested &&
			!this.taskState.currentlySummarizing &&
			this.compactionRequestReplay.getHistoryIndex(apiIndex) === undefined
		) {
			this.taskState.isManualContextCompactionRequest = false
		}

		const didCompleteSummarization = !persistedRequest && this.taskState.currentlySummarizing
		const fittingCompactionRequired = false
		if (didCompleteSummarization || manualCompactionCommitted) {
			this.promptCacheHealth.recordCompactionResult(true)
		}
		if (
			canCompactBeforeAdmission &&
			!didCompleteSummarization &&
			!manualCompactionRequested &&
			!manualCompactionCommitted &&
			!manualHistoryTruncationCommitted &&
			(useAutoCondense || forceFinalGuardCompact)
		) {
			shouldCompact =
				forceFinalGuardCompact ||
				(!targetWindowFittingCommitted &&
					this.contextManager.shouldCompactContextWindow(
						this.messageStateHandler.clineMessages,
						requestScope.api,
						previousApiReqIndex,
						autoCondenseTriggerOptions,
					))
		}

		const ordinaryCompactionInput = persistedRequest ? [] : originalUserContent
		if (shouldCompact && !manualCompactionRequested) {
			this.ordinaryRequestInputReplay.clear()
			requestScope.explicitInstructions.cancel()
			const operationId = `auto-compaction:${this.taskId}:${apiIndex}:${this.genMessageTs()}`
			const result = await this.runOrdinaryContextCompaction(
				operationId,
				requestScope,
				ordinaryCompactionInput,
				includeFileDetails,
			)
			if (result === "failed") {
				await this.presentTerminalCompactionFailure(operationId, apiIndex, ordinaryCompactionInput)
				return true
			}
			this.contextCompactionFailureReasons.delete(operationId)
			if (result === "cancelled") return true
			this.promptCacheHealth.recordCompactionResult(true)
			return this.recursivelyMakeClineRequests(originalUserContent, includeFileDetails, {
				...transaction,
				forceCompaction: false,
				logicalApiIndex: apiIndex,
				reuseRequestAccounting: true,
			})
		}
		let manualCompactionContinuation: ClineContent[] = []
		if (didCompleteSummarization) {
			const pendingContinuation = this.taskState.pendingManualCompactionContinuation
			if (pendingContinuation) {
				manualCompactionContinuation = await buildUserFeedbackContent(
					pendingContinuation.text,
					pendingContinuation.images,
					pendingContinuation.files,
				)
			}
			this.taskState.pendingManualCompactionContinuation = undefined
		}

		if (
			shouldRestoreDeferredTurn({
				hasDeferredTurn: this.taskState.deferredCurrentTurn !== undefined,
				didCompleteSummarization,
				fittingCompactionRequired,
			})
		) {
			const deferredUserContent = await this.restoreDeferredTurn(userContent)
			if (deferredUserContent !== userContent) {
				if (this.modeSwitchCompaction.getOperationId() && !fittingCompactionRequired) {
					await this.modeSwitchCompaction.markApplied()
				}
				return this.recursivelyMakeClineRequests(
					[...deferredUserContent, ...manualCompactionContinuation],
					includeFileDetails,
					{ ...transaction, forceCompaction: false },
				)
			}
		}

		if (didCompleteSummarization) {
			userContent = projectCompletedCompactionResult(userContent, manualCompactionContinuation)
		}

		if (didCompleteSummarization && this.modeSwitchCompaction.getOperationId() && !fittingCompactionRequired) {
			await this.modeSwitchCompaction.markApplied()
		}

		// NOW load context based on compaction decision
		// This optimization avoids expensive context loading when using summarize_task
		let parsedUserContent: ClineContent[]
		let environmentDetails: string
		let clinerulesError: boolean
		if (!persistedRequest) {
			this.taskState.isInternalContextCompactionRequest = shouldCompact
		}

		if (persistedRequest) {
			parsedUserContent = userContent
			environmentDetails = ""
			clinerulesError = false
		} else if (shouldCompact) {
			parsedUserContent = this.taskState.targetWindowFittingState
				? []
				: projectCompactionRequestContent(
						userContent,
						this.taskState.deferredCurrentTurn?.compactionContent,
						fittingCompactionRequired,
					)
			environmentDetails = ""
			clinerulesError = false
			this.taskState.lastAutoCompactTriggerIndex = previousApiReqIndex
		} else {
			const newTaskContinuation = deriveNewTaskFeedbackContinuation({
				userContent,
				assistantContent: this.messageStateHandler.apiConversationHistory.flatMap((message) =>
					message.role === "assistant" && Array.isArray(message.content)
						? message.content.filter((block): block is ClineAssistantToolUseBlock => block.type === "tool_use")
						: [],
				),
				persistedRequest: false,
			})
			if (newTaskContinuation) {
				requestScope.explicitInstructions.register(newTaskContinuation)
			}
			// When NOT compacting, load full context with mentions parsing and slash commands
			;[parsedUserContent, environmentDetails, clinerulesError] = await this.loadContext(
				userContent,
				includeFileDetails,
				useCompactPrompt,
				requestScope,
			)
			if (manualCompactionRequested && this.taskState.isManualContextCompactionRequest) {
				const manualAuthorization = requestScope.explicitInstructions.getPendingToolAuthorization(
					ClineDefaultTool.SUMMARIZE_TASK,
				)
				if (manualAuthorization?.source === "manual_compact_command") {
					const passGuidance = projectCompletedCompactionResult(parsedUserContent).filter(
						(block) =>
							block.type !== "text" ||
							block.text.replace(/<\/?(?:task|feedback|answer|user_message)>/gi, "").trim().length > 0,
					)
					requestScope.explicitInstructions.cancel()
					const operationId = `manual-compaction:${this.taskId}:${apiIndex}:${this.genMessageTs()}`
					const result = await this.runManualContextCompaction(
						operationId,
						requestScope,
						passGuidance,
						includeFileDetails,
						userContent,
					)
					if (result !== "completed") return true
					this.promptCacheHealth.recordCompactionResult(true)
					return this.recursivelyMakeClineRequests([], includeFileDetails, {
						...transaction,
						forceCompaction: false,
						logicalApiIndex: apiIndex,
						reuseRequestAccounting: true,
					})
				}
			}
		}
		if (!persistedRequest && shouldCompact) {
			this.taskState.isManualContextCompactionRequest = false
		}
		if (this.taskState.isManualContextCompactionRequest) {
			// A manual request owns a new failure row and must never overwrite an earlier automatic compaction status.
			this.taskState.contextCompactionMessageTs = undefined
		}
		// error handling if the user uses the /newrule command & their .clinerules is a file, for file read operations didnt work properly
		if (clinerulesError === true) {
			await this.say(
				"error",
				"Issue with processing the /newrule command. Double check that, if '.clinerules' already exists, it's a directory and not a file. Otherwise there was an issue referencing this file/directory.",
			)
		}

		// Replace userContent with parsed content that includes file details and command instructions.
		userContent = parsedUserContent

		// add environment details as its own text block, separate from tool results
		// do not add environment details to the message which we are compacting the context window
		if (environmentDetails) {
			userContent.push({ type: "text", text: environmentDetails })
		}

		if (!persistedRequest && !shouldCompact) {
			await this.appendBackgroundResults(userContent)
		}

		let finalProjection: ContextWindowProjection | undefined
		let candidateEstimatedTokens: number | undefined
		if (!shouldCompact) {
			const finalGuard = persistedRequest
				? this.projectPersistedRequestContextWindow(
						await this.buildPersistedRequestCandidate(
							previousApiReqIndex,
							requestScope,
							apiIndex,
							persistedRequestApiIndex,
						),
						requestScope,
						apiIndex,
					)
				: await this.evaluateFinalContextWindowGuard(userContent, previousApiReqIndex, requestScope, apiIndex)
			finalProjection = finalGuard.projection
			candidateEstimatedTokens = finalGuard.candidateEstimatedTokens
			const ordinaryCompactionInput = persistedRequest ? [] : originalUserContent
			if (
				canCompactBeforeAdmission &&
				useAutoCondense &&
				finalProjection.shouldCompact &&
				!targetWindowFittingCommitted &&
				!manualCompactionRequested &&
				!this.taskState.isManualContextCompactionRequest &&
				!manualCompactionCommitted &&
				!manualHistoryTruncationCommitted
			) {
				this.ordinaryRequestInputReplay.clear()
				requestScope.explicitInstructions.cancel()
				const operationId = `auto-compaction:${this.taskId}:${apiIndex}:${this.genMessageTs()}`
				const result = await this.runOrdinaryContextCompaction(
					operationId,
					requestScope,
					ordinaryCompactionInput,
					includeFileDetails,
				)
				if (result === "failed") {
					await this.presentTerminalCompactionFailure(operationId, apiIndex, ordinaryCompactionInput)
					return true
				}
				this.contextCompactionFailureReasons.delete(operationId)
				if (result === "cancelled") return true
				this.promptCacheHealth.recordCompactionResult(true)
				return this.recursivelyMakeClineRequests(originalUserContent, includeFileDetails, {
					...transaction,
					forceCompaction: false,
					logicalApiIndex: apiIndex,
					reuseRequestAccounting: true,
				})
			}
		}

		userContent = ensureUserContent(userContent, "task user turn")

		// getting verbose details is an expensive operation, it uses globby to top-down build file structure of project which for large projects can take a few seconds
		// for the best UX we show a placeholder api_req_started message with a loading spinner as this happens
		if (!persistedRequest) {
			await this.say(
				"api_req_started",
				JSON.stringify({
					request: `${userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n")}\n\nLoading...`,
				}),
			)
		}

		let requestApproved: boolean
		if (persistedRequest) {
			await this.admitApiRequest(apiIndex)
			requestApproved = true
		} else {
			requestApproved = await this.persistApiRequestUserMessage(
				userContent,
				apiIndex,
				requestScope,
				transaction.beforeApiRequestStarted,
			)
		}
		if (!requestApproved) {
			requestScope.explicitInstructions.cancel()
			this.ordinaryRequestInputReplay.acknowledge(apiIndex)
			this.compactionRequestReplay.clear(apiIndex)
			return true
		}

		telemetryService.captureConversationTurnEvent(this.ulid, providerId, model.id, "user", modelInfo.mode)

		// Capture task initialization timing telemetry for the first API request
		if (isFirstRequest) {
			const durationMs = Math.round(performance.now() - this.taskInitializationStartTime)
			telemetryService.captureTaskInitialization(
				this.ulid,
				this.taskId,
				durationMs,
				this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
			)
		}

		// since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request (to load potential details for example), we need to update the text of that message
		const lastApiReqIndex = findLastIndex(this.messageStateHandler.clineMessages, (m) => m.say === "api_req_started")
		await this.messageStateHandler.updateClineMessage(lastApiReqIndex, {
			text: JSON.stringify({
				request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
				...(candidateEstimatedTokens === undefined ? {} : { estimatedContextTokens: candidateEstimatedTokens }),
				...(finalProjection === undefined ? {} : { contextTokensSource: "estimate" as const }),
			} satisfies ClineApiReqInfo),
		})
		await this.postStateToWebview()

		try {
			const usageTracker = new TaskRequestUsageTracker()
			const taskMetrics: {
				cacheWriteTokens: number
				cacheReadTokens: number
				inputTokens: number
				outputTokens: number
				totalCost: number | undefined
			} = { cacheWriteTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: undefined }
			let didFinalizeApiReqMsg = false
			let didCommitFinalUsage = false
			let usageReported = false
			let cacheUsageReported = false
			let usageChunkSideEffectsQueue = Promise.resolve()
			/*
				Usage side effects run as soon as a usage chunk arrives.
				queueUsageChunkSideEffects() appends work to this promise chain, and each appended step starts immediately
				(once the previous step finishes). We only await usageChunkSideEffectsQueue at stream end to flush any in-flight
				updates before finalizing api_req_started, not to start processing.
			*/

			const updateApiReqMsgFromMetrics = async (
				cancelReason?: ClineApiReqCancelReason,
				streamingFailedMessage?: string,
			) => {
				const contextTokens =
					taskMetrics.inputTokens +
					taskMetrics.outputTokens +
					taskMetrics.cacheWriteTokens +
					taskMetrics.cacheReadTokens
				await updateApiReqMsg({
					messageStateHandler: this.messageStateHandler,
					lastApiReqIndex,
					inputTokens: taskMetrics.inputTokens,
					outputTokens: taskMetrics.outputTokens,
					cacheWriteTokens: taskMetrics.cacheWriteTokens,
					cacheReadTokens: taskMetrics.cacheReadTokens,
					contextTokens,
					api: requestScope.api,
					totalCost: taskMetrics.totalCost,
					cancelReason,
					streamingFailedMessage,
				})
			}

			const queueUsageChunkSideEffects = () => {
				usageChunkSideEffectsQueue = usageChunkSideEffectsQueue
					// This executes immediately after enqueue (microtask if already resolved), not at stream end.
					.then(async () => {
						if (didFinalizeApiReqMsg || this.taskState.abort) {
							return
						}

						await updateApiReqMsgFromMetrics()
						await this.postStateToWebview()
					})
					.catch((error) => {
						Logger.debug(`[Task ${this.taskId}] Failed to process usage chunk side effects: ${error}`)
					})
			}

			const finalizeApiReqMsg = async (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				didFinalizeApiReqMsg = true
				await usageChunkSideEffectsQueue
				await updateApiReqMsgFromMetrics(cancelReason, streamingFailedMessage)
				if (didCommitFinalUsage) return
				didCommitFinalUsage = true
				const finalUsage = usageTracker.getSnapshot()
				const hasUsage =
					finalUsage.inputTokens > 0 ||
					finalUsage.outputTokens > 0 ||
					finalUsage.cacheWriteTokens > 0 ||
					finalUsage.cacheReadTokens > 0
				if (usageReported) {
					this.ordinaryProviderRequestRounds.get(apiIndex)?.attachExactUsage({
						inputTokens: finalUsage.inputTokens,
						outputTokens: finalUsage.outputTokens,
						thoughtsTokens: finalUsage.thoughtsTokens,
						cacheWriteTokens: finalUsage.cacheWriteTokens,
						cacheReadTokens: finalUsage.cacheReadTokens,
						cacheUsageReported: finalUsage.cacheUsageReported,
						totalCost: finalUsage.totalCost,
						currency: model.info.pricing?.currency || "USD",
					})
				}
				if (!hasUsage) return
				this.apiRateMetricsService.recordExactUsage({
					inputTokens: finalUsage.inputTokens,
					outputTokens: finalUsage.outputTokens,
					cacheWriteTokens: finalUsage.cacheWriteTokens,
					cacheReadTokens: finalUsage.cacheReadTokens,
					thoughtsTokens: finalUsage.thoughtsTokens,
				})
				const rateMetrics = this.apiRateMetricsService.getSnapshot()
				telemetryService.captureTokenUsage(
					this.ulid,
					finalUsage.inputTokens,
					finalUsage.outputTokens,
					providerId,
					model.id,
					{
						cacheWriteTokens: finalUsage.cacheWriteTokens,
						cacheReadTokens: finalUsage.cacheReadTokens,
						thoughtsTokens: finalUsage.thoughtsTokens,
						apiFormat: requestScope.selectedApiFormat,
						totalCost: finalUsage.totalCost,
						cacheUsageReported: finalUsage.cacheUsageReported,
						requestsPerMinute: rateMetrics.requestsPerMinute,
						tokensPerMinute: rateMetrics.tokensPerMinute,
						features: {
							checkpoints: this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") === true,
							hooks: getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled")),
							focus_chain: this.stateManager.getGlobalSettingsKey("focusChainSettings")?.enabled === true,
							auto_condense: this.stateManager.getGlobalSettingsKey("useAutoCondense") === true,
							yolo_mode: this.stateManager.getGlobalSettingsKey("yoloModeToggled") === true,
							auto_approve_all: this.stateManager.getGlobalSettingsKey("autoApproveAllToggled") === true,
							subagents: this.stateManager.getGlobalSettingsKey("subagentsEnabled") === true,
							mcp: this.stateManager.getGlobalSettingsKey("mcpEnabled") === true,
							image_generation: this.stateManager.getGlobalSettingsKey("imageGenerationEnabled") === true,
							web_tools: this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true,
							worktrees: this.stateManager.getGlobalSettingsKey("worktreesEnabled") === true,
							strict_plan: this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled") === true,
							background_edit: this.stateManager.getGlobalSettingsKey("backgroundEditEnabled") === true,
							double_check_completion:
								this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled") === true,
							lazy_teammate_mode: this.stateManager.getGlobalSettingsKey("lazyTeammateModeEnabled") === true,
							native_tool_calls: this.shouldUseNativeToolCalls(requestScope.providerInfo),
							parallel_tool_calling: this.resolveParallelToolCallingEnabled(requestScope.providerInfo),
						},
					},
				)
			}

			// Owns when the streaming "thinking" row opens for encrypted-only reasoning
			// and whether that contentless row must later be withdrawn.
			const reasoningIndicator = new ReasoningIndicator()

			/**
			 * Remove a reasoning row that only ever showed activity, never text.
			 * Encrypted payloads are unrenderable, so leaving the row behind would
			 * strand an empty "Thinking" entry once streaming stops.
			 */
			const withdrawPlaceholderReasoningMessage = async (options: { notifyWebview: boolean }): Promise<void> => {
				if (!reasoningIndicator.isPlaceholderOnly) return
				reasoningIndicator.onClosed()
				const placeholderTs = this.taskState.reasoningTs
				this.pendingReasoningText = undefined
				this.taskState.reasoningTs = undefined
				if (placeholderTs === undefined) return
				await this.messageStateHandler.removeMessagesByTs([placeholderTs], { updateTaskHistory: false })
				if (options.notifyWebview) {
					await this.postStateToWebview()
				}
			}

			const abortStreamOnce = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				Session.get().finalizeRequest()
				const reasoningHandler = this.streamHandler.getHandlers().reasonsHandler
				const currentReasoning = reasoningHandler.getCurrentReasoning()
				if (currentReasoning?.thinking) {
					const reasoningTs = this.taskState.reasoningTs ?? this.genMessageTs()
					await this.messageStateHandler.finalizeClineMessage({
						ts: reasoningTs,
						type: "say",
						say: "reasoning",
						text: currentReasoning.thinking,
					})
					this.taskState.reasoningTs = undefined
				}
				// The Controller refreshes the webview after cancellation, so removal
				// here must not push its own partial event.
				await withdrawPlaceholderReasoningMessage({ notifyWebview: false })

				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges() // closes diff view
				}

				// Finalize every partial message (reasoning/text/tool rows) so no
				// streaming spinner survives a cancel or aborted stream. Clearing
				// only the last message left earlier partial reasoning rows with
				// partial=true forever, keeping their spinner animating.
				// Do NOT push to frontend here — the Controller will later clear
				// partial flags and refresh via postStateToWebview.
				// Sending a partialMessageEvent would re-insert the message after clearing.
				const partialIndices: number[] = []
				this.messageStateHandler.clineMessages.forEach((candidate, index) => {
					if (candidate?.partial) {
						partialIndices.push(index)
					}
				})
				for (const index of partialIndices) {
					await this.messageStateHandler.updateClineMessage(index, {
						partial: false,
					})
				}
				// update api_req_started to have cancelled and cost, so that we can display the cost of the partial stream
				await finalizeApiReqMsg(cancelReason, streamingFailedMessage)
				await this.messageStateHandler.updateTaskHistory()

				// Preserve reasoning already received from the provider together with
				// an explicit interruption marker for deterministic resume behavior.
				const interruptedContent: ClineAssistantContent[] = [
					...reasoningHandler.getRedactedThinking(),
					...(currentReasoning ? [{ ...currentReasoning }] : []),
					{
						type: "text",
						text:
							assistantMessage +
							`\n\n[${
								cancelReason === "streaming_failed"
									? "Response interrupted by API Error"
									: "Response interrupted by user"
							}]`,
					},
				]
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: interruptedContent,
					modelInfo,
					metrics: {
						tokens: {
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
					},
					ts: Date.now(),
				})

				telemetryService.captureConversationTurnEvent(
					this.ulid,
					providerId,
					modelInfo.modelId,
					"assistant",
					modelInfo.mode,
					undefined,
					this.useNativeToolCalls, // For assistant turn only.
				)

				// signals to provider that it can retrieve the saved messages from disk, as abortTask can not be awaited on in nature
				this.taskState.didFinishAbortingStream = true
			}
			let abortStreamPromise: Promise<void> | undefined
			const abortStream = (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string): Promise<void> => {
				abortStreamPromise ??= abortStreamOnce(cancelReason, streamingFailedMessage)
				return abortStreamPromise
			}

			// reset streaming state
			this.taskState.currentStreamingContentIndex = 0
			this.taskState.assistantMessageContent = []
			this.taskState.didCompleteReadingStream = false
			this.taskState.didFinishAbortingStream = false
			this.taskState.userMessageContent = []
			this.taskState.userMessageContentReady = false
			this.taskController.reset()
			this.taskState.didAlreadyUseTool = false
			this.taskState.presentAssistantMessageLocked = false
			this.taskState.presentAssistantMessageHasPendingUpdates = false
			this.taskState.didAutomaticallyRetryFailedApiRequest = false
			await this.diffViewProvider.reset()
			this.streamHandler.reset()
			this.presentationScheduler.reset()
			this.pendingReasoningText = undefined
			this.taskState.reasoningTs = undefined
			this.taskState.parseBlockTsByKey.clear()
			this.taskState.parseToolIdentityByKey.clear()
			this.taskState.lastRenderedPartialByTs.clear()
			this.taskState.partialToolLifecycleByTs.clear()

			const { toolUseHandler, reasonsHandler } = this.streamHandler.getHandlers()
			const providerStream = this.attemptApiRequest(previousApiReqIndex, requestScope, apiIndex) // yields only if the first chunk is successful, otherwise will allow the user to retry the request (most likely due to rate limit error, which gets thrown on the first chunk)
			const stream = normalizeApiStream(providerStream, createStreamNormalizer(this.identityFactory))

			let assistantMessageId = ""
			let assistantMessage = "" // For UI display (includes XML)
			let assistantTextOnly = "" // For API history (text only, no tool XML)
			let assistantTextSignature: string | undefined

			this.taskState.isStreaming = true
			let didReceiveUsageChunk = false
			let didFinalizeReasoningForUi = false
			let didScheduleAnyContent = false // Tracks whether any content chunk has been scheduled for presentation (not necessarily flushed yet)

			const finalizePendingReasoningMessage = async (thinking: string): Promise<boolean> => {
				await this.flushPendingReasoningMessage()
				const existingTs = this.taskState.reasoningTs
				if (existingTs === undefined) return false

				const finalized = await this.messageStateHandler.finalizeClineMessage({
					ts: existingTs,
					type: "say",
					say: "reasoning",
					text: thinking,
				})
				if (finalized) {
					await sendPartialMessageEvent(this.controller, convertClineMessageToProto(finalized))
				}
				this.taskState.reasoningTs = undefined
				return true
			}

			// Track API call time for session statistics
			Session.get().startApiCall()
			let streamCoordinator: StreamChunkCoordinator | undefined

			try {
				streamCoordinator = new StreamChunkCoordinator(stream, {
					abortStream: () => requestScope.api.abort?.(),
					onUsageChunk: (chunk) => {
						this.streamHandler.setRequestId(chunk.provider_metadata?.response_id)
						didReceiveUsageChunk = true
						usageReported = true
						const usage = usageTracker.apply(chunk)
						taskMetrics.inputTokens = usage.inputTokens
						taskMetrics.outputTokens = usage.outputTokens
						taskMetrics.cacheWriteTokens = usage.cacheWriteTokens
						taskMetrics.cacheReadTokens = usage.cacheReadTokens
						cacheUsageReported = usage.cacheUsageReported
						taskMetrics.totalCost = usage.totalCost
						queueUsageChunkSideEffects()
					},
				})

				let shouldInterruptStream = false
				let shouldDrainUsageOnly = false

				while (true) {
					const chunk = await streamCoordinator.nextChunk()
					if (!chunk) {
						break
					}
					// Track whether any content chunk has been scheduled for presentation (not necessarily flushed yet).
					// Using assistantMessage alone would miss reasoning-only streams where text hasn't
					// started yet, causing every reasoning chunk to get "immediate" priority.
					const hadVisibleAssistantContent = didScheduleAnyContent
					if (!this.taskState.taskFirstTokenTimeMs) {
						this.taskState.taskFirstTokenTimeMs = Math.max(0, Date.now() - this.taskState.taskStartTimeMs)
					}

					switch (chunk.type) {
						case "reasoning": {
							// Process the reasoning delta through the handler
							// Ensure details is always an array
							const details = chunk.details ? (Array.isArray(chunk.details) ? chunk.details : [chunk.details]) : []
							reasonsHandler.processReasoningDelta({
								provider_metadata: chunk.provider_metadata,
								reasoning: chunk.reasoning,
								signature: chunk.signature,
								details,
								redacted_data: chunk.redacted_data,
								redacted_phase: chunk.redacted_phase,
							})

							// fixes bug where cancelling task > aborts task > for loop may be in middle of streaming reasoning > say function throws error before we get a chance to properly clean up and cancel the task.
							if (!this.taskState.abort) {
								const thinkingBlock = reasonsHandler.getCurrentReasoning()
								const hasPendingNativeToolUse = toolUseHandler.getPartialToolUsesAsContent().length > 0
								// Some providers can interleave reasoning after text has started.
								// Keep rendering stable by only streaming reasoning UI before the first text chunk or native tool call.
								const visibleReasoning = thinkingBlock?.thinking ?? ""
								const action = reasoningIndicator.decide({
									hasPlainReasoning: Boolean(visibleReasoning && chunk.reasoning),
									hasEncryptedReasoning: Boolean(chunk.redacted_data),
									assistantTextStarted: assistantMessage.length > 0,
									hasPendingNativeToolUse,
								})
								if (action !== "none") {
									if (this.taskState.reasoningTs === undefined) {
										this.taskState.reasoningTs = this.genMessageTs()
									}
									// Encrypted reasoning has no renderable payload; an empty string
									// still opens the row so its streaming animation shows activity.
									this.pendingReasoningText = action === "publish_text" ? visibleReasoning : ""
								}
							}
							await this.scheduleAssistantPresentation(
								"reasoning",
								this.getPresentationPriorityForChunk({ chunkType: "reasoning", hadVisibleAssistantContent }),
							)
							didScheduleAnyContent = true

							break
						}
						case "tool_calls": {
							// Accumulate tool use blocks in proper Anthropic format
							toolUseHandler.processToolUseDelta(
								{
									type: "tool_use",
									name: chunk.tool_call.function?.name,
									input: chunk.tool_call.function?.arguments,
									signature: chunk?.signature,
								},
								{
									function_id: chunk.function_id,
									dline_tid: chunk.dline_tid,
									provider_metadata: chunk.provider_metadata,
								},
							)
							const currentReasoning = reasonsHandler.getCurrentReasoning()
							if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
								const ok = await finalizePendingReasoningMessage(currentReasoning.thinking)
								if (ok) {
									didFinalizeReasoningForUi = true
								}
							} else {
								await withdrawPlaceholderReasoningMessage({ notifyWebview: true })
							}

							await this.processNativeToolCalls(assistantTextOnly, toolUseHandler.getPartialToolUsesAsContent())
							await this.scheduleAssistantPresentation(
								"tool",
								this.getPresentationPriorityForChunk({ chunkType: "tool_calls", hadVisibleAssistantContent }),
							)
							didScheduleAnyContent = true
							if (chunk.phase === "completed" && isTurnEndingToolName(chunk.tool_call.function?.name)) {
								// A turn-ending tool owns the visible interaction. Stop consuming ordinary
								// content, but keep the Provider transport alive long enough to receive its
								// final usage event for TaskHeader, history, telemetry and rate metrics.
								shouldDrainUsageOnly = true
								shouldInterruptStream = true
							}
							break
						}
						case "server_tool": {
							if (await this.toolExecutor.consumeServerToolChunk(chunk)) didScheduleAnyContent = true
							break
						}
						case "text": {
							// If we have reasoning content, finalize it before processing text (only once)
							const currentReasoning = reasonsHandler.getCurrentReasoning()
							if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
								const finalizedReasoning = await finalizePendingReasoningMessage(currentReasoning.thinking)
								if (finalizedReasoning) {
									didFinalizeReasoningForUi = true
								}
							} else {
								await withdrawPlaceholderReasoningMessage({ notifyWebview: true })
							}
							if (chunk.signature) {
								assistantTextSignature = chunk.signature
							}
							if (chunk.provider_metadata?.response_id) {
								assistantMessageId = chunk.provider_metadata.response_id
							}
							assistantMessage += chunk.text
							assistantTextOnly += chunk.text // Accumulate text separately
							const isCompactionResponse =
								this.taskState.isInternalContextCompactionRequest ||
								this.taskState.isManualContextCompactionRequest
							const assistantMessageForParsing = isCompactionResponse
								? normalizeCompactionResponse(assistantMessage).assistantText
								: assistantMessage
							// parse raw assistant message into content blocks
							const prevLength = this.taskState.assistantMessageContent.length
							const _prevBlocks = this.taskState.assistantMessageContent

							const nextBlocks = orderTurnEndingContentBlocks(
								parseAssistantMessageV2(assistantMessageForParsing, {
									getOrCreateTsForBlock: (key) => {
										const existing = this.taskState.parseBlockTsByKey.get(key)
										if (existing !== undefined) return existing
										const ts = this.genMessageTs()
										this.taskState.parseBlockTsByKey.set(key, ts)
										return ts
									},
									getOrCreateToolIdentityForBlock: (key) => {
										const existing = this.taskState.parseToolIdentityByKey.get(key)
										if (existing) return existing
										const identity = {
											function_id: this.identityFactory.nextFunctionId(),
											dline_tid: this.identityFactory.nextTraceId(),
										}
										this.taskState.parseToolIdentityByKey.set(key, identity)
										return identity
									},
								}),
							)
							this.taskState.assistantMessageContent = nextBlocks

							if (this.taskState.assistantMessageContent.length > prevLength) {
								this.taskState.userMessageContentReady = false // new content we need to present, reset to false in case previous content set this to true
							}
							await this.scheduleAssistantPresentation(
								"text",
								this.getPresentationPriorityForChunk({ chunkType: "text", hadVisibleAssistantContent }),
							)
							didScheduleAnyContent = true
							break
						}
					}

					if (shouldInterruptStream) {
						break
					}

					if (this.taskState.abort) {
						requestScope.api.abort?.()
						if (!this.taskState.abandoned) {
							// only need to gracefully abort if this instance isn't abandoned (sometimes openrouter stream hangs, in which case this would affect future instances of cline)
							await abortStream("user_cancelled")
						}
						shouldInterruptStream = true
						break // aborts the stream
					}

					if (this.taskController.hasAnyRejection()) {
						// userContent has a tool rejection, so interrupt the assistant's response to present the user's feedback
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						// this.userMessageContentReady = true // instead of setting this preemptively, we allow the present iterator to finish and set userMessageContentReady when its ready
						shouldInterruptStream = true
						break
					}

					// Keep reading the current assistant response after a tool has run.
					// ToolExecutor skips additional non-terminal tools when parallel tool
					// calling is disabled, but terminal tools such as attempt_completion
					// may still arrive later in the same response and must be handled.
				}

				if (shouldDrainUsageOnly) {
					await streamCoordinator.drainUsageOnly()
					await this.toolExecutor.finalizeServerToolCalls(
						"Provider stream ended before hosted web search returned a result.",
					)
				} else if (shouldInterruptStream) {
					await streamCoordinator.stop()
					await this.toolExecutor.finalizeServerToolCalls(
						this.taskState.abort
							? "Provider-hosted web search cancelled."
							: "Provider-hosted web search interrupted.",
					)
				} else {
					await streamCoordinator.waitForCompletion()
					await this.toolExecutor.finalizeServerToolCalls(
						"Provider stream ended before hosted web search returned a result.",
					)
				}
				// Flush any usage updates that were already executing/queued during streaming.
				await usageChunkSideEffectsQueue

				if (!this.taskState.abort && !didFinalizeReasoningForUi) {
					const finalReasoning = reasonsHandler.getCurrentReasoning()
					if (finalReasoning?.thinking) {
						const finalizedPendingReasoning = await finalizePendingReasoningMessage(finalReasoning.thinking)
						if (!finalizedPendingReasoning) {
							await this.say("reasoning", finalReasoning.thinking, undefined, undefined, false)
						}
						didFinalizeReasoningForUi = true
					} else {
						await withdrawPlaceholderReasoningMessage({ notifyWebview: true })
					}
				}
			} catch (error) {
				await streamCoordinator?.stop()
				if (!this.taskState.isInternalContextCompactionRequest && !this.taskState.isManualContextCompactionRequest) {
					await this.rollbackOrdinaryContextWindowIndicator(apiIndex)
				}
				if (!this.taskState.abort && !this.taskState.abandoned && this.diffViewProvider.isEditing) {
					// Streaming file edits are previews. Revert them before retrying so a
					// truncated provider response cannot leave partial content on disk.
					await this.diffViewProvider.revertChanges()
				}
				await this.toolExecutor.finalizeServerToolCalls(
					this.taskState.abort
						? "Provider-hosted web search cancelled."
						: "Provider stream failed before hosted web search returned a result.",
				)
				// abandoned happens when extension is no longer waiting for the cline instance to finish aborting (error is thrown here when any function in the for loop throws due to this.abort)
				if (this.taskState.abort) {
					if (!this.taskState.didFinishAbortingStream && !this.taskState.abandoned) {
						await abortStream("user_cancelled")
					}
					Logger.debug(`[Task ${this.taskId}] API stream stopped after task cancellation`)
				} else if (!this.taskState.abandoned) {
					// Use provider-specific parseError if available, otherwise fall back to generic classification
					const clineError =
						requestScope.api.parseError?.(error, model.id) ??
						ErrorService.get().toClineError(error, model.id, providerId)
					if (requestScope.api.parseError) {
						ErrorService.get().logException(clineError, { modelId: model.id, providerId })
					}
					const errorMessage = clineError.serialize()
					if (this.taskState.isInternalContextCompactionRequest) {
						await this.discardFailedCompactionAttempt(apiIndex)
					}
					const openAiMaxOutputReplayDecision = this.taskState.isInternalContextCompactionRequest
						? this.compactionRequestReplay.prepareOpenAiMaxOutputReplay(apiIndex, error)
						: "not_applicable"
					if (openAiMaxOutputReplayDecision === "replay") {
						await this.updateContextCompactionStatus("retrying", {
							error: errorMessage,
							retryAttempt: 1,
							maxRetryAttempts: 1,
							clearContent: true,
						})
						this.scheduleCompactionReplay(apiIndex)
						requestScope.explicitInstructions.close()
						return true
					}
					if (openAiMaxOutputReplayDecision === "exhausted") {
						await finalizeApiReqMsg("streaming_failed", errorMessage)
						await this.updateContextCompactionStatus("failed", { error: errorMessage })
						this.taskState.forceTruncateAvailable = true
						this.endAutoRetrySequence(false)
						await this.messageStateHandler.updateTaskHistory()
						await this.postStateToWebview()
						const retryId = `retry:${this.taskId}:${this.getRuntimeState().revision}`
						await this.recoverApiFailure({
							turnId: retryId,
							interactionId: retryId,
							apiIndex: this.getRuntimeState().anchor.apiIndex,
							presentation: errorMessage,
						})
						return true
					}
					if (this.taskState.isManualContextCompactionRequest) {
						// Manual compaction is one-shot until the user explicitly selects Retry.
						await this.discardFailedManualCompactionAttempt(apiIndex)
						await finalizeApiReqMsg("streaming_failed", errorMessage)
						await this.updateContextCompactionStatus("failed", { error: errorMessage })
						this.endAutoRetrySequence(false)
						await this.messageStateHandler.updateTaskHistory()
						await this.postStateToWebview()
						const retryId = `retry:${this.taskId}:${this.getRuntimeState().revision}`
						await this.recoverApiFailure({
							turnId: retryId,
							interactionId: retryId,
							apiIndex,
							presentation: errorMessage,
						})
						return true
					}
					if (this.taskState.isInternalContextCompactionRequest) {
						await this.recoverAutomaticCompactionFailure(apiIndex, errorMessage, requestScope, userContent)
						return true
					}
					const isStreamingSpendLimitError = clineError.isErrorType(ClineErrorType.SpendLimit)
					// Auto-retry for streaming failures (skip for spend limit errors)
					const manualRetryTakeover = this.consumeManualRetryTakeover()
					const retryDecision = getStreamRetryDecision({
						isSpendLimitError: isStreamingSpendLimitError,
						autoRetryAttempts: manualRetryTakeover ? MAX_AUTO_RETRY_ATTEMPTS : this.taskState.autoRetryAttempts,
					})
					if (retryDecision.shouldRetry) {
						this.taskState.autoRetryAttempts++
						await this.updateContextCompactionStatus("retrying", {
							error: errorMessage,
							retryAttempt: this.taskState.autoRetryAttempts,
							maxRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS,
							clearContent: true,
						})

						// Calculate exponential backoff for streaming failures: 2s, 4s, 8s
						const delay = getRetryDelay(this.taskState.autoRetryAttempts)

						// API Request component is updated to show error message, we then display retry information underneath that...
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: this.taskState.autoRetryAttempts,
								maxAttempts: 3,
								delaySeconds: delay / 1000,
								errorMessage,
							}),
						)

						const taskId = this.taskId
						const retryAttempts = this.taskState.autoRetryAttempts

						this.scheduleAutoRetry(
							delay,
							() => this.controller.task?.taskId === taskId,
							async () => {
								const activeTask = this.controller.task
								if (!activeTask) {
									return
								}

								activeTask.taskState.autoRetryAttempts = retryAttempts
								const retried = await activeTask.dispatchRuntime({
									type: "API_RETRY_SCHEDULED",
									apiIndex: activeTask.getRuntimeState().anchor.apiIndex,
								})
								if (!retried.accepted) {
									throw new Error(`Automatic retry rejected: ${retried.error?.code ?? "invalid_runtime_event"}`)
								}
							},
						)
						// The scheduled retry is now the sole continuation. End this failed
						// request chain without cancelling or reopening the task.
						requestScope.explicitInstructions.close()
						return true
					}
					if (retryDecision.shouldPrompt) {
						if (!manualRetryTakeover && this.taskState.autoRetryAttempts >= MAX_AUTO_RETRY_ATTEMPTS) {
							await this.markAutoRetryExhausted(errorMessage)
						}
						this.endAutoRetrySequence(false)
						await this.updateContextCompactionStatus("failed", { error: errorMessage })
						const retryId = `retry:${this.taskId}:${this.getRuntimeState().revision}`
						await this.recoverApiFailure({
							turnId: retryId,
							interactionId: retryId,
							apiIndex: this.getRuntimeState().anchor.apiIndex,
							presentation: errorMessage,
						})
						return true
					}

					// needs to happen after the say, otherwise the say would fail
					await this.cancelTask() // stream exhausted retries; delegate to the full cancel flow

					await abortStream("streaming_failed", errorMessage)
					await this.reinitExistingTaskFromId(this.taskId)
				}
			} finally {
				try {
					if (this.taskState.abort && !this.taskState.didFinishAbortingStream && !this.taskState.abandoned) {
						// Some provider adapters surface transport abort as a clean iterator EOF.
						// Persist the interrupted turn before isStreaming becomes false so task
						// termination cannot close the stores ahead of this durability boundary.
						await abortStream("user_cancelled")
					}
				} finally {
					try {
						await this.toolExecutor.finalizeServerToolCalls(
							this.taskState.abort
								? "Provider-hosted web search cancelled."
								: "Provider stream ended before hosted web search returned a result.",
						)
					} finally {
						this.taskState.isStreaming = false
						// End API call tracking for session statistics
						Session.get().endApiCall()
					}
				}
			}

			if (this.taskState.isInternalContextCompactionRequest || this.taskState.isManualContextCompactionRequest) {
				assistantMessage = normalizeCompactionResponse(assistantMessage).assistantText
				assistantTextOnly = normalizeCompactionResponse(assistantTextOnly).assistantText
			}

			// Finalize any remaining tool calls at the end of the stream

			// OpenRouter/Cline may not return token usage as part of the stream (since it may abort early), so we fetch after the stream is finished
			// (updateApiReq below will update the api_req_started message with the usage details. we do this async so it updates the api_req_started message in the background)
			if (!didReceiveUsageChunk) {
				const apiStreamUsage = await requestScope.api.getApiStreamUsage?.()
				if (apiStreamUsage) {
					usageReported = true
					const usage = usageTracker.apply(apiStreamUsage)
					taskMetrics.inputTokens = usage.inputTokens
					taskMetrics.outputTokens = usage.outputTokens
					taskMetrics.cacheWriteTokens = usage.cacheWriteTokens
					taskMetrics.cacheReadTokens = usage.cacheReadTokens
					cacheUsageReported = usage.cacheUsageReported
					taskMetrics.totalCost = usage.totalCost
					queueUsageChunkSideEffects()
				}
			}

			// Update the api_req_started message with final usage and cost details
			await finalizeApiReqMsg()
			await this.messageStateHandler.updateTaskHistory()

			// Do not treat a canceled provider stream as a completed cache sample.
			if (this.taskState.abort) {
				throw new Error("Dline instance aborted")
			}

			const { contextWindow } = getContextWindowInfo(requestScope.api)
			const compactTriggerTokens = computeCompactTrigger(
				contextWindow,
				computeSummarizeBudget(),
				autoCondenseTriggerOptions,
			)
			this.promptCacheHealth.recordRequest({
				completed: true,
				isCompactionRequest:
					this.taskState.isInternalContextCompactionRequest || this.taskState.isManualContextCompactionRequest,
				supportsPromptCache: requestScope.providerInfo.model.info.capabilities?.supportsPromptCache === true,
				cacheUsageReported,
				inputTokens: taskMetrics.inputTokens,
				cacheWriteTokens: taskMetrics.cacheWriteTokens,
				cacheReadTokens: taskMetrics.cacheReadTokens,
				contextTokens:
					taskMetrics.inputTokens +
					taskMetrics.outputTokens +
					taskMetrics.cacheWriteTokens +
					taskMetrics.cacheReadTokens,
				contextWindow,
				compactTriggerTokens,
			})
			await this.postStateToWebview()

			// Stored the assistant API response immediately after the stream finishes in the same turn
			// Check if the stream produced any content ÃƒÂ¢Ã¢â€?either text or native tool calls.
			// toolUseHandler may have accumulated tool_use blocks even when useNativeToolCalls is false
			// (e.g., from Claude Code provider when the model returns native tool_use blocks).
			const hasAccumulatedToolCalls = toolUseHandler.getAllFinalizedToolUses().length > 0
			const hasReceivedReasoning = reasonsHandler.hasReceivedReasoning()
			const assistantHasContent =
				assistantMessage.length > 0 || this.useNativeToolCalls || hasAccumulatedToolCalls || hasReceivedReasoning
			if (assistantHasContent) {
				telemetryService.captureConversationTurnEvent(
					this.ulid,
					providerId,
					model.id,
					"assistant",
					modelInfo.mode,
					undefined,
					this.useNativeToolCalls,
				)

				const { reasonsHandler } = this.streamHandler.getHandlers()
				const redactedThinkingContent = reasonsHandler.getRedactedThinking()

				const requestId = this.streamHandler.requestId

				// Build content array with thinking blocks, text (if any), and tool use blocks
				const assistantContent: Array<ClineAssistantContent> = [
					// This is critical for maintaining the model's reasoning flow and conversation integrity.
					// "When providing thinking blocks, the entire sequence of consecutive thinking blocks must match the outputs generated by the model during the original request; you cannot rearrange or modify the sequence of these blocks." The signature_delta is used to verify that the thinking was generated by Claude, and the thinking blocks will be ignored if it's incorrect or missing.
					// https://docs.claude.com/en/docs/build-with-claude/extended-thinking#preserving-thinking-blocks
					...redactedThinkingContent,
				]
				// Add thinking block from the reasoning handler if available
				const thinkingBlock = reasonsHandler.getCurrentReasoning()
				if (thinkingBlock) {
					assistantContent.push({ ...thinkingBlock })
				}

				// Only add text block if there's actual text (not just tool XML)
				const hasAssistantText = assistantTextOnly.trim().length > 0
				if (hasAssistantText) {
					assistantContent.push({
						type: "text",
						text: assistantTextOnly,
						// reasoning_details only exists for cline/openrouter providers
						reasoning_details: thinkingBlock?.summary as ClineReasoningDetailParam[] | undefined,
						signature: assistantTextSignature,
						provider_metadata: assistantMessageId ? { response_id: assistantMessageId } : undefined,
					})
				}

				// Get finalized tool use blocks from the handler
				const toolUseBlocks = toolUseHandler.getAllFinalizedToolUses(
					// NOTE: If there is no assistant text but there is a thinking block, we attach the summary to the tool use blocks
					// for providers that required reasoning traces included with assistant content.
					hasAssistantText ? undefined : thinkingBlock?.summary,
				)
				const orderedToolUseBlocks = orderTurnEndingNativeToolBlocks(toolUseBlocks)
				// Append tool use blocks if any exist
				if (orderedToolUseBlocks.length > 0) {
					assistantContent.push(...orderedToolUseBlocks)
				}

				// Append the assistant's content to the API conversation history only if there's content
				if (assistantContent.length > 0) {
					await this.messageStateHandler.addToApiConversationHistory({
						role: "assistant",
						content: assistantContent,
						modelInfo,
						provider_metadata: requestId ? { response_id: requestId } : undefined,
						metrics: {
							tokens: {
								prompt: taskMetrics.inputTokens,
								completion: taskMetrics.outputTokens,
								cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
							},
							cost: taskMetrics.totalCost,
						},
						ts: Date.now(),
					})
					// A request ended, but the round is not complete yet: keep the
					// current lineage alive. Folding happens only after the full
					// round (including tool calls) completes.
				}
			}

			this.taskState.didCompleteReadingStream = true

			// set any blocks to be complete to allow presentAssistantMessage to finish and set userMessageContentReady to true
			// (could be a text block that had no subsequent tool uses, or a text block at the very end, or an invalid tool use, etc. whatever the case, presentAssistantMessage relies on these blocks either to be completed or the user to reject a block in order to proceed and eventually set userMessageContentReady to true)
			const partialBlocks = this.taskState.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => {
				block.partial = false
			})
			// in case there are native tool calls pending
			const partialToolBlocks = toolUseHandler.getPartialToolUsesAsContent()?.map((block) => ({ ...block, partial: false }))
			await this.processNativeToolCalls(assistantTextOnly, partialToolBlocks)
			await this.flushAssistantPresentationOrThrow() // finalization is immediate so no coalesced content remains pending
			const providerRequestRound = this.ordinaryProviderRequestRounds.get(apiIndex)
			try {
				// Persist the canonical assistant tool_use before any handler can publish
				// side effects or a turn-ending interaction that recovery must explain.
				await this.messageStateHandler.flushApiConversationHistory()
				await this.turnDriver.execute({
					providerRequestRound,
					contextTokens:
						taskMetrics.inputTokens +
						taskMetrics.outputTokens +
						taskMetrics.cacheWriteTokens +
						taskMetrics.cacheReadTokens,
					contextWindow,
				})
			} finally {
				this.completeProviderExecutionTurn(providerRequestRound)
			}

			if (
				(this.taskState.isInternalContextCompactionRequest || this.taskState.isManualContextCompactionRequest) &&
				!this.taskState.currentlySummarizing
			) {
				const errorMessage = "Conversation compaction did not return a valid summarize_task context."
				if (this.taskState.isInternalContextCompactionRequest) {
					await this.discardFailedCompactionAttempt(apiIndex)
					await finalizeApiReqMsg("streaming_failed", errorMessage)
					await this.recoverAutomaticCompactionFailure(apiIndex, errorMessage, requestScope, userContent)
					return true
				}

				await this.discardFailedManualCompactionAttempt(apiIndex)
				await finalizeApiReqMsg("streaming_failed", errorMessage)
				await this.updateContextCompactionStatus("failed", { error: errorMessage })
				this.endAutoRetrySequence(false)
				await this.messageStateHandler.updateTaskHistory()
				await this.postStateToWebview()
				const retryId = `retry:${this.taskId}:${this.getRuntimeState().revision}`
				await this.recoverApiFailure({
					turnId: retryId,
					interactionId: retryId,
					apiIndex,
					presentation: errorMessage,
				})
				return true
			}

			const phaseAfterAssistantTurn = this.taskRuntime.getState().phase
			await this.settleOrdinaryIndicatorRound()
			if (phaseAfterAssistantTurn === TaskPhase.COMPLETED) return true
			if (
				this.taskState.abort ||
				phaseAfterAssistantTurn === TaskPhase.CANCELLING ||
				phaseAfterAssistantTurn === TaskPhase.ABORTED
			) {
				return true
			}

			// now add to apiconversationhistory
			// need to save assistant responses to file before proceeding to tool use since user can exit at any moment and we wouldn't be able to save the assistant's response
			let didEndLoop = false
			if (assistantHasContent) {
				// NOTE: this comment is here for future reference - this was a workaround for userMessageContent not getting set to true. It was due to it not recursively calling for partial blocks when didRejectTool, so it would get stuck waiting for a partial block to complete before it could continue.
				// in case the content blocks finished
				// it may be the api stream finished after the last parsed content block was executed, so  we are able to detect out of bounds and set userMessageContentReady to true (note you should not call presentAssistantMessage since if the last block is completed it will be presented again)
				// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // if there are any partial blocks after the stream ended we can consider them invalid
				// if (this.currentStreamingContentIndex >= completeBlocks.length) {
				// 	this.userMessageContentReady = true
				// }

				// Read-only turns cannot change workspace state. Skipping their checkpoint
				// keeps the next Provider request independent from a still-running initial baseline.
				if (this.assistantTurnMayModifyWorkspace()) {
					await this.checkpointManager?.saveCheckpoint()
				}

				// if the model did not tool use, then we need to tell it to either use a tool or attempt_completion
				const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")

				if (!didToolUse) {
					// normal request where tool use is required
					this.taskState.userMessageContent.push({
						type: "text",
						text: formatResponse.noToolsUsed(this.useNativeToolCalls),
					})
					this.taskState.consecutiveMistakeCount++
				}

				// A completed request ends both automatic retry accounting and manual takeover.
				this.taskState.autoRetryAttempts = 0
				this.manualRetryTakeoverActive = false
				this.endAutoRetrySequence()

				const phaseBeforeContinuation = this.taskRuntime.getState().phase
				if (phaseBeforeContinuation === TaskPhase.COMPLETED) return true
				// Added before the staged estimate so the indicator accounts for the
				// queued text that is about to be sent with this round.
				await this.inputQueueCoordinator.deliverAtToolRound()
				await this.refreshOrdinaryIndicatorStaged()

				let recDidEndLoop: boolean
				try {
					recDidEndLoop = await this.recursivelyMakeClineRequests(this.taskState.userMessageContent)
				} finally {
					// Settled already if the input reached the conversation. Any
					// other outcome means the round ended without sending it, so
					// it returns to the queue instead of being consumed.
					await this.settleStagedQueueDelivery(false)
				}
				didEndLoop = recDidEndLoop
			} else {
				await this.rollbackOrdinaryContextWindowIndicator(apiIndex)
				// if there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				const reqId = this.getApiRequestIdSafe(requestScope.api)

				// Minimal diagnostics: structured log and telemetry
				telemetryService.captureProviderApiError({
					ulid: this.ulid,
					model: model.id,
					provider: providerId,
					errorMessage: "empty_assistant_message",
					requestId: reqId,
					isNativeToolCall: this.useNativeToolCalls,
				})

				const baseErrorMessage =
					"Invalid API Response: The provider returned an empty or unparsable response. This is a provider-side issue where the model failed to generate valid output or returned tool calls that Dline cannot process. Retrying the request may help resolve this issue."
				const errorText = reqId ? `${baseErrorMessage} (Request ID: ${reqId})` : baseErrorMessage

				await this.say("error", errorText)
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Failure: I did not provide a response.",
						},
					],
					modelInfo,
					provider_metadata: this.streamHandler.requestId ? { response_id: this.streamHandler.requestId } : undefined,
					metrics: {
						tokens: {
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
					},
					ts: Date.now(),
				})

				let response: ClineAskResponse

				const noResponseErrorMessage = "No assistant message was received. Would you like to retry the request?"
				const manualRetryTakeover = this.consumeManualRetryTakeover()

				if (!manualRetryTakeover && this.taskState.autoRetryAttempts < 3) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++

					// Calculate delay: 2s, 4s, 8s
					const delay = getRetryDelay(this.taskState.autoRetryAttempts)
					response = "yesButtonClicked"
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: noResponseErrorMessage,
						}),
					)
					if (!(await this.waitForAutoRetry(delay))) {
						throw new Error("Dline instance aborted")
					}
				} else {
					if (!manualRetryTakeover && this.taskState.autoRetryAttempts >= MAX_AUTO_RETRY_ATTEMPTS) {
						await this.markAutoRetryExhausted(noResponseErrorMessage)
					}
					this.endAutoRetrySequence(false)
					// Manual takeover and exhausted retries share one canonical recovery ask.
					const askResult = await this.ask("api_req_failed", noResponseErrorMessage)
					response = askResult.response
					// Reset retry counter if user chooses to manually retry
					if (response === "yesButtonClicked") {
						this.taskState.autoRetryAttempts = 0
					}
				}

				if (response === "yesButtonClicked") {
					// Signal the loop to continue (i.e., do not end), so it will attempt again
					return false
				}

				// Returns early to avoid retry since user dismissed
				return true
			}

			requestScope.explicitInstructions.close()
			return didEndLoop // will always be false for now
		} catch (_error) {
			requestScope.explicitInstructions.cancel()
			this.compactionRequestReplay.clear(apiIndex)
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonClicked, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return true // needs to be true so parent loop knows to end task
		}
	}

	async loadContext(
		userContent: ClineContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
		requestScope: RequestApiScope,
		options: { preview?: boolean; mode?: Mode; didSwitchFromPlan?: boolean } = {},
	): Promise<[ClineContent[], string, boolean]> {
		const providerInfo = requestScope.providerInfo
		let needsClinerulesFileCheck = false

		// Pre-fetch necessary data to avoid redundant calls within loops
		const ulid = this.ulid
		const promptProfile = resolvePromptProfile({
			modelId: providerInfo.model.id,
			contextWindow: providerInfo.model.info.capabilities?.contextWindow,
		})
		const focusChainSettings =
			promptProfile === PromptProfile.Standard ? this.stateManager.getGlobalSettingsKey("focusChainSettings") : undefined
		const useNativeToolCalls = this.shouldUseNativeToolCalls(providerInfo)
		const cwd = this.cwd
		await refreshWorkflowToggles(this.controller, cwd)

		// Refresh skill toggles so slash commands and the frontend pick up newly added skills.
		// This mirrors the workflow toggle refresh pattern.
		await refreshSkills(this.controller)
		const taskCapabilityToggles = this.getTaskCapabilityToggles()
		const localWorkflowToggles = taskCapabilityToggles.localWorkflowToggles
		const globalWorkflowToggles = taskCapabilityToggles.globalWorkflowToggles
		const remoteConfigSettings = this.stateManager.getRemoteConfigSettings()

		const hasUserContentTag = (text: string): boolean => {
			return USER_CONTENT_TAGS.some((tag) => text.includes(tag))
		}

		const parseTextBlock = async (text: string, parseCommands = true): Promise<string> => {
			const parsedText = await parseMentions(
				text,
				cwd,
				this.urlContentFetcher,
				options.preview ? undefined : this.fileContextTracker,
				this.workspaceManager,
				{
					// A mention pulls file content into the prompt, so it is a read.
					validateFileAccess: (filePath, baseDir) => this.ignoreController.validateAccess(filePath, "read", baseDir),
					validateDirectoryAccess: (directoryPath, baseDir) =>
						this.ignoreController.validateDirectoryAccess(directoryPath, "read", baseDir),
				},
			)
			if (!parseCommands) return parsedText

			// Create MCP prompt fetcher callback that wraps mcpHub.getPrompt
			const mcpPromptFetcher = async (serverName: string, promptName: string) => {
				if (taskCapabilityToggles.mcpServers[serverName] !== true) {
					return null
				}
				try {
					return await this.mcpHub.getPrompt(serverName, promptName)
				} catch {
					return null
				}
			}

			const {
				processedText,
				needsClinerulesFileCheck: needsCheck,
				explicitInstructions,
			} = await parseSlashCommands(
				parsedText,
				localWorkflowToggles,
				globalWorkflowToggles,
				ulid,
				focusChainSettings,
				useNativeToolCalls,
				providerInfo,
				mcpPromptFetcher,
				{
					cwd,
					capabilityToggles: taskCapabilityToggles,
					remoteSkills: remoteConfigSettings.remoteGlobalSkills ?? [],
					remoteWorkflows: remoteConfigSettings.remoteGlobalWorkflows ?? [],
				},
				{ trustedUserText: true },
			)

			if (needsCheck) {
				needsClinerulesFileCheck = true
			}
			for (const declaration of explicitInstructions) {
				requestScope.explicitInstructions.register(declaration)
				if (declaration.source === "manual_compact_command") {
					this.taskState.isManualContextCompactionRequest = true
				}
			}
			return processedText
		}

		const processTextContent = async (block: ClineTextContentBlock): Promise<ClineTextContentBlock> => {
			if (block.type !== "text" || !hasUserContentTag(block.text)) {
				return block
			}

			const processedText = await processUserContentTags(block.text, (userText) => parseTextBlock(userText))
			return { ...block, text: processedText }
		}

		const processContentBlock = async (block: ClineContent): Promise<ClineContent> => {
			if (block.type === "text") {
				return processTextContent(block)
			}

			if (block.type === "tool_result") {
				if (!this.isTrustedUserFeedbackResult(block) || !block.content) {
					return block
				}

				const parseTrustedManualCompaction = hasManualCompactionIntent([block], () => true)
				const processTrustedText = (sourceText: string) =>
					processUserContentTags(sourceText, (text) => parseTextBlock(text, parseTrustedManualCompaction))

				if (typeof block.content === "string") {
					return { ...block, content: [{ type: "text", text: await processTrustedText(block.content) }] }
				}

				const processedContent = await Promise.all(
					block.content.map(async (contentBlock) =>
						contentBlock.type === "text"
							? { ...contentBlock, text: await processTrustedText(contentBlock.text) }
							: contentBlock,
					),
				)
				return { ...block, content: processedContent }
			}

			return block
		}

		// Process current user-authored content and dynamic environment details in parallel.
		// Tool-generated text remains opaque data unless it belongs to a canonically paired conversational result;
		// even then, only explicit user-content tags are eligible for mention or slash-command processing.
		//
		// This stage sits between "task created" and the first provider request with
		// no other logging, so a slow workspace scan or mention resolution used to
		// appear as an unexplained gap. The per-stage timings below attribute it.
		const loadContextStartedAt = performance.now()
		let mentionsMs = 0
		let environmentMs = 0
		const [processedUserContent, environmentDetails] = await Promise.all([
			Promise.all(userContent.map(processContentBlock)).finally(() => {
				mentionsMs = performance.now() - loadContextStartedAt
			}),
			this.getEnvironmentDetails(includeFileDetails, promptProfile, {
				preview: options.preview,
				api: requestScope.api,
				mode: options.mode ?? requestScope.providerInfo.mode,
			}).finally(() => {
				environmentMs = performance.now() - loadContextStartedAt
			}),
		])

		// Check clinerulesData if needed
		const clinerulesCheckStartedAt = performance.now()
		const clinerulesError = needsClinerulesFileCheck
			? await ensureLocalClineDirExists(this.cwd, GlobalFileNames.agentsRulesDir)
			: false
		const clinerulesMs = performance.now() - clinerulesCheckStartedAt
		const loadContextMs = performance.now() - loadContextStartedAt
		// 500ms is already far above a healthy load; below it the line would just
		// be noise on every turn.
		if (loadContextMs >= 500) {
			Logger.debug(
				`[Task ${this.taskId}] loadContext timing: total=${Math.round(loadContextMs)}ms, ` +
					`mentions=${Math.round(mentionsMs)}ms, environment=${Math.round(environmentMs)}ms, ` +
					`clinerules=${Math.round(clinerulesMs)}ms, includeFileDetails=${includeFileDetails}`,
			)
		}

		// Add focus chain instructions if needed
		if (
			promptProfile === PromptProfile.Standard &&
			!useCompactPrompt &&
			this.FocusChainManager?.shouldIncludeFocusChainInstructions({
				mode: options.mode,
				didSwitchFromPlan: options.didSwitchFromPlan,
			})
		) {
			const focusChainInstructions = this.FocusChainManager.generateFocusChainInstructions({
				preview: options.preview,
				mode: options.mode,
				didSwitchFromPlan: options.didSwitchFromPlan,
			})
			if (focusChainInstructions.trim()) {
				processedUserContent.push({
					type: "text",
					text: focusChainInstructions,
				})

				if (!options.preview) {
					this.taskState.apiRequestsSinceLastTodoUpdate = 0
					this.taskState.todoListWasUpdatedByUser = false
				}
			}
		}

		return [processedUserContent, environmentDetails, clinerulesError]
	}

	protected async processNativeToolCalls(assistantTextOnly: string, toolBlocks: ToolUse[]) {
		if (!toolBlocks?.length) {
			return
		}
		// For native tool calls, mark all pending tool uses as complete
		const prevLength = this.taskState.assistantMessageContent.length

		// Get finalized tool uses and mark them as complete
		const textContent = assistantTextOnly.trim()
		const prevTextBlock = this.taskState.assistantMessageContent.find((b) => b.type === "text") as
			| TextStreamContent
			| undefined
		// Use prevTextBlock.ts for the new text block so state and UI finalization share the same ts.
		const textTs = prevTextBlock?.ts ?? this.genMessageTs()
		const textBlocks: AssistantMessageContent[] = textContent
			? [{ type: "text", content: textContent, partial: false, ts: textTs }]
			: []

		// Finalize partial text using block.ts from prev text block.
		// Only finalize if the previous block is still partial; skipping
		// non-partial blocks avoids repeated finalize events on every native
		// tool_calls chunk.
		if (textBlocks.length > 0 && prevTextBlock?.partial) {
			if (prevTextBlock?.ts !== undefined) {
				await this.say("text", textContent, undefined, undefined, false, textTs)
			}
		}

		// Snapshot existing canonical function IDs before replacing content so we can
		// detect whether the incoming chunk introduces novel tools. Using the
		// post-replacement content for detection would always report "no new tools"
		// since nextBlocks already contains them.
		const prevContent = this.taskState.assistantMessageContent
		const existingFunctionIds = new Set(
			prevContent.filter((b): b is ToolUse => b.type === "tool_use").map((b) => b.function_id),
		)

		const nextBlocks = orderTurnEndingContentBlocks([...textBlocks, ...toolBlocks])
		this.taskState.assistantMessageContent = nextBlocks

		// Only reset index if there are actually new tool blocks that haven't been
		// executed yet. Collecting function IDs from the previous content lets us detect
		// whether this chunk introduces novel tools. Without this check, every
		// tool_calls chunk unconditionally resets currentStreamingContentIndex back
		// to the first tool, causing already-executed tools to re-run and produce
		// diff_error ("search patterns that don't match anything") on the second
		// pass because the file was already modified.
		if (toolBlocks.length > 0) {
			// Detect whether any tool in the new set is truly novel.
			const hasNewTools = toolBlocks.some((b) => !existingFunctionIds.has(b.function_id))

			if (hasNewTools || prevLength === 0) {
				// Find the first tool block whose lifecycle is NOT "complete-done".
				// Tools that already finished execution are skipped so they are
				// never re-executed when the index rewinds.
				const firstUnexecutedIndex = nextBlocks.findIndex((block) => {
					if (block.type !== "tool_use" || block.ts === undefined) return false
					const lifecycle = this.taskState.partialToolLifecycleByTs?.get(block.ts)
					return lifecycle !== "complete-done"
				})
				if (firstUnexecutedIndex !== -1) {
					this.taskState.currentStreamingContentIndex = firstUnexecutedIndex
				}
				this.taskState.userMessageContentReady = false
			}
		} else if (nextBlocks.length > prevLength) {
			this.taskState.userMessageContentReady = false
		}
	}

	/**
	 * Format workspace roots section for multi-root workspaces
	 */
	private formatWorkspaceRootsSection(): string {
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		const roots = this.workspaceManager?.getRoots() ?? []

		// Only show workspace roots if multi-root is enabled and there are multiple roots
		if (!multiRootEnabled || roots.length <= 1) {
			return ""
		}

		let section = "\n\n# Workspace Roots"

		// Format each root with its name, path, and VCS info
		for (const root of roots) {
			const name = root.name || path.basename(root.path)
			const vcs = root.vcs ? ` (${String(root.vcs)})` : ""
			section += `\n- ${name}: ${root.path}${vcs}`
		}

		// Add primary workspace information
		const primary = this.workspaceManager?.getPrimaryRoot()
		const primaryName = this.getPrimaryWorkspaceName(primary)
		section += `\n\nPrimary workspace: ${primaryName}`

		return section
	}

	/**
	 * Get the display name for the primary workspace
	 */
	private getPrimaryWorkspaceName(primary?: ReturnType<WorkspaceRootManager["getRoots"]>[0]): string {
		if (primary?.name) {
			return primary.name
		}
		if (primary?.path) {
			return path.basename(primary.path)
		}
		return path.basename(this.cwd)
	}

	/**
	 * Format the file details header based on workspace configuration
	 */
	private formatFileDetailsHeader(): string {
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		const roots = this.workspaceManager?.getRoots() || []

		if (multiRootEnabled && roots.length > 1) {
			const primary = this.workspaceManager?.getPrimaryRoot()
			const primaryName = this.getPrimaryWorkspaceName(primary)
			return `\n\n# Current Working Directory (Primary: ${primaryName}) Files\n`
		}
		return `\n\n# Current Working Directory (${this.cwd.toPosix()}) Files\n`
	}

	/**
	 * Return the task summary for Active Tasks environment details.
	 * @returns The initial task text or an empty string when unavailable.
	 */
	getActiveTaskSummary(): string {
		const taskMessage = this.messageStateHandler.clineMessages.find((message) => message.say === "task")
		return taskMessage?.text ?? ""
	}

	/** Return the canonical runtime phase for Active Tasks environment details. */
	getActiveTaskPhase(): string {
		return this.taskRuntime.getState().phase
	}

	/**
	 * Return files edited during this active task lifetime.
	 * @returns Normalized absolute file paths tracked by TaskFileTracker.
	 */
	getActiveTaskEditedFiles(): string[] {
		return this.taskFileTracker.getAllModifiedFiles()
	}

	async getEnvironmentDetails(
		includeFileDetails = false,
		requestPromptProfile?: PromptProfile,
		options: { preview?: boolean; api?: ApiHandler; mode?: Mode } = {},
	) {
		const host = await HostProvider.env.getHostVersion({})
		const effectiveApi = options.api ?? this.api
		const effectiveMode = options.mode ?? this.taskSm.mode
		let details = ""

		// Dline extension version (all builds)
		details += `# Dline Version\n${host.clineVersion || "unknown"}`

		// Workspace roots (multi-root)
		details += this.formatWorkspaceRootsSection()

		// It could be useful for cline to know if the user went from one or no file to another between messages, so we always include this context
		details += `\n\n# ${host.platform} Visible Files`
		const rawVisiblePaths = (await HostProvider.window.getVisibleTabs({})).paths
		const filteredVisiblePaths = await filterExistingFiles(rawVisiblePaths)
		const visibleFilePaths = filteredVisiblePaths.map((absolutePath) => path.relative(this.cwd, absolutePath))

		// Filter paths through clineIgnoreController
		const allowedVisibleFiles = this.ignoreController
			.filterPaths(visibleFilePaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedVisibleFiles) {
			details += `\n${allowedVisibleFiles}`
		} else {
			details += "\n(No visible files)"
		}

		details += `\n\n# ${host.platform} Open Tabs`
		const rawOpenTabPaths = (await HostProvider.window.getOpenTabs({})).paths
		const filteredOpenTabPaths = await filterExistingFiles(rawOpenTabPaths)
		const openTabPaths = filteredOpenTabPaths.map((absolutePath) => path.relative(this.cwd, absolutePath))

		// Filter paths through clineIgnoreController
		const allowedOpenTabs = this.ignoreController
			.filterPaths(openTabPaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedOpenTabs) {
			details += `\n${allowedOpenTabs}`
		} else {
			details += "\n(No open tabs)"
		}

		if (this.stateManager.getGlobalSettingsKey("showActiveTasksInEnvDetails") !== false) {
			const { OrchestratorController } = await import("../orchestrator/OrchestratorController")
			const activeTasksSection = buildActiveTasksSection({
				controllers: OrchestratorController.getInstance().getActiveControllers(),
				currentCwd: this.cwd,
				excludeTaskId: this.taskId,
			})
			if (activeTasksSection) {
				details += `\n\n${activeTasksSection}`
			}
		}

		const busyTerminals = this.terminalManager.getTerminals(true)

		if (!options.preview) this.taskState.didEditFile = false

		let terminalDetails = ""
		if (busyTerminals.length > 0) {
			terminalDetails += "\n\n# Actively Running Terminals"
			for (const busyTerminal of busyTerminals) {
				terminalDetails += `\n- ${busyTerminal.id}: running - \`${busyTerminal.lastCommand}\``
			}
		}

		if (terminalDetails) {
			details += terminalDetails
		}

		const backgroundEnvironment = buildTaskBackgroundEnvironmentSection(this.toolExecutor, this.commandExecutor)
		if (!options.preview) this.pendingBackgroundCommandLineCounts = backgroundEnvironment.commandLineCounts
		if (backgroundEnvironment.text) {
			details += `\n\n${backgroundEnvironment.text}`
		}

		// Add recently modified files section without consuming it before ordinary Provider admission.
		const recentlyModifiedFilesSnapshot = this.fileContextTracker.peekRecentlyModifiedFiles()
		if (!options.preview) this.pendingRecentlyModifiedFilesSnapshot = recentlyModifiedFilesSnapshot
		const recentlyModifiedFiles = recentlyModifiedFilesSnapshot.files
		if (recentlyModifiedFiles.length > 0) {
			details +=
				"\n\n# Recently Modified Files\nThese files have been modified since you last accessed them (file was just edited so you may need to re-read it before editing):"
			for (const filePath of recentlyModifiedFiles) {
				details += `\n${filePath}`
			}
		}

		// Add current time information with timezone
		const now = new Date()
		const formatter = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: true,
		})
		const timeZone = formatter.resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60 // Convert to hours and invert sign to match conventional notation
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : ""}${timeZoneOffset}:00`
		details += `\n\n# Current Time\n${formatter.format(now)} (${timeZone}, UTC${timeZoneOffsetStr})`

		if (includeFileDetails) {
			details += this.formatFileDetailsHeader()
			const isDesktop = arePathsEqual(this.cwd, getDesktopDir())
			if (isDesktop) {
				// don't want to immediately access desktop since it would show permission popup
				details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
			} else {
				const [fileInfos, didHitLimit] = await listFiles(this.cwd, true, 200, {
					ignoreController: this.ignoreController,
				})
				const result = formatResponse.formatFilesList(this.cwd, fileInfos, didHitLimit, this.ignoreController)
				details += result
			}

			// Add workspace information in JSON format
			if (this.workspaceManager) {
				const workspacesJson = await this.workspaceManager.buildWorkspacesJson()
				if (workspacesJson) {
					details += `\n\n# Workspace Configuration\n${workspacesJson}`
				}
			}

			// Add detected CLI tools
			const availableCliTools = await detectAvailableCliTools()
			if (availableCliTools.length > 0) {
				details += `\n\n# Detected CLI Tools\nThese are some of the tools on the user's machine, and may be useful if needed to accomplish the task: ${availableCliTools.join(", ")}. This list is not exhaustive, and other tools may be available.`
			}
		}

		// Add context window usage information (conditionally for some models)
		const { contextWindow } = getContextWindowInfo(effectiveApi)

		// Get the token count from the most recent API request to accurately reflect context management
		/** Read normalized context occupancy from one persisted request message. */
		const getTotalTokensFromApiReqMessage = (msg: ClineMessage): number => {
			return readContextTokens(msg.text)
		}

		const clineMessages = this.messageStateHandler.clineMessages
		const modifiedMessages = combineApiRequests(combineCommandSequences(clineMessages.slice(1)))
		const lastApiReqMessage = findLast(modifiedMessages, (msg) => {
			if (msg.say !== "api_req_started") {
				return false
			}
			return getTotalTokensFromApiReqMessage(msg) > 0
		})

		const lastApiReqTotalTokens = lastApiReqMessage ? getTotalTokensFromApiReqMessage(lastApiReqMessage) : 0
		const usagePercentage = Math.round((lastApiReqTotalTokens / contextWindow) * 100)

		const currentModelId = effectiveApi.getModel().id
		if (showContextUsage({ contextWindow, lastApiReqTotalTokens, modelId: currentModelId })) {
			details += "\n\n# Context Window Usage"
			details += `\n${lastApiReqTotalTokens.toLocaleString()} / ${(contextWindow / 1000).toLocaleString()}K tokens used (${usagePercentage}%)`
			// Notify AI that auto-compact is enabled so it doesn't refuse long tasks
			const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")
			if (useAutoCondense) {
				details += "\n\nAuto-Compact is enabled. Context will be automatically compacted as needed."
			}
		}

		details += "\n\n# Current Mode"
		if (effectiveMode === "plan") {
			details += `\nPLAN MODE\n${formatResponse.planModeInstructions()}`
		} else {
			details += "\nACT MODE"
		}

		// Add focus chain task_progress status if enabled and checklist exists
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		const providerInfo = requestPromptProfile
			? undefined
			: {
					providerId: effectiveApi.getProviderId?.() ?? DEFAULT_API_PROVIDER,
					model: effectiveApi.getModel(),
					mode: effectiveMode,
				}
		const promptProfile =
			requestPromptProfile ??
			resolvePromptProfile({
				modelId: providerInfo?.model.id,
				contextWindow: providerInfo?.model.info.capabilities?.contextWindow,
			})
		if (
			promptProfile === PromptProfile.Standard &&
			focusChainSettings?.enabled &&
			this.taskState.currentFocusChainChecklist
		) {
			const checklist = this.taskState.currentFocusChainChecklist
			details += `\n\n${formatFocusChainTaskProgressSection(checklist, this.taskState.currentInProgressItemIndex)}`
		}

		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}
}
