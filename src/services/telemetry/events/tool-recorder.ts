import type { BrowserSettings } from "@shared/BrowserSettings"
import type { TelemetrySignalSink } from "../service/signal-sink"
import { MAX_ERROR_MESSAGE_LENGTH, TELEMETRY_EVENTS, TELEMETRY_METRICS } from "./catalog"
import { DomainRecorder } from "./domain-recorder"
import type { TaskAggregates } from "./task-aggregates"

/**
 * Terminal type for telemetry differentiation
 */
export type TerminalType = "vscode" | "standalone"

/**
 * Which bounded pool a measurement describes.
 *
 * A closed union rather than a free string: this value becomes a metric label,
 * so an open vocabulary would let a new call site add time series without
 * review. The two pools are deliberately separate at runtime, and this label is
 * what keeps them comparable in one query.
 */
export type ExecutionPool = "tool" | "subagent"

/**
 * VSCode-specific output capture methods
 */
export type VscodeOutputMethod = "shell_integration" | "clipboard" | "none"

/**
 * Standalone-specific output capture methods
 */
export type StandaloneOutputMethod = "child_process" | "child_process_error"

/**
 * Combined type for terminal output methods
 */
export type TerminalOutputMethod = VscodeOutputMethod | StandaloneOutputMethod

/**
 * Enum for terminal output failure reasons
 */
export enum TerminalOutputFailureReason {
	TIMEOUT = "timeout",
	NO_SHELL_INTEGRATION = "no_shell_integration",
	CLIPBOARD_FAILED = "clipboard_failed",
}

/**
 * Enum for terminal user intervention actions
 */
export enum TerminalUserInterventionAction {
	PROCESS_WHILE_RUNNING = "process_while_running",
	MANUAL_PASTE = "manual_paste",
	CANCELLED = "cancelled",
}

/**
 * Enum for terminal hang stages
 */
export enum TerminalHangStage {
	WAITING_FOR_COMPLETION = "waiting_for_completion",
	BUFFER_STUCK = "buffer_stuck",
	STREAM_TIMEOUT = "stream_timeout",
}

/**
 * Tool, terminal, browser, checkpoint, and mention telemetry.
 *
 * These belong together because they all describe an action the agent took on
 * the user's machine, and they share the same privacy rule: the identity of the
 * action is recorded, never its content. `captureMcpToolCall` keeps argument
 * keys but not values for exactly this reason.
 */
export class ToolEventRecorder extends DomainRecorder {
	constructor(
		sink: TelemetrySignalSink,
		private readonly aggregates: TaskAggregates,
	) {
		super(sink)
	}

	/**
	 * Records when a tool is used during task execution
	 * @param ulid Unique identifier for the task
	 * @param tool Name of the tool being used
	 * @param modelId The model ID being used
	 * @param provider The API provider being used
	 * @param autoApproved Whether the tool was auto-approved based on settings
	 * @param success Whether the tool execution was successful
	 * @param workspaceContext Optional workspace context for multi-root workspace tracking
	 */
	captureToolUsage(
		ulid: string,
		tool: string,
		modelId: string,
		provider: string,
		autoApproved: boolean,
		success: boolean,
		workspaceContext?: {
			isMultiRootEnabled: boolean
			usedWorkspaceHint: boolean
			resolvedToNonPrimary: boolean
			resolutionMethod: "hint" | "primary_fallback" | "path_detection"
		},
		isNativeToolCall = false,
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.TOOL_USED, {
			ulid,
			tool,
			autoApproved,
			success,
			modelId,
			provider,
			// Workspace context (optional)
			...(workspaceContext && {
				workspace_multi_root_enabled: workspaceContext.isMultiRootEnabled,
				workspace_hint_used: workspaceContext.usedWorkspaceHint,
				workspace_resolved_non_primary: workspaceContext.resolvedToNonPrimary,
				workspace_resolution_method: workspaceContext.resolutionMethod,
			}),
			isNativeToolCall,
		})

		const toolAttributes = { ulid, tool, model: modelId, success, autoApproved }
		const toolCallCount = this.aggregates.nextToolCall(ulid)
		this.sink.recordCounter(TELEMETRY_METRICS.TOOLS.CALLS_TOTAL, 1, toolAttributes)
		this.sink.recordHistogram(TELEMETRY_METRICS.TOOLS.CALLS_PER_TASK, toolCallCount, toolAttributes)
	}

	captureSkillUsed(args: {
		ulid: string
		skillName: string
		skillSource: "global" | "project"
		skillsAvailableGlobal: number
		skillsAvailableProject: number
		provider?: string
		modelId?: string
	}): void {
		if (!this.sink.isCategoryEnabled("skills")) {
			return
		}

		if (!args.ulid || !args.skillName) {
			return
		}

		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.SKILL_USED, {
			ulid: args.ulid,
			skillName: args.skillName,
			skillSource: args.skillSource,
			skillsAvailableGlobal: Math.max(0, args.skillsAvailableGlobal),
			skillsAvailableProject: Math.max(0, args.skillsAvailableProject),
			provider: args.provider,
			modelId: args.modelId,
		})
	}

	/**
	 * Records when an MCP tool is called.
	 *
	 * Captures the tool's metadata (server, name, and argument keys) but never
	 * the argument values, which routinely contain user content.
	 *
	 * @param ulid Unique identifier for the task.
	 * @param serverName The name of the MCP server.
	 * @param toolName The name of the tool being called.
	 * @param status The status of the tool call.
	 * @param errorMessage Optional error message if the call failed.
	 * @param argumentKeys Optional array of argument keys for the tool.
	 */
	captureMcpToolCall(
		ulid: string,
		serverName: string,
		toolName: string,
		status: "started" | "success" | "error",
		errorMessage?: string,
		argumentKeys?: string[],
		isNativeToolCall = false,
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.MCP_TOOL_CALLED, {
			ulid,
			serverName,
			toolName,
			status,
			errorMessage,
			argumentKeys,
			isNativeToolCall,
		})
	}

	/**
	 * Records interactions with the git-based checkpoint system
	 * @param ulid Unique identifier for the task
	 * @param action The type of checkpoint action
	 * @param durationMs Optional duration of the operation in milliseconds
	 */
	captureCheckpointUsage(
		ulid: string,
		action: "shadow_git_initialized" | "commit_created" | "restored" | "diff_generated",
		durationMs?: number,
	): void {
		if (!this.sink.isCategoryEnabled("checkpoints")) {
			return
		}

		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.CHECKPOINT_USED, { ulid, action, durationMs })
	}

	/**
	 * Records when the browser tool is started
	 * @param ulid Unique identifier for the task
	 * @param browserSettings The browser settings being used
	 */
	captureBrowserToolStart(ulid: string, browserSettings: BrowserSettings): void {
		if (!this.sink.isCategoryEnabled("browser")) {
			return
		}

		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.BROWSER_TOOL_START, {
			ulid,
			viewport: browserSettings.viewport,
			isRemote: !!browserSettings.remoteBrowserEnabled,
			remoteBrowserHost: browserSettings.remoteBrowserHost,
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records when the browser tool is completed
	 * @param ulid Unique identifier for the task
	 * @param stats Statistics about the browser session
	 */
	captureBrowserToolEnd(
		ulid: string,
		stats: {
			actionCount: number
			duration: number
			actions?: string[]
		},
	): void {
		if (!this.sink.isCategoryEnabled("browser")) {
			return
		}

		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.BROWSER_TOOL_END, {
			ulid,
			actionCount: stats.actionCount,
			duration: stats.duration,
			actions: stats.actions,
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records when browser errors occur during a task
	 * @param ulid Unique identifier for the task
	 * @param errorType Type of error that occurred
	 * @param errorMessage The error message
	 * @param context Additional context about where the error occurred
	 */
	captureBrowserError(
		ulid: string,
		errorType: string,
		errorMessage: string,
		context?: {
			action?: string
			url?: string
			isRemote?: boolean
			remoteBrowserHost?: string
			endpoint?: string
		},
	): void {
		if (!this.sink.isCategoryEnabled("browser")) {
			return
		}

		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.BROWSER_ERROR, {
			ulid,
			errorType,
			errorMessage,
			...(context && { context }),
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records terminal command execution outcomes for VSCode terminal
	 * @param success Whether the command output was successfully captured
	 * @param terminalType The type of terminal ("vscode")
	 * @param method The VSCode-specific method used to capture output
	 */
	captureTerminalExecution(success: boolean, terminalType: "vscode", method: VscodeOutputMethod): void
	/**
	 * Records terminal command execution outcomes for standalone terminal
	 * @param success Whether the command output was successfully captured
	 * @param terminalType The type of terminal ("standalone")
	 * @param method The standalone-specific method used to capture output
	 * @param exitCode The process exit code (1=error, 127=not found, 126=permission denied)
	 */
	captureTerminalExecution(
		success: boolean,
		terminalType: "standalone",
		method: StandaloneOutputMethod,
		exitCode?: number | null,
	): void
	captureTerminalExecution(
		success: boolean,
		terminalType: TerminalType,
		method: TerminalOutputMethod,
		exitCode?: number | null,
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.TERMINAL_EXECUTION, {
			success,
			terminalType,
			method,
			// Only include exitCode for standalone terminals when it's a meaningful value
			...(terminalType === "standalone" && exitCode !== undefined && exitCode !== null && { exitCode }),
		})
	}

	/**
	 * Records when terminal output capture fails
	 * @param reason The reason for failure
	 * @param terminalType The type of terminal (defaults to "vscode" for backward compatibility)
	 */
	captureTerminalOutputFailure(reason: TerminalOutputFailureReason, terminalType: TerminalType = "vscode"): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.TERMINAL_OUTPUT_FAILURE, { reason, terminalType })
	}

	/**
	 * Records when user has to intervene with terminal execution
	 * @param action The user action
	 * @param terminalType The type of terminal (defaults to "vscode" for backward compatibility)
	 */
	captureTerminalUserIntervention(action: TerminalUserInterventionAction, terminalType: TerminalType = "vscode"): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.TERMINAL_USER_INTERVENTION, { action, terminalType })
	}

	/**
	 * Records when terminal execution hangs or gets stuck
	 * @param stage Where the hang occurred
	 * @param terminalType The type of terminal (defaults to "vscode" for backward compatibility)
	 */
	captureTerminalHang(stage: TerminalHangStage, terminalType: TerminalType = "vscode"): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.TERMINAL_HANG, { stage, terminalType })
	}

	/**
	 * Records when a mention is successfully used and content is retrieved
	 * @param mentionType Type of mention
	 * @param contentLength Optional length of content retrieved (for size tracking)
	 */
	captureMentionUsed(
		mentionType: "file" | "folder" | "url" | "problems" | "terminal" | "git-changes" | "commit",
		contentLength?: number,
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.MENTION_USED, {
			mentionType,
			contentLength,
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records when a mention fails to retrieve content or when the mention
	 * picker's file/folder search itself fails.
	 *
	 * `ripgrep_spawn_failed` and `workspace_unavailable` are picker-search
	 * failures, surfaced by the `searchFiles` controller; the others are
	 * mention-content retrieval failures.
	 *
	 * @param fsContext Optional filesystem info, emitted as `fs_class` and `fs_type`.
	 */
	captureMentionFailed(
		mentionType: "file" | "folder" | "url" | "problems" | "terminal" | "git-changes" | "commit",
		errorType:
			| "not_found"
			| "permission_denied"
			| "network_error"
			| "parse_error"
			| "ripgrep_spawn_failed"
			| "workspace_unavailable"
			| "unknown",
		errorMessage?: string,
		fsContext?: { fsClass?: "local" | "network" | "unknown"; fsType?: string },
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.MENTION_FAILED, {
			mentionType,
			errorType,
			errorMessage: errorMessage?.substring(0, MAX_ERROR_MESSAGE_LENGTH),
			...(fsContext?.fsClass ? { fs_class: fsContext.fsClass } : {}),
			...(fsContext?.fsType ? { fs_type: fsContext.fsType } : {}),
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records search results when user searches for files/folders in mention dropdown
	 *
	 * Only the query length is recorded, never the query itself.
	 *
	 * @param query The search query entered by user
	 * @param resultCount Number of results returned
	 * @param searchType Type of search (file, folder, or all)
	 * @param isEmpty Whether the search returned no results
	 * @param fsContext Optional filesystem info, emitted as `fs_class` and `fs_type`.
	 * @param searchSource Which backend served the search: `host_index` (e.g.
	 *   JetBrains FilenameIndex) or `ripgrep` (default everywhere).
	 */
	captureMentionSearchResults(
		query: string,
		resultCount: number,
		searchType: "file" | "folder" | "all",
		isEmpty: boolean,
		fsContext?: { fsClass?: "local" | "network" | "unknown"; fsType?: string },
		searchSource?: "host_index" | "ripgrep",
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.MENTION_SEARCH_RESULTS, {
			queryLength: query.length,
			resultCount,
			searchType,
			isEmpty,
			...(fsContext?.fsClass ? { fs_class: fsContext.fsClass } : {}),
			...(fsContext?.fsType ? { fs_type: fsContext.fsType } : {}),
			...(searchSource ? { search_source: searchSource } : {}),
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records when CLI subagents feature is enabled/disabled by the user
	 * @param enabled Whether subagents was enabled (true) or disabled (false)
	 */
	/**
	 * Record one admission outcome for a bounded execution pool.
	 *
	 * The queue wait is a histogram because it is a duration whose distribution
	 * matters; occupancy, queue depth and the limit are gauges because only
	 * their current value is meaningful. Keeping the wait out of the shared
	 * `tool.execution` histogram is deliberate: a slow tool and a saturated pool
	 * must remain distinguishable.
	 *
	 * @param args.pool Which pool was entered. A closed enumeration, so the
	 * label cannot grow a series per tool or per agent.
	 * @param args.queueWaitMs Milliseconds spent waiting for admission.
	 * @param args.running Holders admitted at the sampling point.
	 * @param args.queued Waiters still queued at the sampling point.
	 * @param args.limit Effective admission ceiling at the sampling point.
	 */
	capturePoolAdmission(args: {
		pool: ExecutionPool
		queueWaitMs: number
		running: number
		queued: number
		limit: number
	}): void {
		const attributes = { pool: args.pool }
		this.sink.recordHistogram(
			TELEMETRY_METRICS.POOLS.QUEUE_WAIT_SECONDS,
			args.queueWaitMs / 1000,
			attributes,
			"Seconds spent waiting for admission to a bounded execution pool",
		)
		this.recordPoolOccupancy(args)
	}

	/**
	 * Re-sample a pool's occupancy without recording a queue wait.
	 *
	 * Release is the other point where the numbers change, and a gauge that is
	 * only written on admission would read as permanently saturated once the
	 * last item is admitted.
	 *
	 * @param args.pool Which pool is being sampled.
	 * @param args.running Holders admitted at the sampling point.
	 * @param args.queued Waiters still queued at the sampling point.
	 * @param args.limit Effective admission ceiling at the sampling point.
	 */
	recordPoolOccupancy(args: { pool: ExecutionPool; running: number; queued: number; limit: number }): void {
		const attributes = { pool: args.pool }
		this.sink.recordGauge(TELEMETRY_METRICS.POOLS.RUNNING, args.running, attributes, "Work currently admitted to the pool")
		this.sink.recordGauge(TELEMETRY_METRICS.POOLS.QUEUED, args.queued, attributes, "Work waiting for admission to the pool")
		this.sink.recordGauge(
			TELEMETRY_METRICS.POOLS.LIMIT,
			args.limit,
			attributes,
			"Effective admission ceiling, after any withheld capacity",
		)
	}

	/**
	 * Record the shape of one subagent batch.
	 *
	 * Both figures are values, never labels: a batch may carry up to
	 * MAX_SUBAGENTS_PER_BATCH items, and a per-width label would add one time
	 * series per distinct batch size. Profile names are deliberately absent for
	 * the same reason.
	 *
	 * @param items Items the batch actually started.
	 * @param explicitProfileItems Items that named a Profile through the tool
	 * parameter, as opposed to inheriting one from YAML or the parent.
	 */
	captureSubagentFanout(items: number, explicitProfileItems: number): void {
		if (!this.sink.isCategoryEnabled("subagents")) {
			return
		}

		this.sink.recordHistogram(
			TELEMETRY_METRICS.SUBAGENT_FANOUT.BATCH_ITEMS,
			items,
			undefined,
			"Subagents started by one batch request",
		)
		this.sink.recordHistogram(
			TELEMETRY_METRICS.SUBAGENT_FANOUT.EXPLICIT_PROFILE_ITEMS,
			explicitProfileItems,
			undefined,
			"Batch items that bound an API Profile through the tool parameter",
		)
	}

	captureSubagentToggle(enabled: boolean): void {
		if (!this.sink.isCategoryEnabled("subagents")) {
			return
		}

		this.sink.captureEvent(enabled ? TELEMETRY_EVENTS.TASK.SUBAGENT_ENABLED : TELEMETRY_EVENTS.TASK.SUBAGENT_DISABLED, {
			enabled,
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records when a CLI subagent is executed
	 * @param ulid Unique identifier for the task
	 * @param durationMs Duration of the subagent execution in milliseconds
	 * @param outputLines Number of lines of output produced by the subagent
	 * @param success Whether the subagent execution was successful
	 */
	captureSubagentExecution(ulid: string, durationMs: number, outputLines: number, success: boolean): void {
		if (!this.sink.isCategoryEnabled("subagents")) {
			return
		}

		this.sink.captureEvent(success ? TELEMETRY_EVENTS.TASK.SUBAGENT_COMPLETED : TELEMETRY_EVENTS.TASK.SUBAGENT_STARTED, {
			ulid,
			durationMs,
			outputLines,
			success,
			timestamp: new Date().toISOString(),
		})
	}

	/**
	 * Records when a file edit (write_to_file, replace_in_file, apply_patch) is accepted by the user
	 * Tracks lines added, deleted, and changed for the accepted edit.
	 */
	captureAiOutputAccepted(args: AiOutputArgs): void {
		this.recordAiOutput(TELEMETRY_EVENTS.TASK.AI_OUTPUT_ACCEPTED, ACCEPTED_AI_OUTPUT_METRICS, args)
	}

	/**
	 * Records when a file edit (write_to_file, replace_in_file, apply_patch) is rejected by the user
	 * Tracks lines that would have been added, deleted, and changed.
	 */
	captureAiOutputRejected(args: AiOutputArgs): void {
		this.recordAiOutput(TELEMETRY_EVENTS.TASK.AI_OUTPUT_REJECTED, REJECTED_AI_OUTPUT_METRICS, args)
	}

	/**
	 * Accepted and rejected edits differ only in which metric family they feed,
	 * so the shape lives once here; duplicating it invited the two branches to
	 * drift as new counters were added.
	 */
	private recordAiOutput(event: string, metrics: AiOutputMetricNames, args: AiOutputArgs): void {
		this.sink.captureEvent(event, {
			ulid: args.ulid,
			tool: args.tool,
			provider: args.provider,
			model: args.model,
			source: args.source,
			linesAdded: args.linesAdded,
			linesDeleted: args.linesDeleted,
			linesChanged: args.linesChanged,
			filesCreated: args.filesCreated ?? 0,
			filesDeleted: args.filesDeleted ?? 0,
			filesMoved: args.filesMoved ?? 0,
		})

		const attrs = {
			ulid: args.ulid,
			tool: args.tool,
			provider: args.provider,
			model: args.model,
			source: args.source,
		}
		this.sink.recordCounter(metrics.linesAdded, args.linesAdded, attrs)
		this.sink.recordCounter(metrics.linesDeleted, args.linesDeleted, attrs)
		this.sink.recordCounter(metrics.linesChanged, args.linesChanged, attrs)
		if (args.filesCreated) {
			this.sink.recordCounter(metrics.filesCreated, args.filesCreated, attrs)
		}
		if (args.filesDeleted) {
			this.sink.recordCounter(metrics.filesDeleted, args.filesDeleted, attrs)
		}
		if (args.filesMoved) {
			this.sink.recordCounter(metrics.filesMoved, args.filesMoved, attrs)
		}
	}
}

/** Properties describing one reviewed AI edit. */
export interface AiOutputArgs {
	ulid: string
	tool: string
	provider?: string
	model?: string
	source: "agent" | "human"
	linesAdded: number
	linesDeleted: number
	linesChanged: number
	filesCreated?: number
	filesDeleted?: number
	filesMoved?: number
}

interface AiOutputMetricNames {
	readonly linesAdded: string
	readonly linesDeleted: string
	readonly linesChanged: string
	readonly filesCreated: string
	readonly filesDeleted: string
	readonly filesMoved: string
}

const ACCEPTED_AI_OUTPUT_METRICS: AiOutputMetricNames = {
	linesAdded: TELEMETRY_METRICS.AI_OUTPUT.ACCEPTED_LINES_ADDED,
	linesDeleted: TELEMETRY_METRICS.AI_OUTPUT.ACCEPTED_LINES_DELETED,
	linesChanged: TELEMETRY_METRICS.AI_OUTPUT.ACCEPTED_LINES_CHANGED,
	filesCreated: TELEMETRY_METRICS.AI_OUTPUT.ACCEPTED_FILES_CREATED,
	filesDeleted: TELEMETRY_METRICS.AI_OUTPUT.ACCEPTED_FILES_DELETED,
	filesMoved: TELEMETRY_METRICS.AI_OUTPUT.ACCEPTED_FILES_MOVED,
}

const REJECTED_AI_OUTPUT_METRICS: AiOutputMetricNames = {
	linesAdded: TELEMETRY_METRICS.AI_OUTPUT.REJECTED_LINES_ADDED,
	linesDeleted: TELEMETRY_METRICS.AI_OUTPUT.REJECTED_LINES_DELETED,
	linesChanged: TELEMETRY_METRICS.AI_OUTPUT.REJECTED_LINES_CHANGED,
	filesCreated: TELEMETRY_METRICS.AI_OUTPUT.REJECTED_FILES_CREATED,
	filesDeleted: TELEMETRY_METRICS.AI_OUTPUT.REJECTED_FILES_DELETED,
	filesMoved: TELEMETRY_METRICS.AI_OUTPUT.REJECTED_FILES_MOVED,
}
