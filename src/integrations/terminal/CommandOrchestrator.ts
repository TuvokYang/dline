/**
 * CommandOrchestrator - Shared command execution orchestration logic.
 *
 * This module contains the common orchestration logic for command execution
 * that is shared between VSCode and Standalone terminal modes. It handles:
 * - Output buffering and chunking
 * - User interaction (ask/say callbacks)
 * - "Proceed While Running" behavior
 * - Timeout handling
 * - Result formatting
 *
 * The actual process spawning/management is handled by the TerminalProcess
 * implementations (VscodeTerminalProcess, StandaloneTerminalProcess).
 */

import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { DlineRuntimeFileManager } from "@services/runtime-files"
import { TerminalHangStage, telemetryService } from "@services/telemetry"
import * as fs from "fs"
import { formatCommandLogNotice, formatLargeOutputLogNotice } from "@/shared/command-log-notice"
import { Logger } from "@/shared/services/Logger"
import { isCommandCompletionSuccessful } from "./command-completion"
import { appendCommandLogPath } from "./command-result"
import { COMPLETION_TIMEOUT_MS, DEFAULT_TERMINAL_OUTPUT_LINE_LIMIT, MAX_BYTES_BEFORE_FILE } from "./constants"
import { formatTerminalOutput, splitTerminalOutput, writeTerminalOutputFrame } from "./output-stream"
import { TerminalOutputFrameScheduler } from "./TerminalOutputFrameScheduler"
import type {
	CommandExecutorCallbacks,
	ITerminalManager,
	OrchestrationOptions,
	OrchestrationResult,
	TerminalCompletionDetails,
	TerminalOutputLine,
	TerminalOutputStream,
	TerminalProcessResultPromise,
} from "./types"

/**
 * Orchestrate command execution with shared logic for buffering, user interaction, and result formatting.
 *
 * @param process The terminal process (implements ITerminalProcess)
 * @param terminalManager The terminal manager (for processOutput)
 * @param callbacks The executor callbacks for UI interaction
 * @param options Orchestration options
 * @returns The orchestration result
 */
export async function orchestrateCommandExecution(
	process: TerminalProcessResultPromise,
	terminalManager: ITerminalManager,
	callbacks: CommandExecutorCallbacks,
	options: OrchestrationOptions,
): Promise<OrchestrationResult> {
	const {
		timeoutSeconds,
		startedAt: configuredStartedAt,
		deadlineAt: configuredDeadlineAt,
		synchronous = false,
		handoffSeconds = 10,
		onHandoffAvailable,
		handoffRequest,
		onTimeout,
		onOutputFrame,
		onOutputLine,
		showShellIntegrationSuggestion,
		onLogFileCreated,
		onProceedWhileRunning,
		startInBackground = false,
		terminalType = "vscode",
		suppressUserInteraction = false,
		activityId,
	} = options

	const say = async (
		type: Parameters<CommandExecutorCallbacks["say"]>[0],
		text?: Parameters<CommandExecutorCallbacks["say"]>[1],
		images?: Parameters<CommandExecutorCallbacks["say"]>[2],
		files?: Parameters<CommandExecutorCallbacks["say"]>[3],
		partial?: Parameters<CommandExecutorCallbacks["say"]>[4],
		existingTs?: Parameters<CommandExecutorCallbacks["say"]>[5],
		commandTs?: Parameters<CommandExecutorCallbacks["say"]>[6],
	): Promise<Awaited<ReturnType<CommandExecutorCallbacks["say"]>>> => {
		if (suppressUserInteraction) {
			return undefined
		}

		// Inject commandTs for command_output messages so the frontend can associate them
		if (type === "command_output" && cmdTs && !commandTs) {
			commandTs = cmdTs
		}
		return callbacks.say(type, text, images, files, partial, existingTs, commandTs)
	}

	const ask = async (
		type: Parameters<CommandExecutorCallbacks["ask"]>[0],
		text?: Parameters<CommandExecutorCallbacks["ask"]>[1],
		partial?: Parameters<CommandExecutorCallbacks["ask"]>[2],
		options?: Parameters<CommandExecutorCallbacks["ask"]>[3],
	): Promise<Awaited<ReturnType<CommandExecutorCallbacks["ask"]>> | undefined> => {
		if (suppressUserInteraction) {
			return undefined
		}

		// Inject commandTs for command_output messages so the frontend can associate them
		if (type === "command_output" && cmdTs && !options?.commandTs) {
			options = { ...options, commandTs: cmdTs }
		}
		return callbacks.ask(type, text, partial, options)
	}

	// Track command execution state
	callbacks.updateBackgroundCommandState(true)

	// Use commandTs from options if provided (handler passes block.ts).
	// Fall back to searching for pending command for backward compatibility.
	let cmdTs: number | undefined = options.commandTs
	const initialMessages = callbacks.getClineMessages() as Array<{ ask?: string; say?: string; ts: number }>
	if (!cmdTs) {
		for (let i = initialMessages.length - 1; i >= 0; i--) {
			if (
				(initialMessages[i] as any).commandStatus === "pending" &&
				(initialMessages[i].ask === "command" || initialMessages[i].say === "command")
			) {
				cmdTs = initialMessages[i].ts
				break
			}
		}
	}
	// Find the first pending command (by array order, FIFO) to mark it as running
	const initialCmdIndex = initialMessages.findIndex(
		(m) => (m.ask === "command" || m.say === "command") && (m as any).commandStatus === "pending",
	)
	if (initialCmdIndex !== -1) {
		await callbacks.updateClineMessage(initialCmdIndex, { commandStatus: "running" })
	}

	const clearCommandState = async (details?: TerminalCompletionDetails, didError = false) => {
		callbacks.updateBackgroundCommandState(false)

		// Do not overwrite any canonical cancellation terminal state.
		if (didCancelViaUi || options.isCancellationRequested?.()) {
			return
		}

		// Mark the command message as completed with exit code
		if (cmdTs) {
			const msgs = callbacks.getClineMessages() as Array<{ ts: number; commandStatus?: string }>
			const idx = msgs.findIndex((m) => m.ts === cmdTs)
			if (idx !== -1) {
				// Preserve skipped status set by the cancel branch
				if ((msgs[idx] as any).commandStatus === "skipped") {
					return
				}
				try {
					const exitCode = details?.exitCode
					const failed = didError || !isCommandCompletionSuccessful(details)
					await callbacks.updateClineMessage(idx, {
						commandStatus: failed ? "failed" : "completed",
						exitCode: exitCode ?? (didError ? -1 : undefined),
					})
				} catch (e) {
					Logger.error(`[clearCommandState] updateClineMessage failed: ${e}`)
				}
			}
		}
	}

	process.once("completed", (details) => {
		void clearCommandState(details)
	})
	process.once("error", () => {
		void clearCommandState(undefined, true)
	})
	process.catch(() => {
		void clearCommandState(undefined, true)
	})

	let userFeedback: { text?: string; images?: string[]; files?: string[] } | undefined
	// Command output is presentation state, not an interaction. Stream it from
	// the first chunk; a blocking command_output ask has no canonical response
	// and used to hold every later chunk until process completion.
	const didCancelViaUi = false
	let backgroundTrackingResult: OrchestrationResult | null = null // Set when background tracking returns early
	// Track one bounded partial presentation, updated at most once per output frame.
	let partialSayOutputTs: number | undefined
	let partialSayText = ""
	const MAX_PARTIAL_PRESENTATION_CHARS = 64 * 1024

	let completed = false
	let completionDetails: TerminalCompletionDetails | undefined
	let completionTimer: NodeJS.Timeout | null = null
	let completionWork: Promise<void> = Promise.resolve()
	let outputScheduler!: TerminalOutputFrameScheduler

	const presentPartialFrame = async (text: string): Promise<void> => {
		if (!text || suppressUserInteraction) return
		partialSayText = partialSayText ? `${partialSayText}\n${text}` : text
		if (partialSayText.length > MAX_PARTIAL_PRESENTATION_CHARS) {
			partialSayText = partialSayText.slice(-MAX_PARTIAL_PRESENTATION_CHARS)
		}
		if (partialSayOutputTs === undefined) {
			partialSayOutputTs = await say("command_output", partialSayText, undefined, undefined, true, undefined, cmdTs)
			return
		}
		await say("command_output", partialSayText, undefined, undefined, true, partialSayOutputTs)
	}

	// Large output file-based logging state
	let isWritingToFile = false
	let largeOutputLogPath: string | null = null
	let largeOutputLogStream: fs.WriteStream | null = null
	let largeOutputLogCompletion: Promise<void> | null = null
	let totalOutputBytes = 0
	let totalLineCount = 0
	const outputLineLimit = Math.max(
		1,
		terminalManager.getConfiguration?.().terminalOutputLineLimit ?? DEFAULT_TERMINAL_OUTPUT_LINE_LIMIT,
	)
	const firstLineLimit = Math.floor(outputLineLimit / 2)
	const lastLineLimit = outputLineLimit - firstLineLimit
	let firstLines: TerminalOutputLine[] = [] // Keep first N lines for summary
	let lastLines: TerminalOutputLine[] = [] // Keep last N lines for summary (circular buffer)

	let largeOutputLogError: Error | undefined

	const writeLargeOutputBatch = async (entries: readonly TerminalOutputLine[]): Promise<void> => {
		if (largeOutputLogStream) await writeTerminalOutputFrame(largeOutputLogStream, entries)
	}

	/** Switch complete-output retention to one backpressured activity-owned log. */
	const switchToFileBased = async (): Promise<void> => {
		if (isWritingToFile) return
		isWritingToFile = true
		const largeOutputStem = activityId ?? `large-output-${cmdTs ?? Date.now()}`
		largeOutputLogPath = DlineRuntimeFileManager.createTempFilePath(largeOutputStem)
		const logFd = fs.openSync(largeOutputLogPath, "w")
		largeOutputLogStream = fs.createWriteStream(largeOutputLogPath, { fd: logFd, flags: "w", autoClose: true })
		largeOutputLogCompletion = new Promise<void>((resolve) => {
			largeOutputLogStream?.once("finish", resolve)
			largeOutputLogStream?.once("error", (error) => {
				largeOutputLogError = error
				resolve()
			})
		})
		firstLines = output.slice(0, firstLineLimit)
		lastLines = lastLineLimit > 0 ? output.slice(-lastLineLimit) : []
		await writeLargeOutputBatch(output)
		onLogFileCreated?.(largeOutputLogPath)
		await presentPartialFrame(
			formatLargeOutputLogNotice({
				lineCount: totalLineCount,
				byteCount: totalOutputBytes,
				logFilePath: largeOutputLogPath,
			}),
		)
	}

	/** Close the complete-output log after every admitted frame has drained. */
	const finishFileBased = async (): Promise<void> => {
		const stream = largeOutputLogStream
		if (!stream) return
		largeOutputLogStream = null
		stream.end()
		await largeOutputLogCompletion
		if (largeOutputLogError) throw largeOutputLogError
	}

	const output: TerminalOutputLine[] = []
	const formatOutput = (entries: readonly TerminalOutputLine[]): string =>
		formatTerminalOutput(entries, (lines) => terminalManager.processOutput(lines))

	let commandTiming: { startedAt: number; deadlineAt?: number } | undefined
	type BackgroundTransitionReason = "explicit" | "automatic" | "user"
	const transitionToBackground = async (
		reason: BackgroundTransitionReason,
		drainQueuedOutput: boolean,
	): Promise<OrchestrationResult | undefined> => {
		if (!onProceedWhileRunning) {
			return undefined
		}

		process.pauseOutput?.()
		if (completionTimer) {
			clearTimeout(completionTimer)
			completionTimer = null
		}
		let trackingResult: Awaited<ReturnType<NonNullable<typeof onProceedWhileRunning>>>
		try {
			if (drainQueuedOutput) await outputScheduler.close()
			await finishFileBased()
			const timing = commandTiming ?? { startedAt: Date.now(), deadlineAt: configuredDeadlineAt }
			trackingResult = await onProceedWhileRunning(isWritingToFile ? [] : output, {
				...timing,
				existingLogFilePath: largeOutputLogPath ?? undefined,
				existingLineCount: totalLineCount,
			})
			if (!trackingResult?.backgroundCommandId) throw new Error("Background tracker did not return a command identity")
		} catch (error) {
			let terminationError: unknown
			const terminationRequested = Boolean(process.terminate)
			if (process.terminate) {
				try {
					await Promise.resolve(process.terminate())
				} catch (caughtTerminationError) {
					terminationError = caughtTerminationError
				}
			}
			await clearCommandState(undefined, true)
			const cause = error instanceof Error ? error : new Error(String(error))
			const terminationDetail = terminationError
				? ` Process termination also failed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}.`
				: terminationRequested
					? " Termination was requested to prevent an untracked process."
					: " The process cannot be terminated automatically and may still be running."
			throw new Error(`Background handoff failed.${terminationDetail}`, { cause })
		}
		const logMessage = trackingResult?.logFilePath ? `Log file: ${trackingResult.logFilePath}\n` : ""
		const resultPrefix =
			reason === "automatic"
				? `Command is still running after ${handoffSeconds} seconds and is now tracked in the background. Its final status will be available only in a later model request.`
				: "Command is running in the background. You can proceed with other tasks. Its final status will be available only in a later model request."

		backgroundTrackingResult = {
			userRejected: false,
			result: `${resultPrefix}\n${logMessage}`.trimEnd(),
			completed: false,
			...splitTerminalOutput([]),
			backgroundCommandId: trackingResult?.backgroundCommandId,
			logFilePath: trackingResult?.logFilePath,
		}

		if (trackingResult?.logFilePath) {
			await say("command_output", `\n${formatCommandLogNotice(trackingResult.logFilePath)}`)
		}

		process.resumeOutput?.()
		process.continue()
		return backgroundTrackingResult
	}

	const handleOutputFrame = async (frame: readonly TerminalOutputLine[]): Promise<void> => {
		if (didCancelViaUi || backgroundTrackingResult || frame.length === 0) return
		const frameBytes = frame.reduce((total, entry) => total + Buffer.byteLength(entry.line, "utf8"), 0)
		totalOutputBytes += frameBytes
		totalLineCount += frame.length
		if (!isWritingToFile && (output.length + frame.length > outputLineLimit || totalOutputBytes >= MAX_BYTES_BEFORE_FILE)) {
			await switchToFileBased()
		}
		if (isWritingToFile) {
			await writeLargeOutputBatch(frame)
			for (const entry of frame) {
				if (firstLines.length < firstLineLimit) firstLines.push(entry)
				lastLines.push(entry)
				if (lastLines.length > lastLineLimit) lastLines.shift()
			}
		} else {
			output.push(...frame)
		}
		await onOutputFrame?.(frame)
		if (!onOutputFrame && onOutputLine) {
			for (const entry of frame) onOutputLine(entry.line, entry.stream)
		}
		if (!isWritingToFile) await presentPartialFrame(frame.map((entry) => entry.line).join("\n"))
	}

	outputScheduler = new TerminalOutputFrameScheduler({
		sink: handleOutputFrame,
		onHighWater: () => process.pauseOutput?.(),
		onLowWater: () => process.resumeOutput?.(),
	})
	process.on("line", (line: string, stream: TerminalOutputStream = "combined") => {
		outputScheduler.enqueue({ line, stream })
	})

	// Start timer to detect if waiting for completion takes too long.
	//
	// A still-running command has not necessarily hung. When a handoff path
	// exists the command is expected to stay in the foreground until that window
	// elapses and then continue in the background, so that wait is the designed
	// behaviour rather than a hang; sampling it reported ordinary long-running
	// commands as hangs. Only a command that must finish in the foreground, and
	// that has produced no output at all, is waiting on something stuck.
	if (!onProceedWhileRunning) {
		completionTimer = setTimeout(() => {
			completionTimer = null
			if (completed || totalLineCount > 0) return
			telemetryService.captureTerminalHang(TerminalHangStage.WAITING_FOR_COMPLETION, terminalType)
		}, COMPLETION_TIMEOUT_MS)
	}

	process.once("completed", (details?: TerminalCompletionDetails) => {
		completed = true
		completionDetails = details
		// Clear the completion timer
		if (completionTimer) {
			clearTimeout(completionTimer)
			completionTimer = null
		}
		completionWork = (async () => {
			await outputScheduler.close()
			if (partialSayOutputTs !== undefined) {
				await say("command_output", partialSayText, undefined, undefined, false, partialSayOutputTs)
			}
		})()
		void completionWork.catch((error) => {
			if (error instanceof Error && error.message === "Dline instance aborted") {
				Logger.debug(`[CommandOrchestrator] Terminal output finalization stopped after task abort: ${error.message}`)
				return
			}
			Logger.error(`[CommandOrchestrator] Failed to finalize terminal output: ${error}`)
		})
	})
	process.once("error", () => undefined)

	process.once("no_shell_integration", async () => {
		if (showShellIntegrationSuggestion) {
			await say("shell_integration_warning_with_suggestion")
		} else {
			await say("shell_integration_warning")
		}
	})

	const startedAt = configuredStartedAt ?? (process.started ? await process.started : Date.now())
	const hasFiniteTimeout = timeoutSeconds !== undefined && timeoutSeconds > 0
	const deadlineAt = configuredDeadlineAt ?? (hasFiniteTimeout ? startedAt + timeoutSeconds * 1000 : undefined)
	commandTiming = { startedAt, deadlineAt }

	if (startInBackground && onProceedWhileRunning && !didCancelViaUi) {
		const result = await transitionToBackground("explicit", true)
		if (result) {
			return result
		}
	}

	// Wait for completion, the automatic handoff, the one absolute kill deadline,
	// or an external request to move a synchronous command to the background.
	if (!didCancelViaUi) {
		const handoffMs = handoffSeconds * 1000
		const canAutoHandoff = Boolean(!synchronous && onProceedWhileRunning)
		const canManualHandoff = Boolean(synchronous && onProceedWhileRunning && onHandoffAvailable && handoffRequest)
		if (!hasFiniteTimeout && !canAutoHandoff && !canManualHandoff) {
			// Backward-compatible fallback for direct orchestrator callers.
			await process
		} else {
			type ExecutionBoundary = "completed" | "handoff" | "timeout"
			let handoffTimer: NodeJS.Timeout | undefined
			let handoffAvailableTimer: NodeJS.Timeout | undefined
			let deadlineTimer: NodeJS.Timeout | undefined
			const boundaries: Promise<ExecutionBoundary>[] = [process.then(() => "completed" as const)]

			if (canAutoHandoff) {
				boundaries.push(
					new Promise((resolve) => {
						handoffTimer = setTimeout(() => resolve("handoff"), Math.max(0, startedAt + handoffMs - Date.now()))
					}),
				)
			} else if (canManualHandoff) {
				// Synchronous commands stay in the foreground; once the handoff wait
				// elapsed, publish the footer handoff action and wait for its request.
				handoffAvailableTimer = setTimeout(() => onHandoffAvailable?.(), Math.max(0, startedAt + handoffMs - Date.now()))
				if (handoffRequest) {
					boundaries.push(handoffRequest.promise.then(() => "handoff" as const))
				}
			}
			if (deadlineAt !== undefined) {
				boundaries.push(
					new Promise((resolve) => {
						deadlineTimer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineAt - Date.now()))
					}),
				)
			}

			try {
				const boundary = await Promise.race(boundaries)
				if (boundary === "handoff") {
					const result = await transitionToBackground(canAutoHandoff ? "automatic" : "user", true)
					if (result) return result
				}

				if (boundary === "timeout") {
					process.pauseOutput?.()
					if (completionTimer) {
						clearTimeout(completionTimer)
						completionTimer = null
					}
					onTimeout?.()
					if (process.terminate) {
						await Promise.resolve(process.terminate())
					}
					await outputScheduler.close()
					await clearCommandState(process.getCompletionDetails?.(), true)
					await finishFileBased()
					const currentOutput = formatOutput(output)
					const logFilePath = largeOutputLogPath ?? undefined
					return {
						userRejected: false,
						result: appendCommandLogPath(
							`Command reached its ${timeoutSeconds}-second timeout and was terminated.${
								currentOutput.length > 0 ? `\nOutput captured before termination:\n${currentOutput}` : ""
							}`,
							logFilePath,
						),
						completed: false,
						timedOut: true,
						...splitTerminalOutput(output),
						...process.getCompletionDetails?.(),
						logFilePath,
					}
				}
			} finally {
				if (handoffTimer) clearTimeout(handoffTimer)
				if (handoffAvailableTimer) clearTimeout(handoffAvailableTimer)
				if (deadlineTimer) clearTimeout(deadlineTimer)
			}
		}
	}

	await outputScheduler.close()
	if (completed) {
		await completionWork
	}

	// Check if we returned early due to background tracking
	// This happens when user clicks "Proceed While Running" with background tracking enabled
	if (backgroundTrackingResult) {
		// Clean up file-based logging if active before returning
		await finishFileBased()
		return backgroundTrackingResult
	}

	// Clear timer if process completes normally
	if (completionTimer) {
		clearTimeout(completionTimer)
		completionTimer = null
	}

	// Clean up file-based logging if active
	await finishFileBased()

	// Build result based on whether we used file-based logging
	let result: string
	let resultOutput: TerminalOutputLine[]

	if (isWritingToFile) {
		// Build summary from first and last lines
		const skippedLines = Math.max(0, totalLineCount - firstLines.length - lastLines.length)
		resultOutput = [...firstLines, ...lastLines]
		const summaryNotice = `... (${skippedLines} lines written to ${largeOutputLogPath}) ...`
		result = [formatOutput(resultOutput), summaryNotice].filter(Boolean).join("\n\n")
	} else {
		result = formatOutput(output)
		resultOutput = output
	}
	const resultLines = splitTerminalOutput(resultOutput)

	if (didCancelViaUi) {
		const logFilePath = largeOutputLogPath ?? undefined
		return {
			userRejected: true,
			result: appendCommandLogPath(
				formatResponse.toolResult(
					`Command cancelled. ${result.length > 0 ? `\nOutput captured before cancellation:\n${result}` : ""}`,
				),
				logFilePath,
			),
			completed: false,
			...resultLines,
			logFilePath,
			exitCode: completionDetails?.exitCode,
			signal: completionDetails?.signal,
		}
	}

	if (userFeedback) {
		await say("user_feedback", userFeedback.text, userFeedback.images, userFeedback.files)

		let fileContentString = ""
		if (userFeedback.files && userFeedback.files.length > 0) {
			fileContentString = await processFilesIntoText(userFeedback.files)
		}

		return {
			userRejected: true,
			result: formatResponse.toolResult(
				`Command is still running in the user's terminal.${
					result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
				}\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
				userFeedback.images,
				fileContentString,
			),
			completed: false,
			...resultLines,
			logFilePath: largeOutputLogPath || undefined,
			exitCode: completionDetails?.exitCode,
			signal: completionDetails?.signal,
		}
	}

	if (completed) {
		const exitCode = completionDetails?.exitCode
		const signal = completionDetails?.signal
		const hasExitCode = typeof exitCode === "number"
		const logFileMsg = largeOutputLogPath ? `\nFull output saved to: ${largeOutputLogPath}` : ""
		const statusMessage = isCommandCompletionSuccessful(completionDetails)
			? "Command executed successfully (exit code 0)."
			: signal
				? `Command terminated by signal ${signal}.`
				: hasExitCode
					? `Command failed with exit code ${exitCode}.`
					: "Command completion could not be verified because no exit code was reported."

		return {
			userRejected: false,
			result: `${statusMessage}${result.length > 0 ? `\n${result}` : ""}${logFileMsg}`,
			completed: true,
			...resultLines,
			logFilePath: largeOutputLogPath || undefined,
			exitCode,
			signal,
		}
	}
	const logFileMsg = largeOutputLogPath ? `\nFull output saved to: ${largeOutputLogPath}` : ""
	return {
		userRejected: false,
		result: `Command is still running in the user's terminal.${
			result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
		}${logFileMsg}\n\nIf a later model request is sent, it can include the terminal status and new output.`,
		completed: false,
		...resultLines,
		logFilePath: largeOutputLogPath || undefined,
		exitCode: completionDetails?.exitCode,
		signal: completionDetails?.signal,
	}
}
