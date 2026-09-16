// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'

import { WorkspaceRoot } from "@shared/multi-root/types"
import { RemoteConfigFields } from "@shared/storage/state-keys"
import type { Environment } from "../config"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import { ApiConfiguration } from "./api"
import { BrowserSettings } from "./BrowserSettings"
import type { ChatInputSendShortcut } from "./ChatInputSendShortcut"
import { ClineFeatureSetting } from "./ClineFeatureSetting"
import { ClineRulesToggles } from "./cline-rules"
import type { CodeExecutionPresentationV1 } from "./code-execution-tools"
import type { ContextWindowIndicatorSnapshot } from "./context-window-indicator"
import { FocusChainSettings } from "./FocusChainSettings"
import { HistoryItem } from "./HistoryItem"
import type { QueuedInputEntry } from "./InputQueue"
import type { ImageGenerationPresentationV1 } from "./image-generation"
import type { LoadCapabilityPayload } from "./load-capabilities"
import { McpDisplayMode } from "./McpDisplayMode"
import { ClineMessageModelInfo } from "./messages"
import type { ModeSwitchSnapshot } from "./mode-switch"
import type { PromptCacheHealthSnapshot } from "./PromptCacheHealth"
import type { PromptFreshnessSnapshot } from "./PromptFreshness"
import type { ProfileSwitchSnapshot } from "./profile-switch"
import { OnboardingModelGroup } from "./proto/dline/state"
import type { TaskLockStatus } from "./proto/dline/task"
import { Mode } from "./storage/types"
import type { TaskCapabilityToggles } from "./TaskCapabilityToggles"
import { TelemetrySetting } from "./TelemetrySetting"
import { UserInfo } from "./UserInfo"
import type { LocalSearchEngineId } from "./web-search"
import type { WebFetchPresentationV1, WebSearchPresentationV1 } from "./web-tools"
// webview will hold state
export interface ExtensionMessage {
	type: "grpc_response" // New type for gRPC responses
	grpc_response?: GrpcResponse
}

/**
 * One protobuf message serialized as a JSON object.
 *
 * Which message it is depends on the RPC that produced it, so this fixes only
 * what every response shares: a message is always an object, never a bare
 * scalar. The RPC's generated type supplies the concrete fields at the call
 * site.
 */
export type ProtoJsonMessage = object

export type GrpcResponse = {
	message?: ProtoJsonMessage // JSON serialized protobuf message
	request_id: string // Same ID as the request
	error?: string // Optional error message
	is_streaming?: boolean // Whether this is part of a streaming response
	sequence_number?: number // For ordering chunks in streaming responses
}

export type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "unknown"

export const DEFAULT_PLATFORM = "unknown"

export const COMMAND_CANCEL_TOKEN = "__cline_command_cancel__"

/** Canonical lifecycle status for a command timeline message. */
export type CommandStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "interrupted"

export interface ExtensionState {
	/** Monotonic revision used to reject stale asynchronous state snapshots. */
	stateRevision: number
	/** Current task-local mode-switch transaction state. */
	modeSwitch?: ModeSwitchSnapshot
	/** Current task-local Profile transition state. */
	profileSwitch?: ProfileSwitchSnapshot
	isNewUser: boolean
	welcomeViewCompleted: boolean
	onboardingModels: OnboardingModelGroup | undefined
	apiConfiguration?: ApiConfiguration
	autoApprovalSettings: AutoApprovalSettings
	browserSettings: BrowserSettings
	remoteBrowserHost?: string
	preferredLanguage?: string
	chatInputSendShortcut: ChatInputSendShortcut
	mode: Mode
	checkpointManagerErrorMessage?: string
	/** Task description displayed in fixed header; sent once, never repeated */
	taskTitleMessage?: ClineMessage
	/** Total count of body messages (excluding task) for virtuoso totalCount */
	totalMessageCount?: number
	/** Index of the first item in the current window within the full message list */
	firstItemIndex?: number
	currentTaskItem?: HistoryItem
	currentFocusChainChecklist?: string | null
	focusChainHistory?: string | null
	/**
	 * Set when this payload was reduced because it exceeded the size a state
	 * push may occupy. Some fields are then absent rather than empty, and the
	 * webview must not read their absence as the user having no data.
	 */
	stateDegraded?: boolean
	mcpMarketplaceEnabled?: boolean
	mcpDisplayMode: McpDisplayMode
	planActSeparateModelsSetting: boolean
	enableCheckpointsSetting?: boolean
	platform: Platform
	environment?: Environment
	shouldShowAnnouncement: boolean
	taskHistory: HistoryItem[]
	usageReportingSetting: TelemetrySetting
	errorReportingSetting: TelemetrySetting
	/** Complete task interaction projection derived only from runtime state. */
	taskViewState?: TaskViewState
	/** Input the user queued while the task was busy; the backend owns it. */
	inputQueue?: QueuedInputEntry[]
	shellIntegrationTimeout: number
	terminalReuseEnabled?: boolean
	terminalOutputLineLimit: number
	terminalCommandTimeoutSeconds: number
	terminalCommandHandoffSeconds: number
	maxConsecutiveMistakes: number
	defaultTerminalProfile?: string
	vscodeTerminalExecutionMode: string
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	lastCompletedCommandTs?: number
	userInfo?: UserInfo
	version: string
	distinctId: string
	globalClineRulesToggles: ClineRulesToggles
	localClineRulesToggles: ClineRulesToggles
	localWorkflowToggles: ClineRulesToggles
	globalWorkflowToggles: ClineRulesToggles
	localCursorRulesToggles: ClineRulesToggles
	localWindsurfRulesToggles: ClineRulesToggles
	remoteRulesToggles?: ClineRulesToggles
	remoteWorkflowToggles?: ClineRulesToggles
	localAgentsRulesToggles: ClineRulesToggles
	mcpResponsesCollapsed?: boolean
	strictPlanModeEnabled?: boolean
	yoloModeToggled?: boolean
	useAutoCondense?: boolean
	autoCondenseTriggerPercent?: number
	autoCondenseMinReserveTokens?: number
	autoCondenseMaxReserveTokens?: number
	autoCondenseMaxContextTokens?: number
	subagentsEnabled?: boolean
	mcpEnabled?: boolean
	imageGenerationEnabled?: boolean
	clineWebToolsEnabled?: ClineFeatureSetting
	localWebSearchEngine?: LocalSearchEngineId
	searxngSearchUrl?: string
	worktreesEnabled?: ClineFeatureSetting
	focusChainSettings: FocusChainSettings
	customPrompt?: string
	favoritedModelIds: string[]
	/** Version counter incremented when ModelRegistry reloads from disk (fs-watch). Webview uses this to re-fetch models. */
	providersVersion: number
	/** Process-local revision incremented after each local or externally observed Profile Catalog commit. */
	profileCatalogRevision: number
	// NEW: Add workspace information
	workspaceRoots: WorkspaceRoot[]
	primaryRootIndex: number
	isMultiRootWorkspace: boolean
	multiRootSetting: ClineFeatureSetting
	hooksEnabled?: boolean
	remoteConfigSettings?: Partial<RemoteConfigFields>
	globalSkillsToggles?: Record<string, boolean>
	localSkillsToggles?: Record<string, boolean>
	remoteSkillsToggles?: Record<string, boolean>
	/** Task-local capability snapshot used for prompt construction and refresh. */
	taskCapabilityToggles?: TaskCapabilityToggles
	nativeToolCallSetting?: boolean
	enableParallelToolCalling?: boolean
	backgroundEditEnabled?: boolean
	optOutOfRemoteConfig?: boolean
	doubleCheckCompletionEnabled?: boolean
	lazyTeammateModeEnabled?: boolean
	showFeatureTips?: boolean
	showActiveTasksInEnvDetails?: boolean
	openAiCodexIsAuthenticated?: boolean
	/** API usage metrics, computed from all messages by the backend */
	apiMetrics?: {
		totalTokensIn: number
		totalTokensOut: number
		totalCacheWrites?: number
		totalCacheReads?: number
		totalCost: number
		cacheHitRate?: number // Overall cache hit rate percentage (0-100)
		currency?: string // Billing currency code
		activeSeconds?: number
		requestsPerMinute?: number
		tokensPerMinute?: number
		rpmBasis?: "execution_duration" | "provider_duration" | "legacy_active_seconds" | "unavailable"
		executionCount?: number
	}
	/** Authoritative segmented context-window indicator for the active Task. */
	contextWindowIndicator?: ContextWindowIndicatorSnapshot
	/** Compatibility total derived from contextWindowIndicator's four segments. */
	lastApiReqTotalTokens?: number
	/** Current Task-local prompt cache health snapshot. */
	promptCacheHealth?: PromptCacheHealthSnapshot
	/** Current Task-local frozen prompt freshness snapshot. */
	promptFreshness?: PromptFreshnessSnapshot
	/** Account-level usage/balance info queried from provider API */
	accountUsage?: AccountUsageData
	/** Task lock status indicating if the current task is locked by another instance */
	taskLockStatus?: TaskLockStatus
}

/**
 * Account-level usage or balance information.
 * Shared type used by both core API handlers and webview UI.
 * Kept in sync with proto AccountUsage message.
 */
export interface AccountUsageData {
	/** Profile and provider that own this snapshot. Populated by the usage service boundary. */
	profileId?: string
	providerId?: string
	currency: string
	remainingBalance?: number
	toppedUpBalance?: number
	grantedBalance?: number
	planType?: string
	allowed?: boolean
	limitReached?: boolean
	/** Usage quota windows for quota-mode providers (e.g., Codex, Copilot) */
	quotas?: AccountUsageQuotaData[]
	/** Optional provider-owned reset credits exposed through the shared usage capability. */
	resetCredits?: AccountUsageResetCreditData[]
	resetCreditsAvailableCount?: number
	isAvailable?: boolean
	dailyInputTokens?: number
	dailyOutputTokens?: number
	dailyCacheHitTokens?: number
	dailyCacheMissTokens?: number
}

/** Single provider-owned reset credit that can be consumed through the shared usage action. */
export interface AccountUsageResetCreditData {
	id: string
	grantedAt?: string
	expiresAt?: string
}

/** Single usage quota window */
export interface AccountUsageQuotaData {
	type: string
	label: string
	used: number
	limit: number
	windowSeconds?: number
	resetAt?: string
	resetLabel?: string
}

export interface CompactionConversationRange {
	logicalTurnRange: readonly [startIndex: number, endIndex: number]
	apiConversationRange: readonly [startIndex: number, endIndex: number]
	preCompactionApiEndIndex: number
}

export interface ClineMessage {
	ts: number
	type: "ask" | "say"
	ask?: ClineAsk
	say?: ClineSay
	text?: string
	reasoning?: string
	images?: string[]
	files?: string[]
	partial?: boolean
	commandStatus?: CommandStatus
	/** Whether this command currently owns the foreground turn or is detached in the background. */
	commandExecutionMode?: CommandExecutionMode
	/** Legacy persisted handoff flag; current UI uses the backend-projected footer action. */
	commandCanMoveToBackground?: boolean
	/** Stable identity of the interaction that owns this ask presentation. */
	interactionId?: string
	/** Distinguishes directly submitted input from input delivered by InputQueue. */
	userInputKind?: "direct" | "queued"
	/** Original InputQueue delivery pool for queued user input. */
	queuedInputMode?: "queued" | "steering"
	/** Stable identity shared by the command message, activity, background record, and cancellation entry. */
	activityId?: string
	/** ts of the associated command message (set on command_output messages) */
	commandTs?: number
	exitCode?: number
	logPath?: string
	lastCheckpointHash?: string
	isCheckpointCheckedOut?: boolean
	/**
	 * Whether this completion produced workspace changes that can be diffed.
	 *
	 * Carried as its own field rather than encoded into `text`, because the
	 * completion row is rewritten as an ask presentation using the model's
	 * original result text, which would drop any marker appended to it.
	 */
	completionHasChanges?: boolean
	isOperationOutsideWorkspace?: boolean
	conversationHistoryIndex?: number
	conversationHistoryDeletedRange?: [number, number] // for when conversation history is truncated for API requests
	/** Canonical pre-compaction range stored only on a durable completed compaction card. */
	compactionConversationRange?: CompactionConversationRange
	modelInfo?: ClineMessageModelInfo
	imageGeneration?: ImageGenerationPresentationV1
}

export type CommandExecutionMode = "foreground" | "background"

export type ClineAsk =
	| "followup"
	| "make_plan"
	| "act_mode_respond"
	| "command"
	| "command_output"
	| "completion_result"
	| "tool"
	| "api_req_failed"
	| "resume_task"
	| "resume_completed_task"
	| "mistake_limit_reached"
	| "browser_action_launch"
	| "use_mcp_server"
	| "new_task"
	| "spawn_task"
	| "condense"
	| "change_todo_list"
	| "qna_respond"
	| "summarize_task"
	| "report_bug"
	| "use_subagents"
	| "status_acknowledgment"
	| "generate_report"

export type ClineSay =
	| "task"
	| "error"
	| "error_retry"
	| "api_req_started"
	| "api_req_finished"
	| "text"
	| "reasoning"
	| "qna_respond"
	| "completion_result"
	| "user_feedback"
	| "user_feedback_diff"
	| "api_req_retried"
	| "command"
	| "command_output"
	| "tool"
	| "shell_integration_warning"
	| "shell_integration_warning_with_suggestion"
	| "browser_action_launch"
	| "browser_action"
	| "browser_action_result"
	| "mcp_server_request_started"
	| "mcp_server_response"
	| "mcp_notification"
	| "use_mcp_server"
	| "diff_error"
	| "deleted_api_reqs"
	| "clineignore_error"
	| "command_permission_denied"
	| "checkpoint_created"
	| "load_mcp_documentation"
	| "generate_explanation"
	| "info" // Added for general informational messages like retry status
	| "task_progress"
	| "hook_status"
	| "hook_output_stream"
	| "subagent"
	| "use_subagents"
	| "subagent_usage"
	| "conditional_rules_applied"
	| "partial_tool_result"
	| "state_snapshot"

/**
 * Task UI phase classifications for frontend footer/input state.
 */
export type TaskUiPhase =
	| "idle"
	| "working"
	| "awaiting_input"
	| "awaiting_approval"
	| "awaiting_acknowledgment"
	| "awaiting_resume"
	| "awaiting_error_recovery"
	| "completed"
	| "cancelled"

/**
 * Action types available to user in task UI.
 */
export interface TaskUiAction {
	type:
		| "approve"
		| "reject"
		| "cancel"
		| "resume"
		| "retry"
		| "process_anyway"
		| "start_new_task"
		| "primary"
		| "secondary"
		| "utility"
	label: string
	enabled: boolean
}

/**
 * Unified task UI state derived from TaskSnapshot.
 * This is the single source of truth for footer buttons and input state.
 */
export interface TaskUiState {
	phase: TaskUiPhase
	inputEnabled: boolean
	cancelEnabled: boolean
	showFooter: boolean
	actions: TaskUiAction[]
	activeAsk?: ClineAsk
	activeFunctionId?: string
	message?: string
	reason: string
}

/** Runtime phases projected without message-derived classification. */
export type TaskViewPhase =
	| "idle"
	| "initializing"
	| "waiting_for_task"
	| "streaming"
	| "awaiting_approval"
	| "executing"
	| "between_turns"
	| "resuming"
	| "cancelling"
	| "aborted"
	| "completed"
	| "paused"

/** Action identifiers supported by the causal task interaction protocol. */
export type TaskViewActionType =
	| "approve"
	| "reject"
	| "reply"
	| "resume"
	| "retry"
	| "process_anyway"
	| "start_new_task"
	| "acknowledge"
	| "stop"
	| "confirm_utility"
	| "continue_in_background"
	| "cancel"

/** Payload required when dispatching one projected action. */
export type TaskViewPayloadPolicy = "none" | "draft" | "selection" | "draft_and_selection"

/** One footer action projected from runtime state. */
export interface TaskViewAction {
	type: TaskViewActionType
	label: string
	appearance: "primary" | "secondary" | "danger"
	enabled: boolean
	payloadPolicy: TaskViewPayloadPolicy
	dispatchTarget: "interaction" | "task"
	/** Stable command identity required by command-scoped task actions. */
	activityId?: string
}

/** Diagnostic for an interaction that cannot be projected to its persisted ask anchor. */
export interface TaskViewDiagnostic {
	code: "interaction_anchor_missing" | "interaction_anchor_is_say"
	interactionId: string
}

/** Input capabilities projected for the current active interaction. */
export interface TaskInputViewState {
	enabled: boolean
	acceptsText: boolean
	acceptsImages: boolean
	acceptsFiles: boolean
	enterAction?: TaskViewActionType
}

/** Causal identity and presentation anchor for one active interaction. */
export interface ActiveInteractionView {
	taskId: string
	turnId: string
	interactionId: string
	kind: string
	status: "opening" | "awaiting" | "resolving"
	stateRevision: number
	taskAsk: ClineAsk
	presentationKind: string
	askMessageTs: number
}

/** Footer content owned exclusively by the backend task projection. */
export interface TaskFooterViewState {
	actions: TaskViewAction[]
}

/** Active context-compaction ownership projected by the backend Session. */
export interface TaskContextCompactionViewState {
	active: true
	operationId: string
}

/** Complete backend projection consumed by the Webview interaction host. */
export interface TaskViewState {
	taskId: string
	phase: TaskViewPhase
	stateRevision: number
	activeInteraction?: ActiveInteractionView
	diagnostic?: TaskViewDiagnostic
	contextCompaction?: TaskContextCompactionViewState
	/** True only while terminal automatic-compaction recovery offers explicit history truncation. */
	forceTruncateAvailable?: boolean
	input: TaskInputViewState
	footer: TaskFooterViewState
}

export interface ClineSayTool {
	tool:
		| "editedExistingFile"
		| "newFileCreated"
		| "fileDeleted"
		| "readFile"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "listCodeDefinitionNames"
		| "searchFiles"
		| "webFetch"
		| "webSearch"
		| "codeExecution"
		| "summarizeTask"
		| "useSkill"
		| "loadCapability"
		| "findReferences"
		| "renameSymbol"
		| "replaceText"
		| "focusChainChanged"
		| "statusUpdate"
		| "actModeRespond"
		| "killCommand"
		| "generateImage"
	path?: string
	/** Activity target associated with a command result presentation. */
	activityId?: string
	diff?: string
	content?: string | string[]
	/** Lifecycle for one conversation-compaction execution-unit card. */
	compactionStatus?: "preparing" | "waiting" | "receiving" | "running" | "retrying" | "failed" | "completed"
	/** Distinguishes an ordinary rolling Pass from a cumulative-summary refit. */
	compactionUnitKind?: "pass" | "summary_refit" | "failure"
	/** Stable zero-based index within the unit kind for one operation. */
	compactionUnitIndex?: number
	/** True only after this execution-unit card has been committed to durable message history. */
	compactionDurable?: boolean
	/** Actionable compaction failure detail. */
	error?: string
	/** One-based retry attempt currently scheduled. */
	retryAttempt?: number
	/** Maximum automatic retry attempts. */
	maxRetryAttempts?: number
	/** Stable compaction operation owning this Pass card. */
	compactionOperationId?: string
	/** Zero-based immutable Pass index within the compaction operation. */
	compactionPassIndex?: number
	/** Zero-based Provider attempt index currently owning this card update. */
	compactionAttemptIndex?: number
	/** Request-scoped authorization attempt identity for stale-event rejection. */
	compactionAttemptId?: string
	/** Checkpoint immediately before this accepted Pass. */
	compactionPrePassCheckpointId?: string
	/** Checkpoint head immediately after this accepted Pass. */
	compactionPostPassCheckpointId?: string
	/** CAS head identity required when restoring the pre-Pass checkpoint. */
	compactionExpectedHeadCheckpointId?: string
	/** CAS chain revision required when restoring the pre-Pass checkpoint. */
	compactionExpectedChainRevision?: number
	/** Branch identity for diagnostics and stale-card rejection. */
	compactionBranchId?: string
	webSearch?: WebSearchPresentationV1
	webFetch?: WebFetchPresentationV1
	imageGeneration?: ImageGenerationPresentationV1
	/** Provider-hosted sandbox run: the code sent, what it printed, and how it ended. */
	codeExecution?: CodeExecutionPresentationV1
	regex?: string
	filePattern?: string
	operationIsLocatedInWorkspace?: boolean
	/** Starting line numbers in the original file where each SEARCH block matched */
	startLineNumbers?: number[]
	/** Inclusive line range actually returned by read_file (for UI summaries). */
	readLineStart?: number
	readLineEnd?: number
	/** Error message when diff construction fails (e.g. SEARCH block not matched) */
	diffError?: string
	/** Per-block error messages, same index as startLineNumbers for multi-block diffs. */
	blockErrors?: (string | undefined)[]
	/** Structured match entries for rename / replace_text tools. */
	matches?: Array<{
		file: string
		line: number
		column: number
		originalText: string
		newText: string
		diff: string
	}>
	/** Structured reference entries for find_references tool. */
	references?: Array<{
		file: string
		line: number
		character: number
		context: string
	}>
	/** Symbol name for find_references tool. */
	symbolName?: string
	/** File count for batch tools. */
	files?: number
	/** Change/reference count for batch tools. */
	count?: number
	/** True when the backend capped the result set, so count is a lower bound. */
	truncated?: boolean
	/** Whether the operation is a dry-run preview. */
	dryRun?: boolean
	/** Structured payload for load_mcp/load_skill/load_workflow rendering. */
	loadCapability?: LoadCapabilityPayload
}

export interface ClineSayHook {
	hookName: string // Name of the hook (e.g., "PreToolUse", "PostToolUse")
	toolName?: string // Tool name if applicable (for PreToolUse/PostToolUse)
	status: "running" | "completed" | "failed" | "cancelled" // Execution status
	exitCode?: number // Exit code when completed
	hasJsonResponse?: boolean // Whether a JSON response was parsed
	// Pending tool information (only present during PreToolUse "running" status)
	pendingToolInfo?: {
		tool: string // Tool name (e.g., "write_to_file", "execute_command")
		path?: string // File path for file operations
		command?: string // Command for execute_command
		content?: string // Content preview (first 200 chars)
		diff?: string // Diff preview (first 200 chars)
		regex?: string // Regex pattern for search_files
		url?: string // URL for web_fetch or browser_action
		mcpTool?: string // MCP tool name
		mcpServer?: string // MCP server name
		resourceUri?: string // MCP resource URI
	}
	// Structured error information (only present when status is "failed")
	error?: {
		type: "timeout" | "validation" | "execution" | "cancellation" // Type of error
		message: string // User-friendly error message
		details?: string // Technical details for expansion
		scriptPath?: string // Path to the hook script
	}
}

export type HookOutputStreamMeta = {
	/** Which hook configuration the script originated from (global vs workspace). */
	source: "global" | "workspace"
	/** Full path to the hook script that emitted the output. */
	scriptPath: string
}

// must keep in sync with system prompt
export const browserActions = ["launch", "click", "type", "scroll_down", "scroll_up", "close"] as const
export type BrowserAction = (typeof browserActions)[number]

export interface ClineSayBrowserAction {
	action: BrowserAction
	coordinate?: string
	text?: string
}

export interface ClineSayGenerateExplanation {
	title: string
	fromRef: string
	toRef: string
	status: "generating" | "complete" | "error"
	error?: string
}

export type SubagentExecutionStatus = "pending" | "running" | "completed" | "failed" | "timeout" | "cancelled"

export type SubagentInjectionState = "pending" | "injected" | "consumed"

export interface SubagentStatusItem {
	index: number
	prompt: string
	status: SubagentExecutionStatus
	toolCalls: number
	inputTokens: number
	outputTokens: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	cacheHitRate?: number
	totalCost: number
	currency: string
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
	jobId?: string
	subagentName?: string
	task?: string
	context?: string
	background?: boolean
	backgroundHandoffAvailable?: boolean
	timeoutSeconds?: number
	startedAt?: number
	finishedAt?: number
	injectionState?: SubagentInjectionState
	latestToolCall?: string
	result?: string
	error?: string
}

export interface ClineSaySubagentStatus {
	kind?: "single" | "batch"
	status: SubagentExecutionStatus
	total: number
	completed: number
	successes: number
	failures: number
	toolCalls: number
	inputTokens: number
	outputTokens: number
	contextWindow: number
	maxContextTokens: number
	maxContextUsagePercentage: number
	items: SubagentStatusItem[]
	jobId?: string
	batchJobId?: string
	background?: boolean
	timeoutSeconds?: number
	injectionState?: SubagentInjectionState
}

export type BrowserActionResult = {
	screenshot?: string
	logs?: string
	currentUrl?: string
	currentMousePosition?: string
}

export interface ClineAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
}

export interface ClineAskUseSubagents {
	prompts: string[]
	items?: Array<{ task: string; context: string; subagentName?: string; jobId?: string }>
	kind?: "single" | "batch"
	subagentName?: string
	task?: string
	context?: string
	/** @deprecated Use context. */
	content?: string
	background?: boolean
	timeoutSeconds?: number
	error?: string
	message?: string
	/**
	 * Activity identity of the run this row represents, once one exists.
	 *
	 * This row is emitted before the run starts, so it carries no live figures of
	 * its own. Carrying the job id lets the renderer read metrics, controls, and
	 * status from the owning activity instead of showing a frozen zero snapshot
	 * when the row outlives its brief pre-start window.
	 */
	jobId?: string
}

export interface ClineMakePlanResponse {
	response: string
}

export interface ClineQnaResponse {
	response: string
}

export interface ClineAskQuestion {
	question: string
	options?: string[]
	selected?: string
}

export interface ClineAskNewTask {
	context: string
}

export interface ClineAskSpawnTask {
	task: string
	mode: Mode
	context: string
}

export interface ClineApiReqInfo {
	request?: string
	/** Canonical context occupancy after provider usage normalization. */
	contextTokens?: number
	/** Absolute request-pressure estimate captured before Provider admission. */
	estimatedContextTokens?: number
	/** Distinguishes reliable Provider usage from a request-pressure estimate. */
	contextTokensSource?: "provider" | "estimate"
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	cacheHitRate?: number // Cache hit rate as percentage (0-100)
	currency?: string // Billing currency code
	inputPrice?: number // Price per 1M input tokens
	outputPrice?: number // Price per 1M output tokens
	cancelReason?: ClineApiReqCancelReason
	streamingFailedMessage?: string
	retryStatus?: {
		attempt: number
		maxAttempts: number
		delaySec: number
		errorSnippet?: string
	}
}

export interface ClineSubagentUsageInfo {
	source: "subagents"
	tokensIn: number
	tokensOut: number
	cacheWrites: number
	cacheReads: number
	cost: number
}

export type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled" | "retries_exhausted"

export const COMPLETION_RESULT_CHANGES_FLAG = "HAS_CHANGES"
