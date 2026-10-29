import { TerminalOutputFailureReason, telemetryService } from "@services/telemetry"
import { EventEmitter } from "events"
import * as vscode from "vscode"
import { getLatestTerminalOutput } from "@/hosts/vscode/terminal/get-latest-output"
import {
    containsInternalCommandExitMarker,
    findMarkedCommandCompletion,
    parseInternalCommandExitMarker,
    removeInternalCommandExitMarkers,
} from "@/integrations/terminal/command-completion-marker"
import {
    isCompilingOutput,
    MAX_FULL_OUTPUT_SIZE,
    MAX_UNRETRIEVED_LINES,
    PROCESS_HOT_TIMEOUT_COMPILING,
    PROCESS_HOT_TIMEOUT_NORMAL,
    TRUNCATE_KEEP_LINES,
} from "@/integrations/terminal/constants"
import type {
    ITerminalProcess,
    TerminalCommandExecutionOptions,
    TerminalCompletionDetails,
    TerminalProcessEvents,
} from "@/integrations/terminal/types"
import { Logger } from "@/shared/services/Logger"

const MARKER_SNAPSHOT_TIMEOUT_MS = 5_000
/**
 * An execution end only hints that the marker may be on screen: the terminal renders the marker
 * line before the end sequence, so a short window suffices, and later ends re-arm the check.
 */
const MARKER_END_HINT_WINDOW_MS = 1_500
const MARKER_SNAPSHOT_INITIAL_POLL_MS = 250
const MARKER_SNAPSHOT_MAX_POLL_MS = 1_000

interface ShellExecutionLike {
    read(): AsyncIterable<string>
}

function isShellExecutionLike(value: unknown): value is ShellExecutionLike {
    return typeof value === "object" && value !== null && "read" in value && typeof value.read === "function"
}

/**
 * VscodeTerminalProcess - Manages command execution in VSCode's integrated terminal.
 *
 * This class handles command execution using VSCode's shell integration API.
 * It processes VSCode-specific escape sequences and streams output through events.
 *
 * Implements ITerminalProcess interface for polymorphic usage with CommandExecutor.
 *
 * Events:
 * - 'line': Emitted for each line of output
 * - 'completed': Emitted when the process completes
 * - 'continue': Emitted when continue() is called
 * - 'error': Emitted on process errors
 * - 'no_shell_integration': Emitted when shell integration is not available
 */
export class VscodeTerminalProcess extends EventEmitter<TerminalProcessEvents> implements ITerminalProcess {
    readonly started: Promise<number>
    private resolveStarted: ((startedAt: number) => void) | undefined
    waitForShellIntegration = true
    private isListening = true
    private buffer = ""
    private fullOutput = ""
    private lastRetrievedIndex = 0
    isHot = false
    private hotTimer: NodeJS.Timeout | null = null
    private exitCode: number | null | undefined = undefined
    private signal: NodeJS.Signals | null = null
    private terminal: vscode.Terminal | null = null
    private completionEmitted = false
    private completionVerified = false
    private completionDetailsReceived = false
    private completionDetailsWaiter: (() => void) | null = null
    private terminalEndSignal!: Promise<void>
    private resolveTerminalEndSignal: (() => void) | undefined
    private activeExecution: unknown
    private readonly observedExecutions = new Set<unknown>()
    private supplementalReaderCount = 0
    private readonly executionStateWaiters = new Set<() => void>()
    private completionMarkerToken: string | undefined
    /** Output recovered from the terminal buffer when the marker was proven there instead of in a stream. */
    private recoveredMarkerOutput: string | undefined
    private markerVerification: Promise<void> | null = null
    private markerVerificationRequested = false
    private terminationPromise: Promise<void> | null = null
    private cancelledBeforeRun = false
    private terminalDisposed = false
    private outputCapacityGate: Promise<void> | undefined
    private releaseOutputCapacityGate: (() => void) | undefined

    constructor() {
        super()
        this.started = new Promise<number>((resolve) => {
            this.resolveStarted = resolve
        })
        this.resetTerminalEndSignal()
    }

    async run(terminal: vscode.Terminal, command: string, options: TerminalCommandExecutionOptions = {}) {
        if (this.cancelledBeforeRun) return
        this.resolveStarted?.(Date.now())
        this.resolveStarted = undefined
        this.completionDetailsWaiter?.()
        this.terminal = terminal
        this.exitCode = undefined
        this.signal = null
        this.completionEmitted = false
        this.completionVerified = false
        this.completionDetailsReceived = false
        this.terminalDisposed = false
        this.activeExecution = undefined
        this.observedExecutions.clear()
        this.supplementalReaderCount = 0
        this.executionStateWaiters.clear()
        this.completionMarkerToken = options.completionMarkerToken
        this.recoveredMarkerOutput = undefined
        this.markerVerificationRequested = false
        this.terminationPromise = null
        this.resetTerminalEndSignal()

        const captureTerminalContents = async (preserveLastLine = false): Promise<string | undefined> => {
            try {
                return await getLatestTerminalOutput({ preserveLastLine, terminal })
            } catch (error) {
                Logger.error("Error capturing terminal output:", error)
                return undefined
            }
        }

        // When command output cannot be read from shell integration, return a sanitized terminal snapshot.
        const returnCurrentTerminalContents = async (terminalSnapshot?: string): Promise<string | undefined> => {
            try {
                const capturedSnapshot = terminalSnapshot ?? (await captureTerminalContents())
                const sanitizedSnapshot =
                    capturedSnapshot === undefined ? undefined : removeInternalCommandExitMarkers(capturedSnapshot)
                if (sanitizedSnapshot?.trim()) {
                    const fallbackMessage = `The command's output could not be captured through shell integration. Here's the current terminal content to help recover the output:\n\n${sanitizedSnapshot}`
                    for (const line of fallbackMessage.split(/\r?\n/)) {
                        this.emit("line", line, "combined")
                    }
                }
                return sanitizedSnapshot
            } catch (error) {
                Logger.error("Error processing terminal output:", error)
                return undefined
            }
        }

        if (terminal.shellIntegration?.executeCommand) {
            // Track that we're using shell integration
            const execution = terminal.shellIntegration.executeCommand(command)
            this.activeExecution = execution
            this.observedExecutions.add(execution)
            const streamIterator = execution.read()[Symbol.asyncIterator]()
            // todo: need to handle errors
            let isFirstChunk = true
            let didOutputNonCommand = false

            while (true) {
                const next = await Promise.race([
                    streamIterator.next().then((result) => ({ kind: "stream" as const, result })),
                    this.terminalEndSignal.then(() => ({ kind: "terminal_end" as const })),
                ])
                if (next.kind === "terminal_end") {
                    try {
                        const closing = streamIterator.return?.()
                        void closing?.catch((error) =>
                            Logger.debug(`[TerminalProcess] Failed to close completed shell integration stream: ${error}`),
                        )
                    } catch (error) {
                        Logger.debug(`[TerminalProcess] Failed to close completed shell integration stream: ${error}`)
                    }
                    break
                }
                if (next.result.done) break
                let data = next.result.value
                await this.waitForOutputCapacity()
                // Parse shell integration completion markers when present.
                // Sequence format: ]633;D;<exitCode>
                const completionMatches = [...data.matchAll(/\]633;D(?:;(-?\d+))?/g)]
                const latestCompletionMatch = completionMatches[completionMatches.length - 1]
                if (!this.completionMarkerToken && latestCompletionMatch?.[1] !== undefined) {
                    const parsedExitCode = Number.parseInt(latestCompletionMatch[1], 10)
                    if (Number.isInteger(parsedExitCode)) {
                        this.exitCode = parsedExitCode
                        this.completionVerified = true
                    }
                }

                if (isFirstChunk) {
                    data = this.sanitizeFirstChunk(data)
                    if (this.isLeadingInterruptArtifact(data)) continue
                    isFirstChunk = false
                }

                // The first few chunks can contain the submitted command echoed back by the shell.
                // Only remove an exact command line: command substrings can also be legitimate output.
                if (!didOutputNonCommand) {
                    const lines = data.split("\n")
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].trim() === command.trim()) {
                            lines.splice(i, 1)
                            i-- // Adjust index after removal
                        } else {
                            didOutputNonCommand = true
                            break
                        }
                    }
                    data = lines.join("\n")
                }

                this.recordOutputChunk(data)
                if (this.isListening) {
                    const internalCompletionObserved = this.emitIfEol(data)
                    this.lastRetrievedIndex = this.fullOutput.length - this.buffer.length
                    if (internalCompletionObserved) break
                }
            }

            this.emitRemainingBufferIfListening()

            if (this.isAwaitingMarker()) {
                await this.pollTerminalBufferForMarker("primary_stream_end", {
                    windowMs: MARKER_SNAPSHOT_TIMEOUT_MS,
                    yieldToSupplementalReaders: true,
                })
            }

            const capturedOutput = removeInternalCommandExitMarkers(this.fullOutput).trim()
            const recoveredOutput = this.readRecoveredMarkerOutput()
            // Output proven by the marker in the buffer is authoritative; otherwise fall back to the
            // current terminal contents only when the streams carried nothing.
            const needsTerminalContents =
                recoveredOutput === undefined
                    ? !capturedOutput
                    : Boolean(recoveredOutput) && !capturedOutput.includes(recoveredOutput)

            // the command process is finished, let's check the output to see if we need to use the terminal capture fallback
            if (needsTerminalContents && !this.terminalDisposed) {
                telemetryService.captureTerminalOutputFailure(TerminalOutputFailureReason.TIMEOUT, "vscode")
                const terminalSnapshot = await returnCurrentTerminalContents(recoveredOutput)
                if (terminalSnapshot?.trim()) {
                    telemetryService.captureTerminalExecution(true, "vscode", "clipboard")
                } else {
                    telemetryService.captureTerminalExecution(false, "vscode", "none")
                }
            } else if (capturedOutput) {
                // Shell integration worked
                telemetryService.captureTerminalExecution(true, "vscode", "shell_integration")
            }

            // for now we don't want this delaying requests since we don't send diagnostics automatically anymore (previous: "even though the command is finished, we still want to consider it 'hot' in case so that api request stalls to let diagnostics catch up")
            // to explain this further, before we would send workspace diagnostics automatically with each request, but now we only send new diagnostics after file edits, so there's no need to wait for a bit after commands run to let diagnostics catch up
            if (this.hotTimer) {
                clearTimeout(this.hotTimer)
            }
            this.isHot = false

            // Give the authoritative terminal-end event a bounded opportunity to
            // publish its exit code before finalizing the command lifecycle.
            await this.waitForCompletionDetails()
            this.complete()
        } else {
            // no shell integration detected, we'll fallback to running the command and capturing the terminal's output after some time
            telemetryService.captureTerminalOutputFailure(TerminalOutputFailureReason.NO_SHELL_INTEGRATION, "vscode")
            terminal.sendText(command, true)

            // wait 3 seconds for the command to run
            await new Promise((resolve) => setTimeout(resolve, 3000))

            // For terminals without shell integration, also try to capture terminal content
            const terminalSnapshot = await returnCurrentTerminalContents()
            // Check if clipboard fallback worked
            if (terminalSnapshot?.trim()) {
                telemetryService.captureTerminalExecution(true, "vscode", "clipboard")
            } else {
                telemetryService.captureTerminalExecution(false, "vscode", "none")
            }
            // Publish the capability failure first so the manager invalidates a pooled
            // lease before the generic completion handler can consider it reusable.
            this.emit("no_shell_integration")
            // Without shell integration there is no authoritative exit code. Preserve
            // lifecycle compatibility while leaving success unverified.
            this.complete()
            // setTimeout(() => {
            // 	Logger.log(`Emitting continue after delay for terminal`)
            // 	// can't emit completed since we don't if the command actually completed, it could still be running server
            // }, 500) // Adjust this delay as needed
        }
    }

    private sanitizeFirstChunk(data: string): string {
        const outputBetweenSequences = this.removeLastLineArtifacts(data.match(/\]633;C([\s\S]*?)\]633;D/)?.[1] || "").trim()
        const vscodeSequenceRegex = /\x1b\]633;.[^\x07]*\x07/g
        const lastMatch = [...data.matchAll(vscodeSequenceRegex)].pop()
        if (lastMatch?.index !== undefined) data = data.slice(lastMatch.index + lastMatch[0].length)
        if (outputBetweenSequences) data = `${outputBetweenSequences}\n${data}`

        const lines = data ? data.split("\n") : []
        if (lines.length > 0) lines[0] = lines[0].replace(/[\x00-\x1F\x7F]/g, "")
        if (
            lines.length > 0 &&
            lines[0].length >= 2 &&
            lines[0].charCodeAt(0) < 128 &&
            lines[0].charCodeAt(0) === lines[0].charCodeAt(1) &&
            !["[", "{", '"', "'", "<", "("].includes(lines[0][0])
        ) {
            lines[0] = lines[0].slice(1)
        }
        if (lines.length > 0) lines[0] = lines[0].replace(/^[\x00-\x1A\x1C-\x1F%$>#\s]*/, "")
        if (lines.length > 1) lines[1] = lines[1].replace(/^[\x00-\x1A\x1C-\x1F%$>#\s]*/, "")
        return lines.join("\n")
    }

    private isLeadingInterruptArtifact(data: string): boolean {
        const lines = data.trim().split(/\r?\n/)
        if (lines.length !== 1) return false
        return lines[0] === "\u0003" || /(?:^|[%$>#])\s*\^C$/.test(lines[0])
    }

    private recordOutputChunk(data: string): void {
        if (!data) return
        this.isHot = true
        if (this.hotTimer) clearTimeout(this.hotTimer)
        const isCompiling = isCompilingOutput(data)
        this.hotTimer = setTimeout(
            () => {
                this.isHot = false
            },
            isCompiling ? PROCESS_HOT_TIMEOUT_COMPILING : PROCESS_HOT_TIMEOUT_NORMAL,
        )
        if (!this.fullOutput) this.emit("line", "", "combined")
        this.fullOutput += data
        if (this.fullOutput.length > MAX_FULL_OUTPUT_SIZE) {
            this.fullOutput = this.fullOutput.slice(-MAX_FULL_OUTPUT_SIZE / 2)
            this.lastRetrievedIndex = 0
        }
    }

    // Inspired by https://github.com/sindresorhus/execa/blob/main/lib/transform/split.js
    private emitIfEol(chunk: string): boolean {
        this.buffer += chunk
        let lineEndIndex: number
        while ((lineEndIndex = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, lineEndIndex).trimEnd() // removes trailing \r
            const internalExitCode = parseInternalCommandExitMarker(line, this.completionMarkerToken)
            if (internalExitCode !== undefined) {
                this.exitCode = internalExitCode
                this.completionVerified = true
                // The marker is emitted after the user command and every post-command.
                // Any remaining bytes belong to the returned shell prompt, not command output.
                this.buffer = ""
                return true
            }
            this.buffer = this.buffer.slice(lineEndIndex + 1)
            if (containsInternalCommandExitMarker(line)) continue
            this.emit("line", line, "combined")
        }
        return false
    }

    private emitRemainingBufferIfListening() {
        if (this.buffer && this.isListening) {
            const remainingBuffer = this.removeLastLineArtifacts(this.buffer)
            const internalExitCode = parseInternalCommandExitMarker(remainingBuffer, this.completionMarkerToken)
            if (internalExitCode !== undefined) {
                this.exitCode = internalExitCode
                this.completionVerified = true
            } else if (remainingBuffer && !containsInternalCommandExitMarker(remainingBuffer)) {
                this.emit("line", remainingBuffer, "combined")
            }
            this.buffer = ""
            this.lastRetrievedIndex = this.fullOutput.length
        }
    }

    /** Whether this command had to dispose its terminal to establish a completion boundary. */
    wasTerminalDisposed(): boolean {
        return this.terminalDisposed
    }

    /** Whether completion came from an authoritative exit event or this command's exact marker. */
    isCompletionVerified(): boolean {
        return this.completionVerified
    }

    /** Accept completion metadata only from an execution observed after this command started. */
    acceptCompletionDetails(execution: unknown, details: TerminalCompletionDetails): boolean {
        if (this.completionMarkerToken) {
            // VS Code can bind the shell's report to an execution other than the one it returned,
            // leaving that stream open forever, or end one split part of the wrapper. Any end on
            // this terminal is therefore only a hint to look for this command's exact marker.
            this.requestMarkerVerification("execution_end")
            if (execution === undefined || !this.observedExecutions.has(execution)) return false
            return typeof details.exitCode === "number" || (details.signal !== undefined && details.signal !== null)
        }
        if (execution === undefined || !this.observedExecutions.has(execution)) return false
        if (execution !== this.activeExecution) return false
        return this.applyCompletionDetails(details)
    }

    /** Observe shell executions split by VS Code from the submitted command wrapper. */
    observeShellExecution(execution: unknown): void {
        if (!this.completionMarkerToken || this.completionEmitted || !isShellExecutionLike(execution)) return
        if (this.observedExecutions.has(execution)) return
        this.observedExecutions.add(execution)
        this.supplementalReaderCount++
        this.signalExecutionStateChange()
        queueMicrotask(() => {
            const finish = () => {
                this.supplementalReaderCount = Math.max(0, this.supplementalReaderCount - 1)
                this.signalExecutionStateChange()
            }
            if (this.completionEmitted || execution === this.activeExecution) {
                finish()
                return
            }
            void this.readSupplementalExecution(execution).then(
                () => {
                    finish()
                    // The part ended without carrying the marker into this reader; its output may
                    // have been emitted before the reader attached, so look in the buffer instead.
                    this.requestMarkerVerification("supplemental_end")
                },
                (error) => {
                    Logger.debug(`[TerminalProcess] Failed to read supplemental shell execution: ${error}`)
                    finish()
                },
            )
        })
    }

    /** End a pending read when the owning terminal is closed. */
    notifyTerminalClosed(): void {
        if (this.completionEmitted) return
        this.terminalDisposed = true
        if (this.hotTimer) {
            clearTimeout(this.hotTimer)
            this.hotTimer = null
        }
        this.isHot = false
        this.resumeOutput()
        this.signalTerminalEnd()
        this.completionDetailsWaiter?.()
    }

    private applyCompletionDetails(details: TerminalCompletionDetails): boolean {
        const exitCode = details.exitCode
        const signal = details.signal
        const hasExitCode = typeof exitCode === "number"
        const hasSignal = signal !== undefined && signal !== null
        if (!hasExitCode && !hasSignal) return false

        if (hasExitCode) this.exitCode = exitCode
        if (hasSignal) this.signal = signal
        this.completionDetailsReceived = true
        this.completionVerified = true
        this.signalTerminalEnd()
        this.completionDetailsWaiter?.()
        return true
    }

    private async readSupplementalExecution(execution: ShellExecutionLike): Promise<void> {
        const streamIterator = execution.read()[Symbol.asyncIterator]()
        let isFirstChunk = true
        let buffer = ""
        while (!this.completionEmitted && !this.terminalDisposed && this.exitCode === undefined) {
            const next = await Promise.race([
                streamIterator.next().then((result) => ({ kind: "stream" as const, result })),
                this.terminalEndSignal.then(() => ({ kind: "terminal_end" as const })),
            ])
            if (next.kind === "terminal_end") {
                const closing = streamIterator.return?.()
                void closing?.catch((error) =>
                    Logger.debug(`[TerminalProcess] Failed to close supplemental shell stream: ${error}`),
                )
                return
            }
            if (next.result.done) break
            let data = next.result.value
            await this.waitForOutputCapacity()
            if (isFirstChunk) {
                data = this.sanitizeFirstChunk(data)
                if (this.isLeadingInterruptArtifact(data)) continue
                isFirstChunk = false
            }
            this.recordOutputChunk(data)
            buffer += data
            let lineEndIndex: number
            while ((lineEndIndex = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, lineEndIndex).trimEnd()
                buffer = buffer.slice(lineEndIndex + 1)
                const markerExitCode = parseInternalCommandExitMarker(line, this.completionMarkerToken)
                if (markerExitCode !== undefined) {
                    this.exitCode = markerExitCode
                    this.completionVerified = true
                    this.signalTerminalEnd()
                    return
                }
                if (!containsInternalCommandExitMarker(line) && this.isListening) this.emit("line", line, "combined")
            }
            this.lastRetrievedIndex = this.fullOutput.length - buffer.length
        }
        const remaining = this.removeLastLineArtifacts(buffer)
        const markerExitCode = parseInternalCommandExitMarker(remaining, this.completionMarkerToken)
        if (markerExitCode !== undefined) {
            this.exitCode = markerExitCode
            this.completionVerified = true
            this.signalTerminalEnd()
        } else if (remaining && !containsInternalCommandExitMarker(remaining) && this.isListening) {
            this.emit("line", remaining, "combined")
        }
    }

    /** Read through a method: the field changes asynchronously, which control-flow narrowing cannot see. */
    private readRecoveredMarkerOutput(): string | undefined {
        return this.recoveredMarkerOutput?.trim()
    }

    /** Whether a marker command still lacks proof that its whole wrapper finished. */
    private isAwaitingMarker(): boolean {
        return (
            Boolean(this.completionMarkerToken && this.terminal) &&
            !this.completionEmitted &&
            !this.completionDetailsReceived &&
            this.exitCode === undefined &&
            this.signal === null &&
            !this.terminalDisposed
        )
    }

    /**
     * Look for this command's marker in the terminal buffer after an end hint. One check runs at a
     * time; hints arriving meanwhile re-arm it. A miss never completes the command, because a split
     * part can end while the rest of the wrapper is still running.
     */
    private requestMarkerVerification(trigger: string): void {
        if (!this.isAwaitingMarker()) return
        if (this.markerVerification) {
            this.markerVerificationRequested = true
            return
        }
        this.markerVerification = this.pollTerminalBufferForMarker(trigger, {
            windowMs: MARKER_END_HINT_WINDOW_MS,
            yieldToSupplementalReaders: false,
        }).finally(() => {
            this.markerVerification = null
            if (!this.markerVerificationRequested) return
            this.markerVerificationRequested = false
            this.requestMarkerVerification(trigger)
        })
    }

    /** Poll the terminal buffer with backoff until the marker appears, the command settles, or the window closes. */
    private async pollTerminalBufferForMarker(
        trigger: string,
        options: { windowMs: number; yieldToSupplementalReaders: boolean },
    ): Promise<void> {
        let deadline = Date.now() + options.windowMs
        let pollInterval = MARKER_SNAPSHOT_INITIAL_POLL_MS
        while (this.isAwaitingMarker()) {
            if (options.yieldToSupplementalReaders && this.supplementalReaderCount > 0) {
                // A split part is still streaming and may carry the marker itself. Its end requests
                // a buffer check of its own, so this wait cannot strand a command that finished.
                await this.waitForExecutionStateChange()
                deadline = Date.now() + options.windowMs
                pollInterval = MARKER_SNAPSHOT_INITIAL_POLL_MS
                continue
            }
            if (await this.adoptMarkerFromTerminalBuffer(trigger)) return
            const remainingMs = deadline - Date.now()
            if (remainingMs <= 0) return
            await this.waitForExecutionStateChange(Math.min(pollInterval, remainingMs))
            pollInterval = Math.min(pollInterval * 2, MARKER_SNAPSHOT_MAX_POLL_MS)
        }
    }

    /** Adopt this command's exact marker from the whole terminal buffer; returns whether it was found. */
    private async adoptMarkerFromTerminalBuffer(trigger: string): Promise<boolean> {
        const token = this.completionMarkerToken
        const terminal = this.terminal
        if (!token || !terminal || !this.isAwaitingMarker()) return false
        let buffer: string
        try {
            buffer = await getLatestTerminalOutput({ terminal, wholeBuffer: true })
        } catch (error) {
            Logger.error("Error capturing terminal output:", error)
            return false
        }
        // The command may have completed, been cancelled, or lost its terminal during the capture.
        if (!this.isAwaitingMarker() || this.completionMarkerToken !== token) return false
        const completion = findMarkedCommandCompletion(buffer, token)
        if (!completion) return false
        this.exitCode = completion.exitCode
        this.completionVerified = true
        this.recoveredMarkerOutput = completion.output
        Logger.debug(`[TerminalProcess] completion_source=terminal_buffer trigger=${trigger} exitCode=${completion.exitCode}`)
        this.signalTerminalEnd()
        return true
    }

    private waitForExecutionStateChange(timeoutMs?: number): Promise<void> {
        return new Promise((resolve) => {
            let settled = false
            let timeout: NodeJS.Timeout | undefined
            const finish = () => {
                if (settled) return
                settled = true
                if (timeout) clearTimeout(timeout)
                this.executionStateWaiters.delete(finish)
                resolve()
            }
            this.executionStateWaiters.add(finish)
            if (timeoutMs !== undefined) timeout = setTimeout(finish, timeoutMs)
            void this.terminalEndSignal.then(finish)
        })
    }

    private signalExecutionStateChange(): void {
        for (const waiter of [...this.executionStateWaiters]) waiter()
    }

    private signalTerminalEnd(): void {
        this.resolveTerminalEndSignal?.()
        this.resolveTerminalEndSignal = undefined
        this.signalExecutionStateChange()
    }

    private resetTerminalEndSignal(): void {
        this.terminalEndSignal = new Promise<void>((resolve) => {
            this.resolveTerminalEndSignal = resolve
        })
    }

    private waitForCompletionDetails(timeoutMs = 100): Promise<void> {
        if (this.completionDetailsReceived || this.exitCode !== undefined || this.signal !== null || this.terminalDisposed) {
            return Promise.resolve()
        }

        return new Promise((resolve) => {
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                if (this.completionDetailsWaiter === finish) {
                    this.completionDetailsWaiter = null
                }
                resolve()
            }
            const timeout = setTimeout(finish, timeoutMs)
            this.completionDetailsWaiter = finish
        })
    }

    /** Finalize this command once while preserving the latest completion metadata. */
    private complete(): void {
        if (this.completionEmitted) return
        this.completionEmitted = true
        this.signalTerminalEnd()
        this.activeExecution = undefined
        this.observedExecutions.clear()
        this.emit("completed", this.getCompletionDetails())
        this.emit("continue")
    }

    pauseOutput(): void {
        if (this.outputCapacityGate) return
        this.outputCapacityGate = new Promise<void>((resolve) => {
            this.releaseOutputCapacityGate = resolve
        })
    }

    resumeOutput(): void {
        this.releaseOutputCapacityGate?.()
        this.outputCapacityGate = undefined
        this.releaseOutputCapacityGate = undefined
    }

    continue() {
        this.emitRemainingBufferIfListening()
        this.emit("continue")
    }

    private async waitForOutputCapacity(): Promise<void> {
        await this.outputCapacityGate
    }

    /** Interrupt the active command, then dispose its terminal if it does not stop promptly. */
    async terminate(): Promise<void> {
        if (this.completionEmitted) return
        if (this.terminationPromise) return this.terminationPromise

        this.signal = "SIGINT"
        this.resumeOutput()
        if (!this.terminal) {
            this.cancelledBeforeRun = true
            this.waitForShellIntegration = false
            this.resolveStarted?.(Date.now())
            this.resolveStarted = undefined
            this.complete()
            return
        }

        const terminal = this.terminal
        terminal.sendText("\u0003", false)
        if (this.hotTimer) {
            clearTimeout(this.hotTimer)
            this.hotTimer = null
        }
        this.isHot = false

        this.terminationPromise = new Promise<void>((resolve) => {
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                clearTimeout(fallbackTimer)
                this.off("completed", finish)
                resolve()
            }
            const fallbackTimer = setTimeout(() => {
                if (!this.completionEmitted) {
                    this.terminalDisposed = true
                    terminal.dispose()
                    this.complete()
                }
                finish()
            }, 1000)
            this.once("completed", finish)
        })

        return this.terminationPromise
    }

    /**
     * Get output that hasn't been retrieved yet.
     * Truncates if output is too large to prevent context window overflow.
     * @returns The unretrieved output (truncated if necessary)
     */
    getUnretrievedOutput(): string {
        const unretrieved = removeInternalCommandExitMarkers(this.fullOutput.slice(this.lastRetrievedIndex))
        this.lastRetrievedIndex = this.fullOutput.length

        // Truncate if too many lines to prevent context overflow
        const lines = unretrieved.split("\n")
        if (lines.length > MAX_UNRETRIEVED_LINES) {
            const first = lines.slice(0, TRUNCATE_KEEP_LINES)
            const last = lines.slice(-TRUNCATE_KEEP_LINES)
            const skipped = lines.length - first.length - last.length
            return this.removeLastLineArtifacts([...first, `\n... (${skipped} lines truncated) ...\n`, ...last].join("\n"))
        }

        return this.removeLastLineArtifacts(unretrieved)
    }

    getCompletionDetails(): TerminalCompletionDetails {
        return {
            exitCode: this.exitCode,
            signal: this.signal,
        }
    }

    // some processing to remove artifacts like '%' at the end of the buffer (it seems that since vsode uses % at the beginning of newlines in terminal, it makes its way into the stream)
    // This modification will remove '%', '$', '#', or '>' followed by optional whitespace
    removeLastLineArtifacts(output: string) {
        const lines = output.trimEnd().split("\n")
        if (lines.length > 0) {
            const lastLine = lines[lines.length - 1]
            // Remove prompt characters and trailing whitespace from the last line
            lines[lines.length - 1] = lastLine.replace(/[%$#>]\s*$/, "")
        }
        return lines.join("\n").trimEnd()
    }
}

export type TerminalProcessResultPromise = VscodeTerminalProcess & Promise<void>

// Similar to execa's ResultPromise, this lets us create a mixin of both a TerminalProcess and a Promise: https://github.com/sindresorhus/execa/blob/main/lib/methods/promise.js
export function mergePromise(process: VscodeTerminalProcess, promise: Promise<void>): TerminalProcessResultPromise {
    const nativePromisePrototype = (async () => {})().constructor.prototype
    const descriptors = ["then", "catch", "finally"].map(
        (property) => [property, Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property)] as const,
    )
    for (const [property, descriptor] of descriptors) {
        if (descriptor) {
            const value = descriptor.value.bind(promise)
            Reflect.defineProperty(process, property, { ...descriptor, value })
        }
    }
    return process as TerminalProcessResultPromise
}
