/**
 * Names of every event and metric the product emits.
 *
 * The catalogue is data, not behaviour, and it lives apart from the recorders
 * that emit it for one reason: these strings are a published contract. A
 * dashboard, a saved query, or a downstream pipeline breaks when a name
 * changes, so the set of names has to be reviewable on its own rather than
 * scattered across the call sites that happen to use them.
 */

/** Longest error text attached to an event. Bounds accidental payload growth. */
export const MAX_ERROR_MESSAGE_LENGTH = 500

/** Truncate error text to the published bound, marking that it was cut. */
export function truncateErrorMessage(message: string): string {
	return message.length > MAX_ERROR_MESSAGE_LENGTH ? `${message.substring(0, MAX_ERROR_MESSAGE_LENGTH)}...` : message
}

/**
 * Event categories that can be switched off independently.
 *
 * A category is coarser than consent: it exists so a noisy feature can be
 * silenced without asking the user to withdraw reporting altogether.
 */
export type TelemetryCategory = "checkpoints" | "browser" | "focus_chain" | "subagents" | "skills" | "hooks"

export const TELEMETRY_CATEGORIES: readonly TelemetryCategory[] = [
	"checkpoints",
	"browser",
	"focus_chain",
	"subagents",
	"skills",
	"hooks",
]

/** Event names, grouped by the domain that owns them. */
export const TELEMETRY_EVENTS = {
	USER: {
		OPT_OUT: "user.opt_out",
		OPT_IN: "user.opt_in",
		TELEMETRY_ENABLED: "user.telemetry_enabled",
		EXTENSION_ACTIVATED: "user.extension_activated",
		EXTENSION_STORAGE_ERROR: "user.extension_storage_error",
		AUTH_STARTED: "user.auth_started",
		AUTH_SUCCEEDED: "user.auth_succeeded",
		AUTH_FAILED: "user.auth_failed",
		AUTH_LOGGED_OUT: "user.auth_logged_out",
		ONBOARDING_PROGRESS: "user.onboarding_progress",
	},
	// Workspace-related events for multi-root support
	WORKSPACE: {
		INITIALIZED: "workspace.initialized",
		INIT_ERROR: "workspace.init_error",
		VCS_DETECTED: "workspace.vcs_detected",
		MULTI_ROOT_CHECKPOINT: "workspace.multi_root_checkpoint",
		PATH_RESOLVED: "workspace.path_resolved",
	},
	TASK: {
		// Tracks when a new task/conversation is started
		CREATED: "task.created",
		// Tracks when a task is reopened
		RESTARTED: "task.restarted",
		// Tracks when a task is finished, with acceptance or rejection status
		COMPLETED: "task.completed",
		// Tracks user feedback on completed tasks
		FEEDBACK: "task.feedback",
		// Tracks when a message is sent in a conversation
		CONVERSATION_TURN: "task.conversation_turn",
		// Tracks token consumption for cost and usage analysis
		TOKEN_USAGE: "task.tokens",
		// Tracks switches between plan and act modes
		MODE_SWITCH: "task.mode",
		// Tracks when users select an option from AI-generated followup questions
		OPTION_SELECTED: "task.option_selected",
		// Tracks when users type a custom response instead of selecting an option
		OPTIONS_IGNORED: "task.options_ignored",
		// Tracks usage of the git-based checkpoint system
		CHECKPOINT_USED: "task.checkpoint_used",
		// Tracks when tools (like file operations, commands) are used
		TOOL_USED: "task.tool_used",
		// Tracks when MCP tools are used
		MCP_TOOL_CALLED: "task.mcp_tool_called",
		// Tracks when a historical task is loaded from storage
		HISTORICAL_LOADED: "task.historical_loaded",
		// Tracks when the retry button is clicked for failed operations
		RETRY_CLICKED: "task.retry_clicked",
		// Tracks when a diff edit (replace_in_file) operation fails
		DIFF_EDIT_FAILED: "task.diff_edit_failed",
		// Tracks when the browser tool is started
		BROWSER_TOOL_START: "task.browser_tool_start",
		// Tracks when the browser tool is completed
		BROWSER_TOOL_END: "task.browser_tool_end",
		// Tracks when browser errors occur
		BROWSER_ERROR: "task.browser_error",
		// Tracks Gemini API specific performance metrics
		GEMINI_API_PERFORMANCE: "task.gemini_api_performance",
		// Tracks when API providers return errors
		PROVIDER_API_ERROR: "task.provider_api_error",
		// Focus chain feature events
		FOCUS_CHAIN_ENABLED: "task.focus_chain_enabled",
		FOCUS_CHAIN_DISABLED: "task.focus_chain_disabled",
		FOCUS_CHAIN_PROGRESS_FIRST: "task.focus_chain_progress_first",
		FOCUS_CHAIN_PROGRESS_UPDATE: "task.focus_chain_progress_update",
		FOCUS_CHAIN_INCOMPLETE_ON_COMPLETION: "task.focus_chain_incomplete_on_completion",
		FOCUS_CHAIN_LIST_OPENED: "task.focus_chain_list_opened",
		FOCUS_CHAIN_LIST_WRITTEN: "task.focus_chain_list_written",
		// Tracks when the context window is auto-condensed with the summarize_task tool call
		AUTO_COMPACT: "task.summarize_task",
		// Tracks when slash commands or workflows are activated
		SLASH_COMMAND_USED: "task.slash_command_used",
		// Feature and rule toggles
		FEATURE_TOGGLED: "task.feature_toggled",
		RULE_TOGGLED: "task.rule_toggled",
		AUTO_CONDENSE_TOGGLED: "task.auto_condense_toggled",
		YOLO_MODE_TOGGLED: "task.yolo_mode_toggled",
		CLINE_WEB_TOOLS_TOGGLED: "task.cline_web_tools_toggled",
		// Tracks task initialization timing
		INITIALIZATION: "task.initialization",
		// Terminal execution telemetry events
		TERMINAL_EXECUTION: "task.terminal_execution",
		TERMINAL_OUTPUT_FAILURE: "task.terminal_output_failure",
		TERMINAL_USER_INTERVENTION: "task.terminal_user_intervention",
		TERMINAL_HANG: "task.terminal_hang",
		// Mention telemetry events
		MENTION_USED: "task.mention_used",
		MENTION_FAILED: "task.mention_failed",
		MENTION_SEARCH_RESULTS: "task.mention_search_results",
		// Multi-workspace search pattern tracking
		WORKSPACE_SEARCH_PATTERN: "task.workspace_search_pattern",
		// CLI Subagents telemetry events
		SUBAGENT_ENABLED: "task.subagent_enabled",
		SUBAGENT_DISABLED: "task.subagent_disabled",
		SUBAGENT_STARTED: "task.subagent_started",
		SUBAGENT_COMPLETED: "task.subagent_completed",
		// Skills telemetry events
		SKILL_USED: "task.skill_used",
		// AI output review outcomes
		AI_OUTPUT_ACCEPTED: "task.ai_output.accepted",
		AI_OUTPUT_REJECTED: "task.ai_output.rejected",
	},
	// UI interaction events for tracking user engagement
	UI: {
		MODEL_SELECTED: "ui.model_selected",
		MODEL_FAVORITE_TOGGLED: "ui.model_favorite_toggled",
		BUTTON_CLICKED: "ui.button_clicked",
		RULES_MENU_OPENED: "ui.rules_menu_opened",
	},
	// Hooks-related events for tracking hook execution
	HOOKS: {
		ENABLED: "hooks.enabled",
		DISABLED: "hooks.disabled",
		CANCEL_REQUESTED: "hooks.cancel_requested",
		CONTEXT_MODIFIED: "hooks.context_modified",
		DISCOVERY_COMPLETED: "hooks.discovery_completed",
		EXECUTION: "hooks.execution",
	},
	// Worktree-related events for tracking worktree feature usage
	WORKTREE: {
		VIEW_OPENED: "worktree.view_opened",
		CREATED: "worktree.created",
		MERGE_ATTEMPTED: "worktree.merge_attempted",
	},
	HOST: {
		DETECTED: "host.detected",
	},
} as const

/** Metric names, grouped by the domain that owns them. */
export const TELEMETRY_METRICS = {
	TASK: {
		TURNS_TOTAL: "dline.turns.total",
		TURNS_PER_TASK: "dline.turns.per_task",
		TOKENS_INPUT_TOTAL: "dline.tokens.input.total",
		TOKENS_INPUT_PER_RESPONSE: "dline.tokens.input.per_response",
		TOKENS_OUTPUT_TOTAL: "dline.tokens.output.total",
		TOKENS_OUTPUT_PER_RESPONSE: "dline.tokens.output.per_response",
		TOKENS_TOTAL: "dline.tokens.total",
		COST_TOTAL: "dline.cost.total",
		COST_PER_EVENT: "dline.cost.per_event",
	},
	CACHE: {
		WRITE_TOTAL: "dline.cache.write.tokens.total",
		WRITE_PER_EVENT: "dline.cache.write.tokens.per_event",
		READ_TOTAL: "dline.cache.read.tokens.total",
		READ_PER_EVENT: "dline.cache.read.tokens.per_event",
		INPUT_TOTAL: "dline.cache.input.tokens.total",
		HIT_RATE_PERCENT: "dline.cache.hit_rate.percent",
		HITS_TOTAL: "dline.cache.hits.total",
	},
	TOOLS: {
		CALLS_TOTAL: "dline.tool.calls.total",
		CALLS_PER_TASK: "dline.tool.calls.per_task",
	},
	// Pool measurements are attributed by a `pool` label rather than split into
	// separate metric names, so one dashboard query compares the tool pool with
	// the subagent pool and a saturation incident names the limit to lower.
	//
	// Occupancy, queue depth and the limit are gauges sampled at admission and
	// release. The queue wait is the only duration here; it is deliberately a
	// separate histogram from `tool.execution`, whose buckets describe tool work
	// rather than time spent waiting for a slot.
	POOLS: {
		QUEUE_WAIT_SECONDS: "dline.pool.queue_wait.seconds",
		RUNNING: "dline.pool.running",
		QUEUED: "dline.pool.queued",
		LIMIT: "dline.pool.limit",
		STARVED_INSTANCES: "dline.pool.starved_instances",
	},
	// Fan-out width is recorded as a value, never as a label: a batch may carry
	// up to MAX_SUBAGENTS_PER_BATCH items, and a per-width time series would add
	// one series per distinct batch size.
	SUBAGENT_FANOUT: {
		BATCH_ITEMS: "dline.subagent.fanout.items",
		EXPLICIT_PROFILE_ITEMS: "dline.subagent.fanout.explicit_profile_items",
	},
	ERRORS: {
		TOTAL: "dline.errors.total",
		PER_TASK: "dline.errors.per_task",
	},
	API: {
		REQUESTS_TOTAL: "dline.api.requests.total",
		TTFT_SECONDS: "dline.api.ttft.seconds",
		DURATION_SECONDS: "dline.api.duration.seconds",
		THROUGHPUT_TOKENS_PER_SECOND: "dline.api.throughput.tokens_per_second",
	},
	HOOKS: {
		EXECUTIONS_TOTAL: "dline.hooks.executions.total",
		DURATION_SECONDS: "dline.hooks.duration.seconds",
		FAILURES_TOTAL: "dline.hooks.failures.total",
		CANCELLATIONS_TOTAL: "dline.hooks.cancellations.total",
		CONTEXT_MODIFICATIONS_TOTAL: "dline.hooks.context_modifications.total",
		CACHE_ACCESSES_TOTAL: "dline.hooks.cache.accesses.total",
	},
	AI_OUTPUT: {
		ACCEPTED_LINES_ADDED: "dline.ai_output.accepted.lines_added.total",
		ACCEPTED_LINES_DELETED: "dline.ai_output.accepted.lines_deleted.total",
		ACCEPTED_LINES_CHANGED: "dline.ai_output.accepted.lines_changed.total",
		ACCEPTED_FILES_CREATED: "dline.ai_output.accepted.files_created.total",
		ACCEPTED_FILES_DELETED: "dline.ai_output.accepted.files_deleted.total",
		ACCEPTED_FILES_MOVED: "dline.ai_output.accepted.files_moved.total",
		REJECTED_LINES_ADDED: "dline.ai_output.rejected.lines_added.total",
		REJECTED_LINES_DELETED: "dline.ai_output.rejected.lines_deleted.total",
		REJECTED_LINES_CHANGED: "dline.ai_output.rejected.lines_changed.total",
		REJECTED_FILES_CREATED: "dline.ai_output.rejected.files_created.total",
		REJECTED_FILES_DELETED: "dline.ai_output.rejected.files_deleted.total",
		REJECTED_FILES_MOVED: "dline.ai_output.rejected.files_moved.total",
	},
	GRPC: {
		RESPONSE_SIZE_BYTES: "dline.grpc.response.size_bytes",
	},
	WORKSPACE: {
		ACTIVE_ROOTS: "dline.workspace.active_roots",
	},
} as const
