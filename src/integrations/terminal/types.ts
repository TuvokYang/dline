/**
 * Shared terminal types and interfaces for both VSCode and Standalone terminal managers.
 * These types ensure compatibility between the VSCode-based TerminalManager and
 * the StandaloneTerminalManager used in CLI/JetBrains environments.
 */

import type { CommandExecutionMode, CommandStatus, SubagentInjectionState } from "@shared/ExtensionMessage"
import type { ClineToolResponseContent } from "@shared/messages"
import type { EventEmitter } from "events"
import type { WindowsProcessTreeProvider } from "./process-tree"

// =============================================================================
// Terminal Process Types
// =============================================================================

/**
 * Event types for terminal process
 */
export interface TerminalCompletionDetails {
	/** Process exit code when available */
	exitCode?: number | null
	/** Termination signal when available */
	signal?: NodeJS.Signals | null
}

export type TerminalOutputStream = "stdout" | "stderr" | "combined"

export interface TerminalOutputLine {
	line: string
	stream: TerminalOutputStream
}

export interface TerminalProcessEvents {
	line: [line: string, stream: TerminalOutputStream]
	continue: []
	completed: [details?: TerminalCompletionDetails]
	error: [error: Error]
	no_shell_integration: []
}

/**
 * Interface for terminal process implementations.
 * Both VscodeTerminalProcess and StandaloneTerminalProcess implement this interface.
 *
 * Events emitted:
 * - 'line': Emitted for each line of output
 * - 'completed': Emitted when the process completes
 * - 'continue': Emitted when continue() is called
 * - 'error': Emitted on process errors
 * - 'no_shell_integration': Emitted when shell integration is not available (VSCode only)
 */
export interface ITerminalProcess extends EventEmitter<TerminalProcessEvents> {
	/** Resolves with the wall-clock time at which the command process was actually launched. */
	readonly started?: Promise<number>

	/**
	 * Whether the process is actively outputting (used to stall API requests)
	 */
	isHot: boolean

	/**
	 * Whether to wait for shell integration before running commands.
	 * VSCode processes may need to wait, standalone processes don't.
	 */
	waitForShellIntegration: boolean

	/**
	 * Continue execution without waiting for completion.
	 * Stops event emission and resolves the promise.
	 * This is called when user clicks "Proceed While Running".
	 */
	continue(): void

	/** Pause terminal output production when the shared frame buffer reaches its high-water mark. */
	pauseOutput?(): void

	/** Resume terminal output production after the shared frame buffer drains below its low-water mark. */
	resumeOutput?(): void

	/**
	 * Get output that hasn't been retrieved yet.
	 * @returns The unretrieved output
	 */
	getUnretrievedOutput(): string

	/**
	 * Get completion metadata for the most recent command execution.
	 */
	getCompletionDetails?(): TerminalCompletionDetails

	/**
	 * Terminate the process if it's still running.
	 * Only available for standalone processes (child_process).
	 * VSCode terminal processes cannot be terminated via this interface.
	 *
	 * May be async to allow for graceful shutdown with SIGKILL fallback.
	 */
	terminate?(): void | Promise<void>
}

// =============================================================================
// Terminal Types
// =============================================================================

/**
 * Represents a terminal instance with its metadata and state.
 */
export interface TerminalInfo {
	/** Unique identifier for the terminal */
	id: number
	/** The underlying terminal instance */
	terminal: ITerminal
	/** Whether the terminal is currently executing a command */
	busy: boolean
	/** The last command executed in this terminal */
	lastCommand: string
	/** The shell path used by this terminal (e.g., /bin/bash, /bin/zsh) */
	shellPath?: string
	/** Identity of the project shell environment used when this terminal was created. */
	configurationId?: string
	/** Timestamp of last activity */
	lastActive: number
	/** Pending CWD change path (used for tracking directory changes) */
	pendingCwdChange?: string
	/** Promise resolver for CWD change completion */
	cwdResolved?: { resolve: () => void; reject: (err: Error) => void }
	/**
	 * Where this terminal came from, as a bounded telemetry dimension.
	 *
	 * A warm hit and a cold start differ by seconds, so an acquisition metric
	 * that cannot separate them reports a meaningless average. Set by the
	 * manager when it hands the terminal out; absent for terminals created
	 * before the distinction existed.
	 */
	acquisitionSource?: TerminalAcquisitionSource
}

/** How a terminal handed to a command was obtained. */
export type TerminalAcquisitionSource =
	/** Leased from the warm pool, so the shell was already running. */
	| "warm_pool"
	/** Reused from the registry without the pool being involved. */
	| "registry_reuse"
	/** Created on demand, paying the full shell start cost. */
	| "cold_start"

/** Complete runtime configuration applied atomically to a terminal manager. */
export interface TerminalManagerConfiguration {
	readonly shellIntegrationTimeout: number
	readonly terminalReuseEnabled: boolean
	readonly terminalOutputLineLimit: number
	readonly defaultTerminalProfile: string
}

/** Observable effects caused by applying terminal configuration. */
export interface TerminalManagerConfigurationResult {
	closedCount: number
	busyTerminals: Array<Pick<TerminalInfo, "id" | "lastCommand">>
}

/**
 * Minimal terminal interface that both VSCode terminals and standalone terminals implement.
 */
export interface ITerminal {
	/** Terminal name */
	name: string
	/** Promise that resolves to the process ID */
	processId: Promise<number | undefined>
	/** Shell integration information (if available) */
	shellIntegration?: {
		cwd?: { fsPath: string }
		executeCommand?: (command: string) => {
			read: () => AsyncIterable<string>
		}
	}
	/** Send text to the terminal */
	sendText(text: string, addNewLine?: boolean): void
	/** Show the terminal */
	show(): void
	/** Hide the terminal */
	hide(): void
	/** Dispose of the terminal */
	dispose(): void
}

/**
 * Terminal process result interface.
 * @deprecated Use ITerminalProcess instead.
 * This is kept for backwards compatibility.
 */
export type ITerminalProcessResult = ITerminalProcess

/**
 * Promise-like interface for terminal process results.
 * Combines Promise<void> with ITerminalProcess for flexible usage.
 * This allows the process to be awaited while also providing access to events.
 */
export type TerminalProcessResultPromise = Promise<void> &
	ITerminalProcess & {
		/** Listen for line output events */
		on(event: "line", listener: (line: string) => void): TerminalProcessResultPromise
		/** Listen for completion event */
		on(event: "completed", listener: (details?: TerminalCompletionDetails) => void): TerminalProcessResultPromise
		/** Listen for continue event */
		on(event: "continue", listener: () => void): TerminalProcessResultPromise
		/** Listen for error events */
		on(event: "error", listener: (error: Error) => void): TerminalProcessResultPromise
		/** Listen for no shell integration event */
		on(event: "no_shell_integration", listener: () => void): TerminalProcessResultPromise
		/** Listen once for any event */
		once(event: string, listener: (...args: any[]) => void): TerminalProcessResultPromise
	}

/**
 * Interface for terminal managers (both VSCode and Standalone implementations).
 * Defines the contract that both implementations must follow.
 */
export interface ITerminalManager {
	/**
	 * Run a command in the specified terminal.
	 * @param terminalInfo The terminal to run the command in
	 * @param command The command to execute
	 * @returns A promise-like object that emits events and resolves on completion
	 */
	runCommand(terminalInfo: TerminalInfo, command: string): TerminalProcessResultPromise

	/**
	 * Get or create a terminal for the specified working directory.
	 * @param cwd The working directory for the terminal
	 * @returns The terminal info for an available terminal
	 */
	getOrCreateTerminal(cwd: string, launchConfiguration?: TerminalLaunchConfiguration): Promise<TerminalInfo>

	/** Non-blockingly establish the configured standby watermark when supported. */
	ensureWarm?(cwd: string, launchConfiguration?: TerminalLaunchConfiguration): Promise<void>

	/**
	 * Get terminals filtered by busy state.
	 * @param busy Whether to get busy or idle terminals
	 * @returns Array of terminal info with id and last command
	 */
	getTerminals(busy: boolean): { id: number; lastCommand: string }[]

	/**
	 * Get output that hasn't been retrieved yet from a terminal.
	 * @param terminalId The terminal ID
	 * @returns The unretrieved output string
	 */
	getUnretrievedOutput(terminalId: number): string

	/**
	 * Check if a terminal's process is actively outputting.
	 * @param terminalId The terminal ID
	 * @returns Whether the process is hot
	 */
	isProcessHot(terminalId: number): boolean

	/**
	 * Dispose of all terminals and clean up resources.
	 */
	disposeAll(): void

	/** Apply one complete runtime configuration snapshot. */
	configure(configuration: TerminalManagerConfiguration): TerminalManagerConfigurationResult

	/** Close idle terminals so profile startup can run again; busy terminals are preserved. */
	reinitializeTerminals?(): TerminalManagerConfigurationResult

	/** Return the currently applied immutable configuration snapshot. */
	getConfiguration(): TerminalManagerConfiguration

	/**
	 * Process output lines, potentially truncating if over limit.
	 * @param outputLines Array of output lines
	 * @param overrideLimit Optional limit override
	 * @returns Processed output string
	 */
	processOutput(outputLines: string[], overrideLimit?: number): string
}

/**
 * Options for creating a standalone terminal.
 */
export interface StandaloneTerminalOptions {
	/** Terminal name */
	name?: string
	/** Working directory */
	cwd?: string
	/** Shell path to use */
	shellPath?: string
	/** Environment overrides applied to every child process created for this terminal. */
	environment?: Readonly<Record<string, string | null>>
	/** Identity of the project shell environment used by this terminal. */
	configurationId?: string
}

export interface TerminalLaunchConfiguration {
	readonly environment?: Readonly<Record<string, string | null>>
	readonly configurationId?: string
	/** Workspace boundary used to isolate reusable VS Code terminal partitions. */
	readonly workspaceRoot?: string
	/** Selected terminal profile identity used by the warm pool partition. */
	readonly profileId?: string
	/** Stable fingerprint of Dline-managed environment overrides. */
	readonly environmentFingerprint?: string
	/** Create terminal-specific initialization artifacts for concurrent warm slots. */
	readonly createInitialization?: () => {
		readonly command?: string
		readonly diagnosticsPath?: string
	}
	/** Hidden command used to initialize a newly-created persistent terminal. */
	readonly initializationCommand?: string
	/** Internal diagnostics file populated only when terminal initialization fails. */
	readonly initializationDiagnosticsPath?: string
}

// =============================================================================
// Background Command Types
// =============================================================================

/**
 * Represents a command running in the background after user clicked "Proceed While Running".
 * Used by StandaloneTerminalManager to track background commands.
 */
export type CommandOrigin = "explicit_background" | "foreground"

export type CommandCancellationOwner = "explicit" | "task"

/** Ownership filter for selecting background commands across a shared manager. */
export interface BackgroundCommandScope {
	/** Restrict to commands cancellable by this lifecycle boundary. */
	cancellationOwner?: CommandCancellationOwner
	/** Restrict to commands started by this task. */
	taskId?: string
}

export interface BackgroundCommand {
	/** Unique identifier for the background command */
	id: string
	/** Canonical function identity of the execute_command tool call. */
	functionId?: string
	/**
	 * Task that owns this command.
	 *
	 * A manager instance can be shared by more than one executor, so owner alone
	 * does not identify whose lifecycle a command belongs to. An entry without
	 * this identity belongs to no task and is therefore never selected by a
	 * task-scoped query.
	 */
	taskId?: string
	/** The command string being executed */
	command: string
	/** Timestamp when the command started */
	startTime: number
	/** Absolute command kill deadline retained across foreground/background handoff. */
	deadlineAt?: number
	/** Current status of the command */
	status: "running" | "completed" | "error" | "timed_out" | "cancelled"
	/** How the command entered background execution. */
	origin: CommandOrigin
	/** Lifecycle boundary allowed to cancel this command. */
	cancellationOwner: CommandCancellationOwner
	/** Path to the activity-owned log file. Always present for tracked background commands. */
	logFilePath?: string
	/** Number of output lines captured in the log. */
	lineCount: number
	/** Output line count represented in the most recent successful API request. */
	lastApiSentLineCount?: number
	/** Exit code if the command completed or errored */
	exitCode?: number
	/** Context injection lifecycle state for background command visibility */
	injectionState?: SubagentInjectionState
	/**
	 * The terminal process running the command.
	 *
	 * Present while the command can still produce output or be cancelled. Once the
	 * command reaches a terminal status the manager drops this reference, because
	 * the tracking entry outlives the command for reporting purposes and would
	 * otherwise pin the child process and its captured output for the whole task.
	 */
	process?: TerminalProcessResultPromise
}

// =============================================================================
// Command Executor Types
// =============================================================================

/**
 * Tracker for shell integration warnings to determine when to show background terminal suggestion.
 * Used internally by CommandExecutor to track warning frequency.
 */
export interface ShellIntegrationWarningTracker {
	/** Timestamps of recent shell integration warnings */
	timestamps: number[]
	/** Timestamp when the suggestion was last shown */
	lastSuggestionShown?: number
}

/**
 * Represents an active background command that can be cancelled
 * @deprecated Use BackgroundCommand instead
 */
export interface ActiveBackgroundCommand {
	process: {
		terminate?: () => void
		continue?: () => void
	}
	command: string
	outputLines: string[]
}

/**
 * Response from an ask() call
 */
export interface AskResponse {
	response: string // "yesButtonClicked" | "noButtonClicked" | "messageResponse"
	text?: string
	images?: string[]
	files?: string[]
}

/**
 * Callbacks for CommandExecutor to interact with Task state
 * These are bound methods from the Task class that allow CommandExecutor
 * to update UI and state without owning that state directly.
 */
export interface CommandExecutorCallbacks {
	/** Display a message in the chat UI (non-blocking) */
	say: (
		type: string,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		existingTs?: number,
		commandTs?: number,
	) => Promise<number | undefined>
	/**
	 * Ask the user a question and wait for response (blocking)
	 * This is used for "Proceed While Running" flow where we need to wait for user input
	 */
	ask: (type: string, text?: string, partial?: boolean, options?: { commandTs?: number }) => Promise<AskResponse>
	/** Resolve the currently pending ask (if any). Used to release command_output waits on terminal lifecycle transitions. */
	resolvePendingAsk?: (response: AskResponse["response"]) => void
	/** Update the background command running state in the controller */
	updateBackgroundCommandState: (running: boolean) => void
	/** Publish a full task view when the foreground handoff action becomes available or changes state. */
	onHandoffAvailabilityChanged?: () => void
	/**
	 * Update a cline message by index
	 * Supports updating commandCompleted status and/or text content
	 */
	updateClineMessage: (
		index: number,
		updates: {
			text?: string
			exitCode?: number
			commandStatus?: CommandStatus
			commandExecutionMode?: CommandExecutionMode
			logPath?: string
			activityId?: string
		},
	) => Promise<void>
	/** Get cline messages array */
	getClineMessages: () => Array<{ ask?: string; say?: string; text?: string }>
	/** Add content to user message for next API request */
	addToUserMessageContent: (content: { type: string; text: string }) => void
	/** Mark that command execution may have modified workspace files. */
	markWorkspaceScanRequired?: () => void
	/** Register a command in the task-local activity monitor. */
	createCommandActivity?: (input: {
		activityId: string
		command: string
		timeoutSeconds?: number
		executionMode: "foreground" | "background"
		cancellationOwner: CommandCancellationOwner
		cancel: () => void | Promise<void>
	}) => void
	/** Apply a lightweight activity patch without rebuilding ExtensionState. */
	updateCommandActivity?: (
		activityId: string,
		patch: {
			status?: "running" | "cancelling" | "completed" | "failed" | "timeout" | "cancelled"
			executionMode?: "foreground" | "background"
			cancellationOwner?: CommandCancellationOwner
			latestEvent?: string
			error?: string
			lineCount?: number
			logPath?: string
		},
	) => void
	/** Append one bounded command output delta to the activity monitor. */
	appendCommandActivityOutput?: (activityId: string, text: string) => void
}

/**
 * Optional per-command execution behavior overrides.
 */
export interface CommandExecutionOptions {
	/** Canonical function identity of the execute_command tool call. */
	functionId?: string
	/** Canonical directory in which the command must execute. */
	workdirectory?: string
	/**
	 * Force command execution in standalone/background terminal mode for this command.
	 * This is useful for subagent runs and headless-style execution flows.
	 */
	useBackgroundExecution?: boolean
	/** Start the command as a Dline-owned background process and return immediately. */
	startInBackground?: boolean
	/** Wait synchronously until completion or the absolute command timeout. */
	synchronous?: boolean
	/**
	 * Suppress command interaction/output UI messages (ask/say) for this command execution.
	 * Command output is still captured and returned as the tool result.
	 */
	suppressUserInteraction?: boolean
	/** ts of the command message, passed from handler to associate outputs */
	commandTs?: number
}

/** Result of cancelling the command owned by one execute_command function call. */
export interface CommandCancellationResult {
	cancelled: boolean
	activityId?: string
	command?: string
}

/**
 * Configuration for CommandExecutor
 */
export interface CommandExecutorConfig {
	/** Working directory for command execution */
	cwd: string
	/** Task ID for tracking */
	taskId: string
	/** Unique task identifier */
	ulid: string
	/** Terminal execution mode */
	terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	/** Foreground-to-background wait before automatic handoff, in seconds. Defaults to 10. */
	terminalCommandHandoffSeconds?: number
	/** The primary terminal manager (VSCode or Standalone) */
	terminalManager: ITerminalManager
	/** Workspace roots allowed to contribute project shell environment configuration. */
	workspaceRoots?: readonly string[]
	/** Terminal configuration shared by foreground and background managers. */
	terminalConfiguration: TerminalManagerConfiguration
	/** Host-owned Windows process discovery for hidden child-process commands. */
	windowsProcessTreeProvider?: WindowsProcessTreeProvider
}

/** Alias for backwards compatibility */
export type FullCommandExecutorConfig = CommandExecutorConfig

// =============================================================================
// Command Orchestrator Types
// =============================================================================

/**
 * Options for command orchestration
 */
export interface OrchestrationOptions {
	/** Stable identity shared by command activity and owned log files. */
	activityId?: string
	/** Owning task identity, used to place owned log files under the task temp storage. */
	taskId?: string
	/** Return whether this command is in the canonical cancellation transaction. */
	isCancellationRequested?: () => boolean
	/** The command being executed */
	command: string
	/** Optional timeout in seconds */
	timeoutSeconds?: number
	/** Actual process start time used to calculate one absolute deadline. */
	startedAt?: number
	/** Absolute deadline retained when foreground work is handed to the background tracker. */
	deadlineAt?: number
	/** Disable the automatic foreground-to-background handoff. */
	synchronous?: boolean
	/** Foreground-to-background wait before automatic handoff, in seconds. Defaults to 10. */
	handoffSeconds?: number
	/** Called once the handoff wait elapsed while a synchronous command stays in the foreground. */
	onHandoffAvailable?: () => void
	/** External request to move the running command to background; resolve() triggers the handoff. */
	handoffRequest?: { promise: Promise<void>; resolve: () => void }
	/** Called once when the absolute command deadline is reached. */
	onTimeout?: () => void
	/** Called once when this command starts retaining its complete output in an owned log file. */
	onLogFileCreated?: (logFilePath: string) => void
	/** Callback to project one coalesced output frame. */
	onOutputFrame?: (frame: readonly TerminalOutputLine[]) => void | Promise<void>
	/** @deprecated Use onOutputFrame for bounded runtime work. */
	onOutputLine?: (line: string, stream: TerminalOutputStream) => void
	/** Whether to show shell integration warning with suggestion */
	showShellIntegrationSuggestion?: boolean
	/**
	 * Callback invoked when user clicks "Proceed While Running".
	 * Used to start background command tracking in the terminal manager.
	 * @param existingOutput The output lines captured so far (to write to log file)
	 * @returns The log file path if tracking was started, undefined otherwise
	 */
	onProceedWhileRunning?: (
		existingOutput: TerminalOutputLine[],
		context: {
			startedAt: number
			deadlineAt?: number
			existingLogFilePath?: string
			existingLineCount?: number
		},
	) =>
		| { backgroundCommandId: string; logFilePath?: string }
		| undefined
		| Promise<{ backgroundCommandId: string; logFilePath?: string } | undefined>
	/** Start in background without waiting for timeout or user intervention. */
	startInBackground?: boolean
	/**
	 * The type of terminal being used for telemetry tracking.
	 * Defaults to "vscode" for backward compatibility.
	 */
	terminalType?: "vscode" | "standalone"
	/**
	 * If true, suppresses command-output ask/say UI interactions.
	 * Output is still collected and included in the final result.
	 */
	suppressUserInteraction?: boolean
	/** ts of the command message, passed from handler to associate outputs */
	commandTs?: number
}

/**
 * Result of command orchestration
 */
export interface CommandExecutionOutcome {
	/** Whether execution was rejected or cancelled by the user. */
	userRejected: boolean
	/** Tool result returned to the model. */
	result: ClineToolResponseContent
	/** Whether the command reached a terminal completion event. */
	completed: boolean
	/** Whether execution ended because the absolute command deadline was reached. */
	timedOut?: boolean
	/** Process exit code when available. */
	exitCode?: number | null
	/** Process termination signal when available. */
	signal?: NodeJS.Signals | null
	/** Stable background command identifier when execution was detached. */
	backgroundCommandId?: string
	/** Background log path when available. */
	logFilePath?: string
}

export interface OrchestrationResult extends CommandExecutionOutcome {
	/** Captured output with stream identity in observable arrival order. */
	outputEntries: TerminalOutputLine[]
	/** All output lines captured in display order. */
	outputLines: string[]
	/** Output captured from the child process stdout pipe. */
	stdoutLines: string[]
	/** Output captured from the child process stderr pipe. */
	stderrLines: string[]
	/** Output whose source cannot be separated by the terminal API. */
	combinedOutputLines: string[]
	/** Path to log file if output was too large and written to file */
	logFilePath?: string
}
