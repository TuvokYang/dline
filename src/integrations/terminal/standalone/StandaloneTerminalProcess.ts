/**
 * StandaloneTerminalProcess - Manages command execution in standalone environments.
 *
 * This class handles subprocess management for terminal commands when running
 * outside of VSCode (CLI, JetBrains). It spawns child processes and streams
 * their output through events.
 *
 * Implements ITerminalProcess interface for polymorphic usage with CommandExecutor.
 */

import { telemetryService } from "@services/telemetry"
import { ChildProcess, execSync, spawn } from "child_process"
import { EventEmitter } from "events"
import * as iconv from "iconv-lite"
import { terminateProcessTree } from "@/utils/process-termination"
import { WINDOWS_POWERSHELL_LEGACY_PATH } from "@/utils/shell"
import {
	isCompilingOutput,
	MAX_FULL_OUTPUT_SIZE,
	MAX_UNRETRIEVED_LINES,
	PROCESS_HOT_TIMEOUT_COMPILING,
	PROCESS_HOT_TIMEOUT_NORMAL,
	TRUNCATE_KEEP_LINES,
} from "../constants"
import type { WindowsProcessTreeProvider } from "../process-tree"
import type {
	ITerminal,
	ITerminalProcess,
	TerminalCompletionDetails,
	TerminalOutputStream,
	TerminalProcessEvents,
} from "../types"

type StandaloneOutputStream = Exclude<TerminalOutputStream, "combined">

let cachedSystemEncoding: string | null | undefined

/** Detect the host terminal encoding once because Windows code page lookup starts a synchronous process. */
function getSystemEncoding(): string | null {
	if (cachedSystemEncoding !== undefined) return cachedSystemEncoding
	cachedSystemEncoding = null
	if (process.platform !== "win32") return cachedSystemEncoding
	try {
		const output = execSync("chcp", { encoding: "utf-8", timeout: 1000 })
		const match = output.match(/(\d+)/)
		if (!match) return cachedSystemEncoding
		const cpMap: Record<number, string> = {
			936: "gbk",
			65001: "utf-8",
			950: "big5",
			932: "shift_jis",
		}
		cachedSystemEncoding = cpMap[Number.parseInt(match[1], 10)] ?? null
	} catch {
		cachedSystemEncoding = null
	}
	return cachedSystemEncoding
}

/**
 * Manages the execution of a command in a standalone terminal environment.
 * Extends EventEmitter to provide real-time output streaming.
 *
 * Implements ITerminalProcess for polymorphic usage with CommandExecutor.
 *
 * Events:
 * - 'line': Emitted for each line of output
 * - 'completed': Emitted when the process completes
 * - 'continue': Emitted when continue() is called
 * - 'error': Emitted on process errors
 * - 'no_shell_integration': Emitted for compatibility (never actually emitted in standalone)
 */
export class StandaloneTerminalProcess extends EventEmitter<TerminalProcessEvents> implements ITerminalProcess {
	readonly started: Promise<number>
	private resolveStarted: ((startedAt: number) => void) | undefined

	/** We don't need to wait since we control the process directly */
	waitForShellIntegration = false

	/** Whether we're actively listening for output */
	isListening = true

	/** Detected system encoding for the terminal */
	private readonly systemEncoding: string | null

	/** Per-stream buffers for incomplete lines. */
	private buffers: Record<StandaloneOutputStream, string> = {
		stdout: "",
		stderr: "",
	}

	/** Per-stream byte decoders preserve multibyte characters across child-process chunks. */
	private outputDecoders: Partial<Record<StandaloneOutputStream, ReturnType<typeof iconv.getDecoder>>> = {}

	/** Bytes held while distinguishing an incomplete UTF-8 sequence from a legacy encoding. */
	private undecodedBuffers: Record<StandaloneOutputStream, Buffer> = {
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
	}

	/** Full output captured from the process */
	private fullOutput = ""

	/** Index of last retrieved output position */
	private lastRetrievedIndex = 0

	/** Whether the process is actively outputting */
	isHot = false

	/** Timer for tracking hot state */
	private hotTimer: NodeJS.Timeout | null = null

	/** The spawned child process */
	private childProcess: ChildProcess | null = null
	private outputPaused = false

	/** Exit code from the process */
	private exitCode: number | null = null

	/** Exit signal from the process */
	private signal: NodeJS.Signals | null = null

	/** Whether the process has completed */
	private isCompleted = false

	constructor(private readonly windowsProcessTreeProvider?: WindowsProcessTreeProvider) {
		super()
		this.started = new Promise<number>((resolve) => {
			this.resolveStarted = resolve
		})
		this.systemEncoding = getSystemEncoding()
	}

	/** All encodings to try, ordered by priority. */
	private static readonly CANDIDATE_ENCODINGS = ["utf-8", "gbk", "cp936", "gb2312", "big5"]
	private static readonly STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

	/**
	 * Force UTF-8 on the child shell's console before the user command runs.
	 *
	 * Child shells are spawned with piped stdio, so Windows falls back to the system ANSI code
	 * page instead of UTF-8. A user command that pipes a UTF-8 emitting process through the shell
	 * (`biome check ... | Select-Object ...`) would otherwise have its bytes decoded with the wrong
	 * code page inside the shell itself, before Dline reads them. That corruption is lossy and
	 * cannot be repaired downstream, so it must be prevented at the shell boundary.
	 */
	private static readonly POWERSHELL_UTF8_PRELUDE =
		"[Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); " +
		"$OutputEncoding = [Console]::OutputEncoding; "
	private static readonly CMD_UTF8_PRELUDE = "chcp 65001>nul & "

	/**
	 * Decode one output chunk without treating an incomplete multibyte character as corrupt data.
	 * Encoding selection is independent for stdout and stderr because the streams can split at
	 * different byte boundaries.
	 */
	private decodeBuffer(data: Buffer, stream: StandaloneOutputStream): string {
		const decoder = this.outputDecoders[stream]
		if (decoder) return decoder.write(data)

		const buffered = this.undecodedBuffers[stream].length === 0 ? data : Buffer.concat([this.undecodedBuffers[stream], data])
		this.undecodedBuffers[stream] = Buffer.alloc(0)

		if (buffered.every((byte) => byte < 0x80)) return buffered.toString("ascii")

		const utf8Status = this.getUtf8Status(buffered)
		if (utf8Status === "incomplete") {
			this.undecodedBuffers[stream] = buffered
			return ""
		}

		const encoding = utf8Status === "complete" ? "utf-8" : this.detectBufferEncoding(buffered)
		const selectedDecoder = iconv.getDecoder(encoding)
		this.outputDecoders[stream] = selectedDecoder
		return selectedDecoder.write(buffered)
	}

	private getUtf8Status(data: Buffer): "complete" | "incomplete" | "invalid" {
		try {
			StandaloneTerminalProcess.STRICT_UTF8_DECODER.decode(data)
			return "complete"
		} catch {
			for (let suffixLength = 1; suffixLength <= Math.min(3, data.length); suffixLength++) {
				const suffixStart = data.length - suffixLength
				try {
					StandaloneTerminalProcess.STRICT_UTF8_DECODER.decode(data.subarray(0, suffixStart))
				} catch {
					continue
				}
				if (this.isIncompleteUtf8Sequence(data.subarray(suffixStart))) return "incomplete"
			}
			return "invalid"
		}
	}

	private isIncompleteUtf8Sequence(data: Buffer): boolean {
		const lead = data[0]
		const expectedLength =
			lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0
		if (expectedLength === 0 || data.length >= expectedLength) return false
		for (let index = 1; index < data.length; index++) {
			if (data[index] < 0x80 || data[index] > 0xbf) return false
		}
		if (data.length >= 2) {
			const second = data[1]
			if (lead === 0xe0 && second < 0xa0) return false
			if (lead === 0xed && second > 0x9f) return false
			if (lead === 0xf0 && second < 0x90) return false
			if (lead === 0xf4 && second > 0x8f) return false
		}
		return true
	}

	/** Pick the lowest-loss legacy encoding, preferring the detected Windows code page on ties. */
	private detectBufferEncoding(data: Buffer): string {
		const detectedSystemEncoding = this.systemEncoding?.toLowerCase()
		const candidates = [
			"utf-8",
			...(detectedSystemEncoding && detectedSystemEncoding !== "utf-8" ? [detectedSystemEncoding] : []),
			...StandaloneTerminalProcess.CANDIDATE_ENCODINGS.filter(
				(encoding) => encoding !== "utf-8" && encoding !== detectedSystemEncoding,
			),
		]
		let bestEncoding = "utf-8"
		let bestScore = Number.POSITIVE_INFINITY
		for (const encoding of candidates) {
			try {
				const decoded = iconv.decode(data, encoding)
				const score = (decoded.match(/\ufffd/g) || []).length
				if (score < bestScore) {
					bestScore = score
					bestEncoding = encoding
					if (score === 0) break
				}
			} catch {
				// Ignore unsupported encodings and continue with the remaining candidates.
			}
		}
		return bestEncoding
	}

	/** Flush buffered bytes after the child stream closes. */
	private flushDecoder(stream: StandaloneOutputStream): string {
		let output = ""
		const pending = this.undecodedBuffers[stream]
		if (pending.length > 0) {
			this.undecodedBuffers[stream] = Buffer.alloc(0)
			const decoder = iconv.getDecoder(this.detectBufferEncoding(pending))
			this.outputDecoders[stream] = decoder
			output += decoder.write(pending)
		}
		output += this.outputDecoders[stream]?.end() ?? ""
		delete this.outputDecoders[stream]
		return output
	}

	/**
	 * Run a command in the terminal.
	 * @param terminal The terminal instance to run in
	 * @param command The command to execute
	 */
	async run(terminal: ITerminal, command: string): Promise<void> {
		// Get shell and working directory from terminal
		const shell = (terminal as any)._shellPath || this.getDefaultShell()
		const cwd = (terminal as any)._cwd || process.cwd()
		const environmentOverrides = ((terminal as any)._environment ?? {}) as Readonly<Record<string, string | null>>

		// Prepare command for execution
		const shellArgs = this.getShellArgs(shell, command)

		try {
			// Create shell options
			const childEnvironment: NodeJS.ProcessEnv = { ...process.env }
			for (const [name, value] of Object.entries(environmentOverrides)) {
				if (value === null) delete childEnvironment[name]
				else childEnvironment[name] = value
			}
			const shellOptions: {
				cwd: string
				stdio: ["ignore", "pipe", "pipe"]
				env: NodeJS.ProcessEnv
				shell?: boolean
			} = {
				cwd: cwd,
				stdio: ["ignore", "pipe", "pipe"], // Disable STDIN to prevent interactivity
				env: {
					...childEnvironment,
					TERM: "xterm-256color",
					PAGER: "cat", // Prevent less from being used, reducing interactivity
					EDITOR: process.env.EDITOR || "cat", // Set EDITOR if not already set
					GIT_PAGER: "cat", // Prevent git from using less
					SYSTEMD_PAGER: "", // Disable systemd pager
					MANPAGER: "cat", // Disable man pager
				},
			}

			// Enable the shell option for "cmd.exe" to prevent double quotes from being over escaped
			if (shell.toLowerCase().includes("cmd")) {
				shellOptions.shell = true

				// Spawn the process with special handling for "cmd.exe"
				this.childProcess = spawn("cmd.exe", shellArgs, shellOptions)
			} else {
				// POSIX uses a detached process group. Windows descendants are discovered
				// through the host-owned process-tree provider during cancellation.
				this.childProcess = spawn(shell, shellArgs, {
					...shellOptions,
					detached: process.platform !== "win32",
				})
			}
			this.resolveStarted?.(Date.now())
			this.resolveStarted = undefined

			// Track process state
			let didEmitEmptyLine = false

			// Handle stdout
			this.childProcess.stdout?.on("data", (data: Buffer) => {
				const output = this.decodeBuffer(data, "stdout")
				if (output) this.handleOutput(output, "stdout")
				if (!didEmitEmptyLine && output) {
					this.emit("line", "", "stdout") // Signal start of output
					didEmitEmptyLine = true
				}
			})

			// Handle stderr
			this.childProcess.stderr?.on("data", (data: Buffer) => {
				const output = this.decodeBuffer(data, "stderr")
				if (output) this.handleOutput(output, "stderr")
				if (!didEmitEmptyLine && output) {
					this.emit("line", "", "stderr")
					didEmitEmptyLine = true
				}
			})

			// Handle process completion
			this.childProcess.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
				this.exitCode = code
				this.signal = signal
				this.isCompleted = true
				for (const stream of ["stdout", "stderr"] as const) {
					const output = this.flushDecoder(stream)
					if (output) this.handleOutput(output, stream)
				}
				this.emitRemainingBuffers()

				// Clear hot timer
				if (this.hotTimer) {
					clearTimeout(this.hotTimer)
					this.isHot = false
				}

				// Track terminal execution telemetry with exit code for failure diagnosis
				const success = code === 0 || code === null
				telemetryService.captureTerminalExecution(success, "standalone", "child_process", code)

				this.emit("completed", { exitCode: this.exitCode, signal: this.signal })
				this.emit("continue")
			})

			// Handle process errors (spawn failures)
			this.childProcess.on("error", (error: Error) => {
				// Track terminal execution error telemetry
				// method: "child_process_error" already indicates spawn failure
				telemetryService.captureTerminalExecution(false, "standalone", "child_process_error")
				this.emit("error", error)
			})

			// Update terminal's process reference
			;(terminal as any)._process = this.childProcess
			;(terminal as any)._processId = this.childProcess.pid
		} catch (error) {
			this.emit("error", error)
		}
	}

	/**
	 * Handle output from the process.
	 * @param data The output data
	 * @param stream The child process pipe that produced the data.
	 */
	private handleOutput(data: string, stream: StandaloneOutputStream): void {
		// Set process as hot (actively outputting)
		this.isHot = true
		if (this.hotTimer) {
			clearTimeout(this.hotTimer)
		}

		// Check for compilation markers to adjust hot timeout
		const isCompiling = isCompilingOutput(data)
		const hotTimeout = isCompiling ? PROCESS_HOT_TIMEOUT_COMPILING : PROCESS_HOT_TIMEOUT_NORMAL
		this.hotTimer = setTimeout(() => {
			this.isHot = false
		}, hotTimeout)

		// Store full output with size cap to prevent memory exhaustion
		this.fullOutput += data

		// Cap fullOutput at MAX_FULL_OUTPUT_SIZE to prevent memory exhaustion
		if (this.fullOutput.length > MAX_FULL_OUTPUT_SIZE) {
			// Keep last half of max size
			this.fullOutput = this.fullOutput.slice(-MAX_FULL_OUTPUT_SIZE / 2)
			// Reset lastRetrievedIndex since we truncated the beginning
			this.lastRetrievedIndex = 0
		}

		if (this.isListening) {
			this.emitLines(data, stream)
		}
	}

	/**
	 * Emit lines from the buffer.
	 * @param chunk The chunk of data to process
	 */
	private emitLines(chunk: string, stream: StandaloneOutputStream): void {
		this.buffers[stream] += chunk
		let lineEndIndex: number
		while ((lineEndIndex = this.buffers[stream].indexOf("\n")) !== -1) {
			const line = this.buffers[stream].slice(0, lineEndIndex).trimEnd()
			this.emit("line", line, stream)
			this.buffers[stream] = this.buffers[stream].slice(lineEndIndex + 1)
		}
	}

	/**
	 * Emit any remaining content in both stream buffers.
	 */
	private emitRemainingBuffers(): void {
		for (const stream of ["stdout", "stderr"] as const) {
			if (this.buffers[stream] && this.isListening) {
				const remainingBuffer = this.removeLastLineArtifacts(this.buffers[stream])
				if (remainingBuffer) {
					this.emit("line", remainingBuffer, stream)
				}
				this.buffers[stream] = ""
			}
		}
		this.lastRetrievedIndex = this.fullOutput.length
	}

	/**
	 * Continue execution without waiting for completion.
	 * Emits "continue" event but keeps emitting "line" events for background tracking.
	 *
	 * Note: We intentionally do NOT call removeAllListeners("line") or set isListening=false
	 * because background command tracking needs to continue receiving output lines
	 * after the user clicks "Proceed While Running".
	 */
	pauseOutput(): void {
		if (this.outputPaused) return
		this.outputPaused = true
		this.childProcess?.stdout?.pause()
		this.childProcess?.stderr?.pause()
	}

	resumeOutput(): void {
		if (!this.outputPaused) return
		this.outputPaused = false
		this.childProcess?.stdout?.resume()
		this.childProcess?.stderr?.resume()
	}

	continue(): void {
		this.emitRemainingBuffers()
		// Keep isListening = true so we continue emitting "line" events
		// This is needed for background command tracking to log output to file
		this.emit("continue")
	}

	/**
	 * Get output that hasn't been retrieved yet.
	 * Truncates if output is too large to prevent context window overflow.
	 * @returns The unretrieved output (truncated if necessary)
	 */
	getUnretrievedOutput(): string {
		const unretrieved = this.fullOutput.slice(this.lastRetrievedIndex)
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

	/**
	 * Remove shell prompt artifacts from the end of output.
	 * @param output The output to clean
	 * @returns Cleaned output
	 */
	private removeLastLineArtifacts(output: string): string {
		const lines = output.trimEnd().split("\n")
		if (lines.length > 0) {
			const lastLine = lines[lines.length - 1]
			lines[lines.length - 1] = lastLine.replace(/[%$#>]\s*$/, "")
		}
		return lines.join("\n").trimEnd()
	}

	/**
	 * Get the default shell for the current platform.
	 * @returns The default shell path
	 */
	private getDefaultShell(): string {
		if (process.platform === "win32") {
			return WINDOWS_POWERSHELL_LEGACY_PATH
		}
		return process.env.SHELL || "/bin/bash"
	}

	/**
	 * Get shell arguments for executing a command.
	 * @param shell The shell path
	 * @param command The command to execute
	 * @returns Array of shell arguments
	 */
	private getShellArgs(shell: string, command: string): string[] {
		if (process.platform === "win32") {
			const normalizedShell = shell.toLowerCase()
			if (normalizedShell.includes("powershell") || normalizedShell.includes("pwsh")) {
				return ["-Command", StandaloneTerminalProcess.POWERSHELL_UTF8_PRELUDE + command]
			}
			// WSL and Git Bash already default to UTF-8, so they need no code page prelude.
			if (normalizedShell.includes("wsl")) return ["--exec", "bash", "-lc", command]
			if (normalizedShell.includes("bash")) return ["-l", "-c", command]
			return ["/c", StandaloneTerminalProcess.CMD_UTF8_PRELUDE + command]
		}
		// Use -l for login shell, -c for command
		return ["-l", "-c", command]
	}

	/**
	 * Terminate the process and all its children.
	 *
	 * Uses terminateProcessTree utility which handles:
	 * - Host-owned descendant discovery on Windows
	 * - Graceful SIGTERM and forceful SIGKILL escalation on POSIX
	 * - Bounded confirmation that owned processes and streams have closed
	 */
	async terminate(): Promise<void> {
		if (!this.childProcess || this.isCompleted) {
			return
		}

		const pid = this.childProcess.pid
		if (!pid) {
			// Fallback: try to kill the process directly if PID is unavailable
			this.childProcess.kill("SIGTERM")
			return
		}

		await terminateProcessTree({
			pid,
			childProcess: this.childProcess,
			isCompleted: () => this.isCompleted,
			windowsProcessTreeProvider: this.windowsProcessTreeProvider,
		})
	}
}
