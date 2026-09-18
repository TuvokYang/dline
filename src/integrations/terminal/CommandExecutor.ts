/**
 * CommandExecutor - Unified command execution for all terminal modes.
 *
 * This class handles command execution for both VSCode terminal mode and
 * standalone/CLI mode. It uses the shared CommandOrchestrator for the
 * common orchestration logic (buffering, user interaction, result formatting).
 *
 * The differentiation between modes happens at the TerminalManager level:
 * - VscodeTerminalManager → VscodeTerminalProcess (shell integration)
 * - StandaloneTerminalManager → StandaloneTerminalProcess (child_process)
 *
 * IMPORTANT: Background execution mode uses StandaloneTerminalManager to run
 * commands in hidden terminals without cluttering the visible terminal.
 */

import { randomUUID } from "node:crypto"
import { DlineRuntimeFileManager } from "@services/runtime-files"
import { findLastIndex } from "@shared/array"
import { DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS } from "@shared/terminal-settings"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import { recordDiagnostic } from "@/services/telemetry/instrumentation/diagnostic-recorder"
import { markPerfPhase, recordPerfPhase, startPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import { isCommandCompletionSuccessful } from "./command-completion"
import { appendCommandLogPath } from "./command-result"
import { formatTerminalOutput } from "./output-stream"
import {
	buildShellEnvironmentCommand,
	buildTerminalInitializationCommand,
	logShellEnvironmentDiagnostics,
	type ResolvedShellEnvironment,
	ShellEnvironmentConfigLoader,
} from "./shell-environment"
import { StandaloneTerminalManager } from "./standalone/StandaloneTerminalManager"
import type {
	BackgroundCommand,
	CommandCancellationOwner,
	CommandCancellationResult,
	CommandExecutionOptions,
	CommandExecutionOutcome,
	CommandExecutorCallbacks,
	CommandExecutorConfig,
	ITerminalManager,
	ShellIntegrationWarningTracker,
	TerminalLaunchConfiguration,
	TerminalManagerConfiguration,
	TerminalManagerConfigurationResult,
	TerminalOutputLine,
	TerminalProcessResultPromise,
} from "./types"

/**
 * Why a workspace root could not be prewarmed.
 *
 * Bounded so it can be a metric dimension. The workspace path and the
 * underlying error message are both unbounded and stay in the log line.
 */
type PrewarmFailureReason =
	/** The shell environment for this root could not be resolved. */
	| "environment_unresolved"
	/** The directory belongs to no workspace root, so there is nothing to warm. */
	| "no_launch_configuration"
	/** The pool was asked to warm and refused or threw. */
	| "ensure_warm_failed"

/**
 * CommandExecutor - Unified command executor for all terminal modes.
 *
 * Uses the shared CommandOrchestrator for common logic and delegates
 * process management to the appropriate TerminalManager.
 */
export class CommandExecutor {
	private cwd: string
	private taskId: string
	private ulid: string
	private terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	private terminalManager: ITerminalManager
	private standaloneManager: StandaloneTerminalManager
	private callbacks: CommandExecutorCallbacks
	private terminalConfiguration: TerminalManagerConfiguration
	private hasAppliedInitialConfiguration = false
	private readonly shellEnvironmentLoader: ShellEnvironmentConfigLoader
	private readonly workspaceRoots: readonly string[]

	// Track the currently executing foreground process for cancellation
	private currentProcess: TerminalProcessResultPromise | null = null
	private readonly processes = new Map<string, TerminalProcessResultPromise>()
	private readonly activityIdsByFunctionId = new Map<string, string>()
	private readonly functionIdsByActivityId = new Map<string, string>()
	private readonly commandsByActivityId = new Map<string, string>()
	private readonly commandMessageTimestamps = new Map<string, number>()
	private readonly cancellationOwners = new Map<string, CommandCancellationOwner>()
	private readonly cancelledActivityIds = new Set<string>()
	private readonly pendingHandoffs = new Map<string, { promise: Promise<void>; resolve: () => void }>()
	private readyBackgroundHandoffActivityId: string | undefined
	private requestedBackgroundHandoffActivityId: string | undefined

	private readonly handoffSeconds: number

	private nextActivityNumber = 1
	private nextShellEnvironmentDiagnosticsNumber = 1

	/**
	 * Whether this executor created its own standalone manager.
	 *
	 * A reused manager belongs to the Task, which disposes it on its own schedule.
	 * Only a manager created here may be torn down by {@link dispose}.
	 */
	private readonly ownsStandaloneManager: boolean

	// Track shell integration warnings to determine when to show background terminal suggestion
	private shellIntegrationWarningTracker: ShellIntegrationWarningTracker = {
		timestamps: [],
		lastSuggestionShown: undefined,
	}

	constructor(config: CommandExecutorConfig, callbacks: CommandExecutorCallbacks) {
		this.cwd = config.cwd
		this.taskId = config.taskId
		this.ulid = config.ulid
		this.terminalExecutionMode = config.terminalExecutionMode
		this.handoffSeconds = config.terminalCommandHandoffSeconds ?? DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS
		this.terminalManager = config.terminalManager
		this.callbacks = callbacks
		this.terminalConfiguration = config.terminalConfiguration
		this.workspaceRoots = config.workspaceRoots ?? [config.cwd]
		this.shellEnvironmentLoader = new ShellEnvironmentConfigLoader({
			workspaceRoots: this.workspaceRoots,
		})

		// When in backgroundExec mode, the terminalManager is already a StandaloneTerminalManager
		// created by Task. We should reuse it so that Task.getEnvironmentDetails() can see
		// the terminals and processes we create (for isHot logic, busy terminals, etc.)
		if (config.terminalExecutionMode === "backgroundExec" && config.terminalManager instanceof StandaloneTerminalManager) {
			// Reuse the same instance that Task is using
			this.standaloneManager = config.terminalManager
			this.ownsStandaloneManager = false
			Logger.info(`[CommandExecutor] Reusing Task's StandaloneTerminalManager for backgroundExec mode`)
		} else {
			// Create a standalone manager for background execution support.
			this.standaloneManager = new StandaloneTerminalManager(config.windowsProcessTreeProvider)
			this.ownsStandaloneManager = true
			Logger.info(`[CommandExecutor] Created new StandaloneTerminalManager`)
		}
		this.configure(config.terminalConfiguration)
	}

	/** Apply one complete configuration to every unique terminal manager owned by this executor. */
	configure(configuration: TerminalManagerConfiguration): TerminalManagerConfigurationResult {
		this.terminalConfiguration = configuration
		let closedCount = 0
		const busyTerminals = []
		for (const manager of new Set<ITerminalManager>([this.terminalManager, this.standaloneManager])) {
			const result = manager.configure(configuration)
			closedCount += result.closedCount
			busyTerminals.push(...result.busyTerminals)
		}
		const shouldPrewarm = this.hasAppliedInitialConfiguration
		this.hasAppliedInitialConfiguration = true
		if (shouldPrewarm && this.terminalExecutionMode === "vscodeTerminal") void this.prewarmWorkspaceRoots()
		return { closedCount, busyTerminals }
	}

	/** Close idle terminals so profile startup scripts run again on the next command. */
	reinitializeTerminals(): TerminalManagerConfigurationResult {
		let closedCount = 0
		const busyTerminals = []
		for (const manager of new Set<ITerminalManager>([this.terminalManager, this.standaloneManager])) {
			const result = manager.reinitializeTerminals?.()
			if (!result) continue
			closedCount += result.closedCount
			busyTerminals.push(...result.busyTerminals)
		}
		if (this.terminalExecutionMode === "vscodeTerminal") void this.prewarmWorkspaceRoots()
		return { closedCount, busyTerminals }
	}

	/**
	 * Execute a command in the terminal.
	 *
	 * Routing logic:
	 * 1. Background mode commands use StandaloneTerminalManager
	 * 2. Regular commands use the configured terminal manager
	 *
	 * @param command The command to execute
	 * @param timeoutSeconds Optional timeout in seconds
	 * @returns Structured execution outcome with completion metadata
	 */
	async execute(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<CommandExecutionOutcome> {
		const workdirectory = options?.workdirectory ?? this.cwd
		const activityId = `command_${options?.commandTs ?? Date.now()}_${this.nextActivityNumber++}`
		const executeStartedAt = performance.now()
		// Strip leading `cd` to workspace from command
		const workspaceCdPrefix = `cd ${workdirectory} && `
		if (command.startsWith(workspaceCdPrefix)) {
			command = command.substring(workspaceCdPrefix.length)
		}

		// Select the appropriate terminal manager
		const useStandalone =
			options?.startInBackground || options?.useBackgroundExecution || this.terminalExecutionMode === "backgroundExec"
		// The mode marker must reflect execution semantics, not just the terminal mechanism:
		// - explicit background and headless execution are detached work → "background"
		// - synchronous requests stay in the foreground loop even when the global
		//   terminal mode routes execution through the standalone manager → "foreground"
		const executionMode: "foreground" | "background" =
			options?.startInBackground || options?.useBackgroundExecution
				? "background"
				: options?.synchronous
					? "foreground"
					: useStandalone
						? "background"
						: "foreground"
		const manager = useStandalone ? this.standaloneManager : this.terminalManager
		const terminalMode = useStandalone ? "standalone" : "vscode"
		markPerfPhase(PerfDomain.Terminal, "execute_start", { activityId, terminalMode }, { taskId: this.taskId })
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[TerminalPerf] phase=execute_start taskId=${this.taskId} activityId=${activityId} terminalMode=${terminalMode}`,
			)
		}
		this.callbacks.markWorkspaceScanRequired?.()

		// Get terminal and run command
		let shellEnvironment: ResolvedShellEnvironment | undefined
		let shellEnvironmentLoadFailed = false
		try {
			shellEnvironment = await this.shellEnvironmentLoader.resolve(
				workdirectory,
				this.terminalConfiguration.defaultTerminalProfile,
			)
		} catch (error) {
			shellEnvironmentLoadFailed = true
			Logger.error("[ShellEnvironment] Failed to load project terminal configuration; continuing without it", error)
		}
		const hasShellCommands = Boolean(
			shellEnvironment &&
				(shellEnvironment.startupScripts.length > 0 ||
					shellEnvironment.preCommands.length > 0 ||
					shellEnvironment.postCommand),
		)
		const diagnosticsPath = hasShellCommands
			? DlineRuntimeFileManager.createTempFilePath(
					`shell_environment_${this.ulid}_${Date.now()}_${this.nextShellEnvironmentDiagnosticsNumber++}`,
				)
			: undefined
		const profile = this.terminalConfiguration.defaultTerminalProfile
		const executionCommand =
			shellEnvironment && diagnosticsPath
				? buildShellEnvironmentCommand({
						command,
						startupScripts: useStandalone ? shellEnvironment.startupScripts : undefined,
						preCommands: shellEnvironment.preCommands,
						postCommand: shellEnvironment.postCommand,
						profile,
						diagnosticsPath,
						terminateShell: useStandalone,
						completionMarkerToken: useStandalone ? undefined : randomUUID(),
					})
				: command
		const launchConfiguration = useStandalone
			? shellEnvironment
				? {
						environment: shellEnvironment.environment,
						configurationId: shellEnvironment.configurationId,
					}
				: undefined
			: shellEnvironmentLoadFailed
				? undefined
				: this.createVscodeLaunchConfiguration(workdirectory, shellEnvironment)
		// Only bounded dimensions are reported. `activityId` and `terminalId`
		// are identities and are stripped before export, and `elapsedMs` is an
		// unbounded numeric that would become a Prometheus label; measuring
		// from the handle covers the acquisition itself, which is what the
		// histogram is for.
		const acquirePhase = startPerfPhase(PerfDomain.Terminal, "terminal_acquired", { terminalMode }, { taskId: this.taskId })
		const terminalAcquireStartedAt = performance.now()
		const terminalInfo = await manager.getOrCreateTerminal(workdirectory, launchConfiguration)
		// A warm hit and a cold start differ by seconds. Without this dimension
		// the two collapse into one distribution, and a pool that stopped
		// serving hits would be indistinguishable from one that still does.
		const acquisitionSource = terminalInfo.acquisitionSource ?? "unknown"
		acquirePhase.stop({ terminalMode, acquisitionSource })
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[TerminalPerf] phase=terminal_acquired taskId=${this.taskId} activityId=${activityId} terminalId=${terminalInfo.id} source=${acquisitionSource} durationMs=${Math.round(performance.now() - terminalAcquireStartedAt)} elapsedMs=${Math.round(performance.now() - executeStartedAt)}`,
			)
		}
		if (options?.startInBackground) {
			terminalInfo.terminal.hide()
		} else {
			terminalInfo.terminal.show()
		}
		const process = manager.runCommand(terminalInfo, executionCommand)
		if (diagnosticsPath) {
			let diagnosticsLogged = false
			const logDiagnostics = () => {
				if (diagnosticsLogged) return
				diagnosticsLogged = true
				void logShellEnvironmentDiagnostics(diagnosticsPath)
			}
			process.once("completed", logDiagnostics)
			process.once("error", logDiagnostics)
		}
		terminalInfo.lastCommand = command
		const cancellationOwner: CommandCancellationOwner = options?.startInBackground ? "explicit" : "task"
		// Synchronous foreground commands stay in the foreground loop; the UI can
		// request a manual move to background once the handoff wait has elapsed.
		let handoffRequest: { promise: Promise<void>; resolve: () => void } | undefined
		if (options?.synchronous) {
			let resolveHandoff!: () => void
			const promise = new Promise<void>((resolve) => {
				resolveHandoff = resolve
			})
			handoffRequest = { promise, resolve: resolveHandoff }
			this.pendingHandoffs.set(activityId, handoffRequest)
		}
		let activityLineCount = 0
		let timedOut = false
		this.processes.set(activityId, process)
		this.commandsByActivityId.set(activityId, command)
		if (options?.functionId) {
			this.activityIdsByFunctionId.set(options.functionId, activityId)
			this.functionIdsByActivityId.set(activityId, options.functionId)
		}
		this.cancellationOwners.set(activityId, cancellationOwner)
		if (options?.commandTs) {
			this.commandMessageTimestamps.set(activityId, options.commandTs)
		}
		// Everything from here to the terminal-status listeners must stay
		// synchronous.
		//
		// The command is already running by this point. Process completion is
		// delivered as an event, and an EventEmitter does not replay events to
		// listeners attached later, so any `await` before those listeners exist
		// is a window in which a fast command can finish unobserved. The
		// activity would then be created in its default running state and never
		// be told otherwise, which is exactly the activity that sits in the
		// panel claiming to run long after its command ended.
		this.callbacks.createCommandActivity?.({
			activityId,
			command,
			timeoutSeconds,
			executionMode,
			cancellationOwner,
			cancel: async () => {
				await this.cancelCommand(activityId)
			},
		})

		// Track the current foreground process until completion or background handoff.
		this.currentProcess = process
		const clearCurrentProcess = () => {
			if (this.currentProcess === process) this.currentProcess = null
			this.processes.delete(activityId)
			this.pendingHandoffs.delete(activityId)
			this.clearBackgroundHandoffState(activityId)
			const functionId = this.functionIdsByActivityId.get(activityId)
			if (functionId) {
				this.functionIdsByActivityId.delete(activityId)
				this.activityIdsByFunctionId.delete(functionId)
			}
			this.cancellationOwners.delete(activityId)
			this.commandsByActivityId.delete(activityId)
			this.commandMessageTimestamps.delete(activityId)
		}
		process.once("completed", clearCurrentProcess)
		process.once("error", clearCurrentProcess)
		process.once("completed", (details) => {
			const cancelled = this.cancelledActivityIds.has(activityId)
			const failed = !isCommandCompletionSuccessful(details)
			const outcome = cancelled ? "cancelled" : timedOut ? "timeout" : failed ? "failed_or_unverified" : "completed"
			recordPerfPhase(
				PerfDomain.Terminal,
				"execute_complete",
				performance.now() - executeStartedAt,
				{ activityId, terminalId: terminalInfo.id, outcome },
				{ taskId: this.taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[TerminalPerf] phase=execute_complete taskId=${this.taskId} activityId=${activityId} terminalId=${terminalInfo.id} durationMs=${Math.round(performance.now() - executeStartedAt)} outcome=${outcome}`,
				)
			}
			this.callbacks.updateCommandActivity?.(activityId, {
				status: cancelled ? "cancelled" : timedOut ? "timeout" : failed ? "failed" : "completed",
				latestEvent: cancelled
					? "Cancelled by user"
					: timedOut
						? "Command timed out"
						: failed
							? "Command failed"
							: "Command completed",
				error: cancelled
					? undefined
					: details?.signal
						? `Terminated by ${details.signal}`
						: typeof details?.exitCode !== "number"
							? "Command completion could not be verified because no exit code was reported"
							: undefined,
				lineCount: activityLineCount,
			})
			if (cancelled) void this.markCommandMessageCancelled(activityId)
		})
		process.once("error", (error: Error) => {
			const cancelled = this.cancelledActivityIds.has(activityId)
			const outcome = cancelled ? "cancelled" : timedOut ? "timeout" : "error"
			recordPerfPhase(
				PerfDomain.Terminal,
				"execute_error",
				performance.now() - executeStartedAt,
				{ activityId, terminalId: terminalInfo.id, outcome },
				{ taskId: this.taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[TerminalPerf] phase=execute_error taskId=${this.taskId} activityId=${activityId} terminalId=${terminalInfo.id} durationMs=${Math.round(performance.now() - executeStartedAt)} outcome=${outcome}`,
				)
			}
			this.callbacks.updateCommandActivity?.(activityId, {
				status: cancelled ? "cancelled" : timedOut ? "timeout" : "failed",
				latestEvent: cancelled ? "Cancelled by user" : timedOut ? "Command timed out" : "Command failed",
				error: cancelled ? undefined : error.message,
				lineCount: activityLineCount,
			})
			if (cancelled) void this.markCommandMessageCancelled(activityId)
		})

		// Use shared orchestration logic
		// The StandaloneTerminalManager handles background command tracking internally
		let backgroundCommand: BackgroundCommand | undefined
		/**
		 * Publish one owned log file so foreground and background commands expose the same
		 * clickable path in the Activity monitor and in the chat command row.
		 */
		const publishCommandLogPath = (logFilePath: string) => {
			this.callbacks.updateCommandActivity?.(activityId, { logPath: logFilePath })
			if (!options?.commandTs) return
			const messages = this.callbacks.getClineMessages() as Array<{ ts?: number }>
			const commandIndex = messages.findIndex((message) => message.ts === options.commandTs)
			if (commandIndex !== -1) {
				void this.callbacks.updateClineMessage(commandIndex, { logPath: logFilePath })
			}
		}
		const markTimedOut = () => {
			timedOut = true
			this.callbacks.updateCommandActivity?.(activityId, {
				status: "timeout",
				latestEvent: "Command timed out",
				lineCount: activityLineCount,
			})
		}
		const execution = orchestrateCommandExecution(process, manager, this.callbacks, {
			activityId,
			isCancellationRequested: () => this.cancelledActivityIds.has(activityId),
			command,
			timeoutSeconds,
			synchronous: options?.synchronous,
			handoffSeconds: this.handoffSeconds,
			handoffRequest,
			onHandoffAvailable: () => {
				if (!this.pendingHandoffs.has(activityId)) return
				this.readyBackgroundHandoffActivityId = activityId
				this.requestedBackgroundHandoffActivityId = undefined
				this.callbacks.onHandoffAvailabilityChanged?.()
			},
			onTimeout: markTimedOut,
			onLogFileCreated: (logFilePath) => publishCommandLogPath(logFilePath),
			suppressUserInteraction: options?.suppressUserInteraction,
			commandTs: options?.commandTs,
			onOutputFrame: async (frame) => {
				activityLineCount += frame.length
				this.callbacks.appendCommandActivityOutput?.(activityId, `${frame.map((entry) => entry.line).join("\n")}\n`)
				const latestLine = [...frame].reverse().find((entry) => entry.line.trim())?.line
				this.callbacks.updateCommandActivity?.(activityId, {
					latestEvent: latestLine?.trim() || "Command produced output",
					lineCount: activityLineCount,
				})
			},
			// When "Proceed While Running" is triggered, track the command in the manager
			// Returns the log file path so the orchestrator can send it to the UI
			// existingOutput contains all output lines captured so far
			onProceedWhileRunning: (existingOutput: TerminalOutputLine[], timing: { startedAt: number; deadlineAt?: number }) => {
				if (backgroundCommand) {
					return {
						backgroundCommandId: backgroundCommand.id,
						logFilePath: backgroundCommand.logFilePath,
					}
				}
				try {
					backgroundCommand = this.standaloneManager.trackBackgroundCommand(
						process,
						command,
						activityId,
						existingOutput,
						{
							origin: options?.startInBackground ? "explicit_background" : "foreground",
							cancellationOwner: "explicit",
							functionId: options?.functionId,
							taskId: this.taskId,
							...timing,
						},
						{
							onOutputFrame: async (frame) => {
								activityLineCount += frame.length
								this.callbacks.appendCommandActivityOutput?.(
									activityId,
									`${frame.map((entry) => entry.line).join("\n")}\n`,
								)
								const latestLine = [...frame].reverse().find((entry) => entry.line.trim())?.line
								this.callbacks.updateCommandActivity?.(activityId, {
									latestEvent: latestLine?.trim() || "Command produced output",
									lineCount: activityLineCount,
								})
							},
							onError: (error) => {
								this.callbacks.updateCommandActivity?.(activityId, {
									status: "failed",
									latestEvent: "Failed to persist command output",
									error: error.message,
									lineCount: activityLineCount,
								})
							},
							onTimeout: () => {
								markTimedOut()
							},
							onLogFileCreated: (logFilePath) => publishCommandLogPath(logFilePath),
						},
					)
				} catch (error) {
					this.clearBackgroundHandoffState(activityId)
					throw error
				}
				// A successful handoff detaches the command from the foreground Task
				// lifecycle while preserving explicit command/activity cancellation.
				this.cancellationOwners.set(activityId, "explicit")
				this.callbacks.updateCommandActivity?.(activityId, {
					cancellationOwner: "explicit",
					executionMode: "background",
					latestEvent: "Continuing in background",
					lineCount: activityLineCount,
					logPath: backgroundCommand.logFilePath,
				})
				if (options?.commandTs) {
					const messages = this.callbacks.getClineMessages() as Array<{ ts?: number }>
					const commandIndex = messages.findIndex((message) => message.ts === options.commandTs)
					if (commandIndex !== -1) {
						void this.callbacks.updateClineMessage(commandIndex, { commandExecutionMode: "background" })
					}
				}
				this.clearBackgroundHandoffState(activityId)
				return {
					backgroundCommandId: backgroundCommand.id,
					logFilePath: backgroundCommand.logFilePath,
				}
			},
			startInBackground: options?.startInBackground,
			showShellIntegrationSuggestion: this.shouldShowBackgroundTerminalSuggestion(),
			terminalType: useStandalone ? "standalone" : "vscode",
		})

		// Link presentation only after orchestration owns the terminal completion.
		// A fast command can finish while this Webview-facing update is pending.
		if (options?.commandTs) {
			const messages = this.callbacks.getClineMessages() as Array<{ ts?: number }>
			const commandIndex = messages.findIndex((message) => message.ts === options.commandTs)
			if (commandIndex !== -1) {
				await this.callbacks.updateClineMessage(commandIndex, {
					activityId,
					commandExecutionMode: executionMode,
				})
			}
		}

		let result: Awaited<typeof execution>
		try {
			result = await execution
		} catch (error) {
			if (this.cancelledActivityIds.delete(activityId)) {
				await this.markCommandMessageCancelled(activityId)
				this.callbacks.updateCommandActivity?.(activityId, {
					status: "cancelled",
					latestEvent: "Cancelled by user",
					error: undefined,
					lineCount: activityLineCount,
				})
				clearCurrentProcess()
				return {
					userRejected: true,
					result: "Command was cancelled by the user.",
					completed: false,
				}
			}
			clearCurrentProcess()
			const message = error instanceof Error ? error.message : String(error)
			this.callbacks.updateCommandActivity?.(activityId, {
				status: "failed",
				latestEvent: "Command failed",
				error: message,
				lineCount: activityLineCount,
			})
			throw error
		}

		if (result.logFilePath && options?.commandTs) {
			const messages = this.callbacks.getClineMessages() as Array<{ ts?: number }>
			const commandIndex = messages.findIndex((message) => message.ts === options.commandTs)
			if (commandIndex !== -1) {
				await this.callbacks.updateClineMessage(commandIndex, { logPath: result.logFilePath })
			}
		}

		// If the command was cancelled externally (via cancel button), return a clear cancellation message
		// This ensures the AI agent knows the command was cancelled by the user
		if (this.cancelledActivityIds.delete(activityId)) {
			const separatedOutput = formatTerminalOutput(result.outputEntries, (lines) => manager.processOutput(lines))
			const outputSoFar = separatedOutput ? `\nOutput captured before cancellation:\n${separatedOutput}` : ""
			return {
				userRejected: true,
				result: appendCommandLogPath(`Command was cancelled by the user.${outputSoFar}`, result.logFilePath),
				completed: false,
				logFilePath: result.logFilePath,
				exitCode: result.exitCode,
				signal: result.signal,
			}
		}

		return result
	}

	/**
	 * Fill the warm pool for every workspace root, and report how that went.
	 *
	 * A prewarm that silently stops leaves no trace: commands simply start
	 * paying a cold start again, which reads as the terminal being slow rather
	 * than as the pool being empty. Each root is reported separately because
	 * one failing root does not stop the others, and an aggregate would hide
	 * the one that did fail.
	 */
	private async prewarmWorkspaceRoots(): Promise<void> {
		await Promise.allSettled(this.workspaceRoots.map((workspaceRoot) => this.prewarmWorkspaceRoot(workspaceRoot)))
	}

	private async prewarmWorkspaceRoot(workspaceRoot: string): Promise<void> {
		const startedAt = performance.now()
		// Bounded on purpose. The workspace path and the error text are both
		// unbounded and would become Prometheus labels; the reason is what
		// separates a configuration fault from a pool that refused to warm.
		const reportFailure = (reason: PrewarmFailureReason, error?: unknown): void => {
			recordPerfPhase(
				PerfDomain.TerminalPool,
				"prewarm_failed",
				performance.now() - startedAt,
				{ reason },
				{ taskId: this.taskId },
			)
			recordDiagnostic(DiagnosticDomain.Terminal, "prewarm_failed", DiagnosticOutcome.Degraded, { reason })
			if (error !== undefined) {
				Logger.error(`[ShellEnvironment] Failed to prewarm terminal warm pool: reason=${reason}`, error)
			}
		}

		let shellEnvironment: ResolvedShellEnvironment | undefined
		try {
			shellEnvironment = await this.shellEnvironmentLoader.resolve(
				workspaceRoot,
				this.terminalConfiguration.defaultTerminalProfile,
			)
		} catch (error) {
			reportFailure("environment_unresolved", error)
			return
		}

		const launchConfiguration = this.createVscodeLaunchConfiguration(workspaceRoot, shellEnvironment)
		if (!launchConfiguration) {
			// Not an error path: a directory outside every workspace root has
			// nothing to warm. It is still reported, because a pool that warms
			// nothing at all looks identical to one that was never asked.
			reportFailure("no_launch_configuration")
			return
		}

		try {
			await this.terminalManager.ensureWarm?.(workspaceRoot, launchConfiguration)
		} catch (error) {
			reportFailure("ensure_warm_failed", error)
		}
	}

	private createVscodeLaunchConfiguration(
		workdirectory: string,
		shellEnvironment: ResolvedShellEnvironment | undefined,
	): TerminalLaunchConfiguration | undefined {
		const workspaceRoot = shellEnvironment?.workspaceRoot ?? this.shellEnvironmentLoader.resolveWorkspaceRoot(workdirectory)
		if (!workspaceRoot) return undefined
		const profileId = this.terminalConfiguration.defaultTerminalProfile
		const createInitialization =
			shellEnvironment && shellEnvironment.startupScripts.length > 0
				? () => {
						const diagnosticsPath = DlineRuntimeFileManager.createTempFilePath(
							`shell_environment_${this.ulid}_${Date.now()}_${this.nextShellEnvironmentDiagnosticsNumber++}`,
						)
						const command = buildTerminalInitializationCommand(
							shellEnvironment.startupScripts,
							profileId,
							diagnosticsPath,
						)
						return { command, diagnosticsPath: command ? diagnosticsPath : undefined }
					}
				: undefined
		const initialInitialization = createInitialization?.()
		return {
			environment: shellEnvironment?.environment,
			configurationId: shellEnvironment?.configurationId,
			workspaceRoot,
			profileId,
			environmentFingerprint: shellEnvironment?.configurationId ?? "default",
			createInitialization,
			initializationCommand: initialInitialization?.command,
			initializationDiagnosticsPath: initialInitialization?.diagnosticsPath,
		}
	}

	/** Cancel exactly one command by its stable activity identity. */
	/**
	 * Move a synchronous foreground command to background tracking on request.
	 * Returns false when the activity is not awaiting a manual handoff.
	 */
	async requestBackgroundHandoff(activityId: string): Promise<boolean> {
		const pending = this.pendingHandoffs.get(activityId)
		if (!pending || this.readyBackgroundHandoffActivityId !== activityId) return false
		this.pendingHandoffs.delete(activityId)
		this.requestedBackgroundHandoffActivityId = activityId
		this.callbacks.onHandoffAvailabilityChanged?.()
		pending.resolve()
		return true
	}

	/** Return the exact foreground command currently eligible for manual background handoff. */
	getReadyBackgroundHandoffActivityId(): string | undefined {
		return this.readyBackgroundHandoffActivityId
	}

	/** Return whether the eligible handoff has been accepted and is transitioning. */
	isBackgroundHandoffRequested(activityId: string): boolean {
		return this.requestedBackgroundHandoffActivityId === activityId
	}

	/** Clear one command's projected handoff action after completion, failure, or successful handoff. */
	private clearBackgroundHandoffState(activityId: string): void {
		let changed = false
		if (this.readyBackgroundHandoffActivityId === activityId) {
			this.readyBackgroundHandoffActivityId = undefined
			changed = true
		}
		if (this.requestedBackgroundHandoffActivityId === activityId) {
			this.requestedBackgroundHandoffActivityId = undefined
			changed = true
		}
		if (changed) this.callbacks.onHandoffAvailabilityChanged?.()
	}

	async cancelCommand(activityId: string): Promise<boolean> {
		const process = this.processes.get(activityId)
		if (!process?.terminate || !this.markCancellationRequested(activityId)) return false
		const commandTs = this.commandMessageTimestamps.get(activityId)
		const background = this.standaloneManager.getBackgroundCommand(activityId)
		if (background?.status === "running") {
			if (await this.standaloneManager.cancelBackgroundCommand(activityId)) {
				await this.markCommandMessageCancelled(activityId, commandTs)
				return true
			}
			this.cancelledActivityIds.delete(activityId)
			return false
		}
		await Promise.all([this.markCommandMessageCancelled(activityId), Promise.resolve(process.terminate())])
		return true
	}

	/** Cancel one running command by the canonical execute_command function identity. */
	async cancelCommandByFunctionId(functionId: string): Promise<CommandCancellationResult> {
		const activityId = this.activityIdsByFunctionId.get(functionId)
		if (!activityId) return { cancelled: false }
		const command = this.commandsByActivityId.get(activityId)
		return {
			cancelled: await this.cancelCommand(activityId),
			activityId,
			command,
		}
	}

	/** Persist the canonical command cancellation terminal state before process teardown can race it. */
	private async markCommandMessageCancelled(
		activityId: string,
		commandTs = this.commandMessageTimestamps.get(activityId),
	): Promise<void> {
		if (commandTs === undefined) return
		const messages = this.callbacks.getClineMessages() as Array<{ ts?: number }>
		const commandIndex = messages.findIndex((message) => message.ts === commandTs)
		if (commandIndex === -1) return
		try {
			await this.callbacks.updateClineMessage(commandIndex, { commandStatus: "cancelled" })
		} catch (error) {
			Logger.warn(`[CommandExecutor] Failed to persist cancelled command state for ${activityId}`, error)
		}
	}

	/** Mark one cancellation request exactly once across every command control surface. */
	private markCancellationRequested(activityId: string): boolean {
		if (this.cancelledActivityIds.has(activityId)) return false
		this.cancelledActivityIds.add(activityId)
		this.pendingHandoffs.delete(activityId)
		this.clearBackgroundHandoffState(activityId)
		this.callbacks.updateCommandActivity?.(activityId, {
			status: "cancelling",
			latestEvent: "Cancellation requested",
		})
		return true
	}

	/**
	 * Cancel all running commands (both foreground and background).
	 *
	 * This method cancels:
	 * 1. All detached background commands (those that were "proceeded while running")
	 * 2. The current foreground process (if one is actively running)
	 *
	 * @returns true if any commands were cancelled, false otherwise
	 */
	async cancelBackgroundCommand(): Promise<boolean> {
		return this.cancelCommands()
	}

	/** Cancel only foreground work owned by the Task lifecycle. */
	async cancelTaskOwnedCommands(): Promise<boolean> {
		return this.cancelCommands("task")
	}

	/** Cancel commands matching one lifecycle owner, or all commands for explicit user cancellation. */
	private async cancelCommands(cancellationOwner?: CommandCancellationOwner): Promise<boolean> {
		let cancelled = false

		// 1. Cancel detached background commands owned by this lifecycle.
		// The manager may be shared with other tasks, so the task identity is part
		// of the scope: cancelling this task must never terminate another task's work.
		const runningCommands = this.standaloneManager.getRunningBackgroundCommands({
			cancellationOwner,
			taskId: this.taskId,
		})
		const detachedActivityIds = new Set<string>()
		for (const cmd of runningCommands) {
			if (!this.markCancellationRequested(cmd.id)) continue
			const commandTs = this.commandMessageTimestamps.get(cmd.id)
			if (await this.standaloneManager.cancelBackgroundCommand(cmd.id)) {
				await this.markCommandMessageCancelled(cmd.id, commandTs)
				detachedActivityIds.add(cmd.id)
				cancelled = true
				// The command line is user content; only its identity is logged.
				Logger.info(`Cancelled background command: activityId=${cmd.id}`)
			} else {
				this.cancelledActivityIds.delete(cmd.id)
			}
		}

		// 2. Cancel the current foreground process when it was not already terminated as detached work.
		const currentActivity = [...this.processes.entries()].find(([, process]) => process === this.currentProcess)
		const currentOwner = currentActivity ? this.cancellationOwners.get(currentActivity[0]) : undefined
		if (currentActivity && detachedActivityIds.has(currentActivity[0])) {
			this.currentProcess = null
		} else if (currentActivity && (!cancellationOwner || currentOwner === cancellationOwner)) {
			if (await this.cancelCommand(currentActivity[0])) {
				this.currentProcess = null
				cancelled = true
				Logger.info("Cancelled foreground command")
			}
		}

		// 3. Update UI state and notify user by modifying existing message
		// We modify the previous command_output message instead of sending a new say()
		// to avoid interfering with any pending ask() dialogs (which would cause
		// "Current ask promise was ignored" errors)
		if (cancelled) {
			this.callbacks.updateBackgroundCommandState(false)

			// Wait for terminal buffers to flush before updating the message
			// This prevents the cancellation notice from appearing in the middle of output
			await new Promise((resolve) => setTimeout(resolve, 300))

			// Find the last command_output message and update it
			const messages = this.callbacks.getClineMessages()
			const lastCommandOutputIndex = findLastIndex(messages, (m) => m.ask === "command_output")
			if (lastCommandOutputIndex !== -1) {
				const existingText = messages[lastCommandOutputIndex].text || ""
				const cancellationNotice = "\n\nCommand(s) cancelled by user."
				await this.callbacks.updateClineMessage(lastCommandOutputIndex, {
					text: existingText + cancellationNotice,
				})
			}
		}

		return cancelled
	}

	/**
	 * Release every resource this executor owns.
	 *
	 * The Task disposes the manager it created itself, so only a manager created
	 * here is torn down. Without this call a `vscodeTerminal` executor would leave
	 * its own standalone manager, and therefore any child process it spawned,
	 * unreachable but alive for the remaining lifetime of the extension host.
	 */
	async dispose(): Promise<void> {
		this.processes.clear()
		this.activityIdsByFunctionId.clear()
		this.functionIdsByActivityId.clear()
		this.commandsByActivityId.clear()
		this.commandMessageTimestamps.clear()
		this.cancellationOwners.clear()
		this.cancelledActivityIds.clear()
		for (const handoff of this.pendingHandoffs.values()) handoff.resolve()
		this.pendingHandoffs.clear()
		this.currentProcess = null

		if (!this.ownsStandaloneManager) return
		try {
			await this.standaloneManager.disposeAsync()
		} catch (error) {
			Logger.error("[CommandExecutor] Failed to dispose standalone terminal manager:", error)
		}
	}

	/** Return whether any active command is owned by the Task lifecycle. */
	hasTaskOwnedCommand(): boolean {
		const taskOwned = this.standaloneManager.getRunningBackgroundCommands({
			cancellationOwner: "task",
			taskId: this.taskId,
		})
		if (taskOwned.length > 0) return true
		const currentActivity = [...this.processes.entries()].find(([, process]) => process === this.currentProcess)
		return Boolean(currentActivity && this.cancellationOwners.get(currentActivity[0]) === "task")
	}

	/**
	 * Check if there are any active background commands.
	 * Delegates to StandaloneTerminalManager.
	 */
	hasActiveBackgroundCommand(): boolean {
		return this.standaloneManager.hasActiveBackgroundCommands()
	}

	/**
	 * Get a summary of background commands for environment details.
	 * Delegates to StandaloneTerminalManager which tracks multiple commands.
	 */
	getBackgroundCommandSummary(): string | undefined {
		const summary = this.standaloneManager.getBackgroundCommandsSummary()
		return summary || undefined
	}

	/**
	 * List task-local background commands for environment details injection.
	 * @returns All background commands tracked by the standalone manager.
	 */
	listBackgroundCommands(): BackgroundCommand[] {
		return this.standaloneManager.getAllBackgroundCommands()
	}

	/** Read output retained in memory or in the lazily-created background log. */
	readBackgroundCommandOutput(command: BackgroundCommand): Promise<string> {
		return this.standaloneManager.readBackgroundCommandOutput(command.id)
	}

	/**
	 * Mark background commands as injected into model context.
	 * @param ids Background command identifiers.
	 */
	markBackgroundCommandsInjected(ids: string[]): void {
		this.standaloneManager.markBackgroundCommandsInjected(ids)
	}

	/**
	 * Mark background commands as consumed by a sent model request.
	 * @param ids Background command identifiers.
	 */
	markBackgroundCommandsConsumed(ids: string[]): void {
		this.standaloneManager.markBackgroundCommandsConsumed(ids)
	}

	/** Advance output baselines after their Environment metadata reaches the model. */
	markBackgroundCommandOutputSent(snapshots: readonly { id: string; lineCount: number }[]): void {
		this.standaloneManager.markBackgroundCommandOutputSent(snapshots)
	}

	/**
	 * Determines whether to show the background terminal suggestion.
	 * Shows suggestion if there have been 3+ shell integration warnings in the last hour,
	 * and we haven't shown the suggestion in the last hour.
	 *
	 * @returns true if the suggestion should be shown, false otherwise
	 */
	private shouldShowBackgroundTerminalSuggestion(): boolean {
		const oneHourAgo = Date.now() - 60 * 60 * 1000

		// Clean old timestamps (older than 1 hour)
		this.shellIntegrationWarningTracker.timestamps = this.shellIntegrationWarningTracker.timestamps.filter(
			(ts) => ts > oneHourAgo,
		)

		// Add current warning
		this.shellIntegrationWarningTracker.timestamps.push(Date.now())

		// Check if we've shown suggestion recently (within last hour)
		if (
			this.shellIntegrationWarningTracker.lastSuggestionShown &&
			Date.now() - this.shellIntegrationWarningTracker.lastSuggestionShown < 60 * 60 * 1000
		) {
			return false
		}

		// Show suggestion if 3+ warnings in last hour
		if (this.shellIntegrationWarningTracker.timestamps.length >= 3) {
			this.shellIntegrationWarningTracker.lastSuggestionShown = Date.now()
			return true
		}

		return false
	}
}
