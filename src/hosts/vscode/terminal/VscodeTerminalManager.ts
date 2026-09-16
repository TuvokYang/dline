import { arePathsEqual } from "@utils/path"
import { getShellForProfile } from "@utils/shell"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"
import { logShellEnvironmentDiagnostics } from "@/integrations/terminal/shell-environment"
import {
	TerminalInfo as ITerminalInfo,
	ITerminalManager,
	TerminalProcessResultPromise as ITerminalProcessResultPromise,
	TerminalLaunchConfiguration,
	TerminalManagerConfiguration,
	TerminalManagerConfigurationResult,
} from "@/integrations/terminal/types"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import { recordDiagnostic } from "@/services/telemetry/instrumentation/diagnostic-recorder"
import { markPerfPhase, recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"
import {
	type VscodeTerminalLease,
	VscodeTerminalPool,
	type VscodeTerminalPoolPreparation,
	WarmAcquireFailure,
	type WarmAcquireFailureReason,
} from "./VscodeTerminalPool"
import { mergePromise, VscodeTerminalProcess } from "./VscodeTerminalProcess"
import { TerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

/**
 * Map an acquire rejection onto a bounded reason.
 *
 * The reason travels on the error itself. Anything else reaching this layer is
 * an unexpected failure whose message is unbounded and must not become a
 * metric label, so it collapses to a single bucket.
 */
function classifyWarmAcquireFailure(error: unknown): WarmAcquireFailureReason | "unknown" {
	return error instanceof WarmAcquireFailure ? error.reason : "unknown"
}

/*
TerminalManager:
- Creates/reuses terminals
- Runs commands via runCommand(), returning a TerminalProcess
- Handles shell integration events

TerminalProcess extends EventEmitter and implements Promise:
- Emits 'line' events with output while promise is pending
- process.continue() resolves promise and stops event emission
- Allows real-time output handling or background execution

getUnretrievedOutput() fetches latest output for ongoing commands

Enables flexible command execution:
- Await for completion
- Listen to real-time events
- Continue execution in background
- Retrieve missed output later

Notes:
- it turns out some shellIntegration APIs are available on cursor, although not on older versions of vscode
- "By default, the shell integration script should automatically activate on supported shells launched from VS Code."
Supported shells:
Linux/macOS: bash, fish, pwsh, zsh
Windows: pwsh


Example:

const terminalManager = new TerminalManager(context);

// Run a command
const process = terminalManager.runCommand('npm install', '/path/to/project');

process.on('line', (line) => {
	Logger.log(line);
});

// To wait for the process to complete naturally:
await process;

// Or to continue execution even if the command is still running:
process.continue();

// Later, if you need to get the unretrieved output:
const unretrievedOutput = terminalManager.getUnretrievedOutput(terminalId);
Logger.log('Unretrieved output:', unretrievedOutput);

Resources:
- https://github.com/microsoft/vscode/issues/226655
- https://code.visualstudio.com/updates/v1_93#_terminal-shell-integration-api
- https://code.visualstudio.com/docs/terminal/shell-integration
- https://code.visualstudio.com/api/references/vscode-api#Terminal
- https://github.com/microsoft/vscode-extension-samples/blob/main/terminal-sample/src/extension.ts
- https://github.com/microsoft/vscode-extension-samples/blob/main/shell-integration-sample/src/extension.ts
*/

/*
The new shellIntegration API gives us access to terminal command execution output handling.
However, we don't update our VSCode type definitions or engine requirements to maintain compatibility
with older VSCode versions. Users on older versions will automatically fall back to using sendText
for terminal command execution.
Interestingly, some environments like Cursor enable these APIs even without the latest VSCode engine.
This approach allows us to leverage advanced features when available while ensuring broad compatibility.
*/
declare module "vscode" {
	// https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L7442
	interface Terminal {
		shellIntegration?: {
			cwd?: vscode.Uri
			executeCommand?: (command: string) => {
				read: () => AsyncIterable<string>
			}
		}
	}
	// https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L10794
	interface Window {
		onDidStartTerminalShellExecution?: (
			listener: (e: any) => any,
			thisArgs?: any,
			disposables?: vscode.Disposable[],
		) => vscode.Disposable
		onDidEndTerminalShellExecution?: (
			listener: (e: { terminal: vscode.Terminal; exitCode: number | undefined }) => any,
			thisArgs?: any,
			disposables?: vscode.Disposable[],
		) => vscode.Disposable
	}
}

export class VscodeTerminalManager implements ITerminalManager {
	private terminalIds: Set<number> = new Set()
	private processes: Map<number, VscodeTerminalProcess> = new Map()
	private disposables: vscode.Disposable[] = []
	private shellIntegrationTimeout = 4000
	private terminalReuseEnabled = true
	private terminalOutputLineLimit = 500
	private defaultTerminalProfile = "default"
	private hasAppliedConfiguration = false
	private readonly shellPathsByProfile = new Map<string, string | undefined>()
	private readonly leases = new Map<number, VscodeTerminalLease>()
	private readonly coldFallbackTerminalIds = new Set<number>()
	private readonly skipShellIntegrationWaitTerminalIds = new Set<number>()

	constructor(private readonly pool?: VscodeTerminalPool) {
		if (pool) return
		let disposable: vscode.Disposable | undefined
		try {
			disposable = (vscode.window as vscode.Window).onDidStartTerminalShellExecution?.(async (e) => {
				// Creating a read stream here results in a more consistent output. This is most obvious when running the `date` command.
				e?.execution?.read()
			})
		} catch (_error) {
			// Logger.error("Error setting up onDidEndTerminalShellExecution", error)
		}
		if (disposable) {
			this.disposables.push(disposable)
		}

		try {
			const completionDisposable = (vscode.window as vscode.Window).onDidEndTerminalShellExecution?.((event) => {
				const terminalInfo = this.findTerminalInfoByTerminal(event.terminal)
				if (!terminalInfo) return
				this.processes.get(terminalInfo.id)?.setCompletionDetails({ exitCode: event.exitCode })
			})
			if (completionDisposable) this.disposables.push(completionDisposable)
		} catch (error) {
			Logger.error("Error setting up onDidEndTerminalShellExecution", error)
		}

		// Add a listener for terminal state changes to detect CWD updates
		try {
			const stateChangeDisposable = vscode.window.onDidChangeTerminalState((terminal) => {
				const terminalInfo = this.findTerminalInfoByTerminal(terminal)
				if (terminalInfo?.pendingCwdChange && terminalInfo.cwdResolved) {
					// Check if CWD has been updated to match the expected path
					if (this.isCwdMatchingExpected(terminalInfo)) {
						const resolver = terminalInfo.cwdResolved.resolve
						terminalInfo.pendingCwdChange = undefined
						terminalInfo.cwdResolved = undefined
						resolver()
					}
				}
			})
			this.disposables.push(stateChangeDisposable)
		} catch (error) {
			Logger.error("Error setting up onDidChangeTerminalState", error)
		}
	}

	//Find a TerminalInfo by its VSCode Terminal instance
	private findTerminalInfoByTerminal(terminal: vscode.Terminal): TerminalInfo | undefined {
		const terminals = TerminalRegistry.getAllTerminals()
		return terminals.find((t) => t.terminal === terminal)
	}

	//Check if a terminal's CWD matches its expected pending change
	private isCwdMatchingExpected(terminalInfo: TerminalInfo): boolean {
		if (!terminalInfo.pendingCwdChange) {
			return false
		}

		const currentCwd = terminalInfo.terminal.shellIntegration?.cwd?.fsPath
		const targetCwd = vscode.Uri.file(terminalInfo.pendingCwdChange).fsPath

		if (!currentCwd) {
			return false
		}

		return arePathsEqual(currentCwd, targetCwd)
	}

	runCommand(terminalInfo: ITerminalInfo, command: string): ITerminalProcessResultPromise {
		// Cast to VSCode-specific TerminalInfo for internal use
		// Using unknown as intermediate cast due to structural differences between ITerminal and vscode.Terminal
		const vscodeTerminalInfo = terminalInfo as unknown as TerminalInfo
		const requestedAt = performance.now()
		let processStartedAt: number | undefined
		let processCapability = "pending"
		const startProcess = (capability: "shell_integration" | "cold_fallback" | "shell_wait") => {
			processCapability = capability
			processStartedAt = performance.now()
			recordPerfPhase(PerfDomain.Terminal, "process_start", processStartedAt - requestedAt, {
				terminalId: vscodeTerminalInfo.id,
				capability,
			})
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[TerminalPerf] phase=process_start terminalId=${vscodeTerminalInfo.id} capability=${capability} waitMs=${Math.round(processStartedAt - requestedAt)}`,
				)
			}
			process.run(vscodeTerminalInfo.terminal, command)
		}

		vscodeTerminalInfo.busy = true
		vscodeTerminalInfo.lastCommand = command
		const process = new VscodeTerminalProcess()
		this.processes.set(vscodeTerminalInfo.id, process)
		this.pool?.registerProcess(vscodeTerminalInfo, process)

		process.once("completed", () => {
			const executionMs = processStartedAt === undefined ? 0 : Math.round(performance.now() - processStartedAt)
			recordPerfPhase(PerfDomain.Terminal, "process_complete", performance.now() - requestedAt, {
				terminalId: vscodeTerminalInfo.id,
				capability: processCapability,
				executionMs,
			})
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[TerminalPerf] phase=process_complete terminalId=${vscodeTerminalInfo.id} capability=${processCapability} durationMs=${Math.round(performance.now() - requestedAt)} executionMs=${executionMs}`,
				)
			}
			vscodeTerminalInfo.busy = false
			this.pool?.unregisterProcess(vscodeTerminalInfo, process)
			void this.releaseLease(
				vscodeTerminalInfo.id,
				vscodeTerminalInfo.terminal.shellIntegration?.executeCommand !== undefined && !process.wasTerminalDisposed(),
				process.wasTerminalDisposed() ? "terminal_disposed" : undefined,
			)
			this.disposeColdFallback(vscodeTerminalInfo)
		})

		// if shell integration is not available, remove terminal so it does not get reused as it may be running a long-running process
		process.once("no_shell_integration", () => {
			recordPerfPhase(PerfDomain.Terminal, "capability_failure", performance.now() - requestedAt, {
				terminalId: vscodeTerminalInfo.id,
				capability: "no_shell_integration",
			})
			// The timing above says how long the wait cost; this says what the
			// system lost. Without shell integration there is no authoritative
			// exit code, so the terminal is retired instead of reused.
			recordDiagnostic(DiagnosticDomain.Terminal, "shell_integration_unavailable", DiagnosticOutcome.Degraded, {
				terminalId: vscodeTerminalInfo.id,
			})
			Logger.warn(
				`[TerminalPerf] phase=capability_failure terminalId=${vscodeTerminalInfo.id} capability=no_shell_integration durationMs=${Math.round(performance.now() - requestedAt)}`,
			)
			this.pool?.unregisterProcess(vscodeTerminalInfo, process)
			void this.releaseLease(vscodeTerminalInfo.id, false, "no_shell_integration")
			TerminalRegistry.removeTerminal(vscodeTerminalInfo.id)
			this.terminalIds.delete(vscodeTerminalInfo.id)
			this.processes.delete(vscodeTerminalInfo.id)
		})

		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", () => {
				resolve()
			})
			process.once("error", (error) => {
				Logger.error(`Error in terminal ${vscodeTerminalInfo.id}:`, error)
				this.pool?.unregisterProcess(vscodeTerminalInfo, process)
				void this.releaseLease(vscodeTerminalInfo.id, false, "process_error")
				reject(error)
			})
		})

		// A cold fallback is created only after the pool has already spent its bounded
		// warm-acquire budget. Do not pay the same shell-integration wait again.
		const skipShellIntegrationWait = this.skipShellIntegrationWaitTerminalIds.delete(vscodeTerminalInfo.id)
		// if shell integration is already active, run the command immediately
		if (vscodeTerminalInfo.terminal.shellIntegration?.executeCommand || skipShellIntegrationWait) {
			process.waitForShellIntegration = false
			startProcess(skipShellIntegrationWait ? "cold_fallback" : "shell_integration")
		} else {
			// A legacy non-pool terminal may still acquire shell integration shortly after creation.
			markPerfPhase(PerfDomain.Terminal, "shell_wait_start", {
				terminalId: vscodeTerminalInfo.id,
				timeoutMs: this.shellIntegrationTimeout,
			})
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[TerminalPerf] phase=shell_wait_start terminalId=${vscodeTerminalInfo.id} timeoutMs=${this.shellIntegrationTimeout}`,
				)
			}
			pWaitFor(() => vscodeTerminalInfo.terminal.shellIntegration !== undefined, {
				timeout: this.shellIntegrationTimeout,
			})
				.then(() => {
					recordPerfPhase(PerfDomain.Terminal, "shell_wait_complete", performance.now() - requestedAt, {
						terminalId: vscodeTerminalInfo.id,
						outcome: "available",
					})
					if (Logger.isDebugEnabled()) {
						Logger.debug(
							`[TerminalPerf] phase=shell_wait_complete terminalId=${vscodeTerminalInfo.id} durationMs=${Math.round(performance.now() - requestedAt)} outcome=available`,
						)
					}
				})
				.catch(() => {
					recordPerfPhase(PerfDomain.Terminal, "shell_wait_complete", performance.now() - requestedAt, {
						terminalId: vscodeTerminalInfo.id,
						outcome: "timeout",
					})
					Logger.warn(
						`[TerminalPerf] phase=shell_wait_complete terminalId=${vscodeTerminalInfo.id} durationMs=${Math.round(performance.now() - requestedAt)} outcome=timeout`,
					)
				})
				.finally(() => {
					const existingProcess = this.processes.get(vscodeTerminalInfo.id)
					if (existingProcess?.waitForShellIntegration) {
						existingProcess.waitForShellIntegration = false
						startProcess("shell_wait")
					}
				})
		}

		return mergePromise(process, promise)
	}

	async getOrCreateTerminal(cwd: string, launchConfiguration?: TerminalLaunchConfiguration): Promise<ITerminalInfo> {
		const preparation = this.createPoolPreparation(cwd, launchConfiguration)
		let forceColdCreate = false
		if (this.pool && preparation) {
			try {
				const lease = await this.pool.acquire(preparation, cwd, this.terminalReuseEnabled ? "reusable" : "consume")
				this.leases.set(lease.terminalInfo.id, lease)
				this.terminalIds.add(lease.terminalInfo.id)
				// A warm hit costs orders of magnitude less than a cold start, so
				// the caller has to be able to separate the two when it measures
				// how long acquiring a terminal took.
				lease.terminalInfo.acquisitionSource = "warm_pool"
				return lease.terminalInfo as unknown as ITerminalInfo
			} catch (error) {
				forceColdCreate = true
				// The pool exists and was asked for a terminal but could not
				// supply one, so this command pays the full cold start. Without
				// this the fallback was visible only in a log line, which left
				// the warm pool's hit rate unmeasurable.
				recordDiagnostic(DiagnosticDomain.Terminal, "warm_pool_miss", DiagnosticOutcome.Degraded, {
					reason: classifyWarmAcquireFailure(error),
				})
				Logger.warn("[TerminalPool] operation=fallback reason=warm_acquire_failed")
			}
		}

		const terminals = forceColdCreate ? [] : TerminalRegistry.getAllTerminals()
		const expectedShellPath = this.getConfiguredShellPath(this.defaultTerminalProfile)
		const expectedConfigurationId = launchConfiguration?.configurationId

		// Find available terminal from our pool first (created for this task).
		// Workspace paths identify the user's machine, so only counts are logged.
		Logger.log(`[TerminalManager] Looking for a terminal among ${terminals.length} available`)

		const matchingTerminal = terminals.find((t) => {
			if (t.busy) {
				Logger.log(`[TerminalManager] Terminal ${t.id} is busy, skipping`)
				return false
			}
			// Check if shell path matches current configuration
			if (t.shellPath !== expectedShellPath) {
				return false
			}
			if (t.configurationId !== expectedConfigurationId) return false
			const terminalCwd = t.terminal.shellIntegration?.cwd // one of cline's commands could have changed the cwd of the terminal
			if (!terminalCwd) {
				Logger.log(`[TerminalManager] Terminal ${t.id} has no cwd, skipping`)
				return false
			}
			const matches = arePathsEqual(vscode.Uri.file(cwd).fsPath, terminalCwd.fsPath)
			Logger.log(`[TerminalManager] Terminal ${t.id} cwd matches: ${matches}`)
			return matches
		})
		if (matchingTerminal) {
			Logger.log(`[TerminalManager] Found matching terminal ${matchingTerminal.id} in correct cwd`)
			this.terminalIds.add(matchingTerminal.id)
			matchingTerminal.acquisitionSource = "registry_reuse"
			// Cast to ITerminalInfo for interface compatibility
			return matchingTerminal as unknown as ITerminalInfo
		}

		// If no non-busy terminal in the current working dir exists and terminal reuse is enabled, try to find any non-busy terminal regardless of CWD
		if (this.terminalReuseEnabled) {
			const availableTerminal = terminals.find(
				(t) => !t.busy && t.shellPath === expectedShellPath && t.configurationId === expectedConfigurationId,
			)
			if (availableTerminal) {
				// Set up promise and tracking for CWD change
				const cwdPromise = new Promise<void>((resolve, reject) => {
					availableTerminal.pendingCwdChange = cwd
					availableTerminal.cwdResolved = { resolve, reject }
				})

				// Navigate back to the desired directory
				// Cast to ITerminalInfo for interface compatibility
				const cdProcess = this.runCommand(availableTerminal as unknown as ITerminalInfo, `cd "${cwd}"`)

				// Wait for the cd command to complete before proceeding
				await cdProcess

				// Add a small delay to ensure terminal is ready after cd
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Either resolve immediately if CWD already updated or wait for event/timeout
				if (this.isCwdMatchingExpected(availableTerminal)) {
					if (availableTerminal.cwdResolved) {
						availableTerminal.cwdResolved.resolve()
					}
					availableTerminal.pendingCwdChange = undefined
					availableTerminal.cwdResolved = undefined
				} else {
					try {
						// Wait with a timeout for state change event to resolve
						await Promise.race([
							cwdPromise,
							new Promise<void>((_, reject) =>
								setTimeout(() => reject(new Error(`CWD timeout: Failed to update to ${cwd}`)), 1000),
							),
						])
					} catch (_err) {
						// Clear pending state on timeout
						availableTerminal.pendingCwdChange = undefined
						availableTerminal.cwdResolved = undefined
					}
				}
				this.terminalIds.add(availableTerminal.id)
				availableTerminal.acquisitionSource = "registry_reuse"
				// Cast to ITerminalInfo for interface compatibility
				return availableTerminal as unknown as ITerminalInfo
			}
		}

		// If all terminals are busy or don't match shell profile, create a new one with the configured shell
		const newTerminalInfo = TerminalRegistry.createTerminal(cwd, expectedShellPath, launchConfiguration)
		this.terminalIds.add(newTerminalInfo.id)
		newTerminalInfo.acquisitionSource = "cold_start"
		if (launchConfiguration?.initializationCommand) {
			try {
				await this.runCommand(newTerminalInfo as unknown as ITerminalInfo, launchConfiguration.initializationCommand)
			} catch (error) {
				newTerminalInfo.busy = false
				Logger.error("[ShellEnvironment] Failed to initialize a new VS Code terminal", error)
			} finally {
				newTerminalInfo.lastCommand = ""
				if (launchConfiguration.initializationDiagnosticsPath) {
					await logShellEnvironmentDiagnostics(launchConfiguration.initializationDiagnosticsPath)
				}
			}
		}
		if (forceColdCreate) {
			this.coldFallbackTerminalIds.add(newTerminalInfo.id)
			this.skipShellIntegrationWaitTerminalIds.add(newTerminalInfo.id)
		}
		// Cast to ITerminalInfo for interface compatibility
		return newTerminalInfo as unknown as ITerminalInfo
	}

	async ensureWarm(cwd: string, launchConfiguration?: TerminalLaunchConfiguration): Promise<void> {
		const preparation = this.createPoolPreparation(cwd, launchConfiguration)
		if (this.pool && preparation) await this.pool.ensureWarm(preparation)
	}

	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		return Array.from(this.terminalIds)
			.map((id) => TerminalRegistry.getTerminal(id))
			.filter((t): t is TerminalInfo => t !== undefined && t.busy === busy)
			.map((t) => ({ id: t.id, lastCommand: t.lastCommand }))
	}

	getUnretrievedOutput(terminalId: number): string {
		if (!this.terminalIds.has(terminalId)) {
			return ""
		}
		const process = this.processes.get(terminalId)
		return process ? process.getUnretrievedOutput() : ""
	}

	isProcessHot(terminalId: number): boolean {
		const process = this.processes.get(terminalId)
		return process ? process.isHot : false
	}

	disposeAll() {
		// for (const info of this.terminals) {
		// 	//info.terminal.dispose() // dont want to dispose terminals when task is aborted
		// }
		this.terminalIds.clear()
		this.processes.clear()
		this.disposables.forEach((disposable) => disposable.dispose())
		this.disposables = []
	}

	configure(configuration: TerminalManagerConfiguration): TerminalManagerConfigurationResult {
		const isInitialConfiguration = !this.hasAppliedConfiguration && this.terminalIds.size === 0 && this.leases.size === 0
		this.shellIntegrationTimeout = configuration.shellIntegrationTimeout
		this.pool?.configureShellIntegrationTimeout(configuration.shellIntegrationTimeout)
		this.terminalReuseEnabled = configuration.terminalReuseEnabled
		this.terminalOutputLineLimit = configuration.terminalOutputLineLimit
		const result = isInitialConfiguration
			? this.applyInitialTerminalProfile(configuration.defaultTerminalProfile)
			: this.configureDefaultTerminalProfile(configuration.defaultTerminalProfile)
		this.hasAppliedConfiguration = true
		return result
	}

	getConfiguration(): TerminalManagerConfiguration {
		return Object.freeze({
			shellIntegrationTimeout: this.shellIntegrationTimeout,
			terminalReuseEnabled: this.terminalReuseEnabled,
			terminalOutputLineLimit: this.terminalOutputLineLimit,
			defaultTerminalProfile: this.defaultTerminalProfile,
		})
	}

	reinitializeTerminals(): TerminalManagerConfigurationResult {
		if (this.pool) {
			const result = this.pool.drainAll("manual_reinitialize")
			return { closedCount: result.closedCount, busyTerminals: result.busyTerminals as unknown as ITerminalInfo[] }
		}
		const busyTerminals = this.filterTerminals((terminal) => terminal.busy)
		const closedCount = this.closeTerminals((terminal) => !terminal.busy)
		return { closedCount, busyTerminals: busyTerminals as unknown as ITerminalInfo[] }
	}

	public processOutput(outputLines: string[], overrideLimit?: number): string {
		const limit = overrideLimit !== undefined ? overrideLimit : this.terminalOutputLineLimit
		if (outputLines.length > limit) {
			const halfLimit = Math.floor(limit / 2)
			const start = outputLines.slice(0, halfLimit)
			const end = outputLines.slice(outputLines.length - halfLimit)
			return `${start.join("\n")}\n... (output truncated) ...\n${end.join("\n")}`.trim()
		}
		return outputLines.join("\n").trim()
	}

	private configureDefaultTerminalProfile(profileId: string): TerminalManagerConfigurationResult {
		// Only handle terminal change if profile actually changed
		if (this.defaultTerminalProfile === profileId) {
			return { closedCount: 0, busyTerminals: [] }
		}

		const _oldProfileId = this.defaultTerminalProfile
		this.defaultTerminalProfile = profileId
		if (this.pool) {
			const result = this.pool.drainAll("profile_changed")
			return { closedCount: result.closedCount, busyTerminals: result.busyTerminals }
		}

		// Get the shell path for the new profile
		const newShellPath = this.getConfiguredShellPath(profileId)

		// Handle terminal management for the profile change
		const result = this.handleTerminalProfileChange(newShellPath)

		// Update lastActive for any remaining terminals
		const allTerminals = TerminalRegistry.getAllTerminals()
		allTerminals.forEach((terminal) => {
			if (terminal.shellPath !== newShellPath) {
				TerminalRegistry.updateTerminal(terminal.id, { lastActive: Date.now() })
			}
		})

		return result
	}

	private applyInitialTerminalProfile(profileId: string): TerminalManagerConfigurationResult {
		this.defaultTerminalProfile = profileId
		return { closedCount: 0, busyTerminals: [] }
	}

	private createPoolPreparation(
		cwd: string,
		launchConfiguration?: TerminalLaunchConfiguration,
	): VscodeTerminalPoolPreparation | undefined {
		if (
			!launchConfiguration?.workspaceRoot ||
			!launchConfiguration.profileId ||
			!launchConfiguration.environmentFingerprint
		) {
			return undefined
		}
		return {
			cwd,
			workspaceRoot: launchConfiguration.workspaceRoot,
			profileId: launchConfiguration.profileId,
			shellPath: this.getConfiguredShellPath(launchConfiguration.profileId),
			configurationId: launchConfiguration.configurationId,
			environmentFingerprint: launchConfiguration.environmentFingerprint,
			createLaunchConfiguration: () => {
				const initialization = launchConfiguration.createInitialization?.()
				return {
					...launchConfiguration,
					createInitialization: undefined,
					initializationCommand: initialization?.command ?? launchConfiguration.initializationCommand,
					initializationDiagnosticsPath:
						initialization?.diagnosticsPath ?? launchConfiguration.initializationDiagnosticsPath,
				}
			},
		}
	}

	private async releaseLease(terminalId: number, healthy: boolean, reason?: string): Promise<void> {
		const lease = this.leases.get(terminalId)
		if (!lease || !this.pool) return
		this.leases.delete(terminalId)
		await this.pool.release(lease, { healthy, reason })
	}

	private disposeColdFallback(terminalInfo: TerminalInfo): void {
		if (!this.coldFallbackTerminalIds.delete(terminalInfo.id)) return
		this.skipShellIntegrationWaitTerminalIds.delete(terminalInfo.id)
		terminalInfo.terminal.dispose()
		TerminalRegistry.removeTerminal(terminalInfo.id)
		this.terminalIds.delete(terminalInfo.id)
		this.processes.delete(terminalInfo.id)
	}

	/** Resolve the shell path Dline owns for a profile without changing non-Windows default behavior. */
	private getConfiguredShellPath(profileId: string): string | undefined {
		if (this.shellPathsByProfile.has(profileId)) return this.shellPathsByProfile.get(profileId)
		const shellPath = profileId === "default" && process.platform !== "win32" ? undefined : getShellForProfile(profileId)
		this.shellPathsByProfile.set(profileId, shellPath)
		return shellPath
	}

	/**
	 * Filters terminals based on a provided criteria function
	 * @param filterFn Function that accepts TerminalInfo and returns boolean
	 * @returns Array of terminals that match the criteria
	 */
	filterTerminals(filterFn: (terminal: TerminalInfo) => boolean): TerminalInfo[] {
		const terminals = TerminalRegistry.getAllTerminals()
		return terminals.filter(filterFn)
	}

	/**
	 * Closes terminals that match the provided criteria
	 * @param filterFn Function that accepts TerminalInfo and returns boolean for terminals to close
	 * @param force If true, closes even busy terminals (with warning)
	 * @returns Number of terminals closed
	 */
	closeTerminals(filterFn: (terminal: TerminalInfo) => boolean, force = false): number {
		const terminalsToClose = this.filterTerminals(filterFn)
		let closedCount = 0

		for (const terminalInfo of terminalsToClose) {
			// Skip busy terminals unless force is true
			if (terminalInfo.busy && !force) {
				continue
			}

			// Remove from our tracking
			if (this.terminalIds.has(terminalInfo.id)) {
				this.terminalIds.delete(terminalInfo.id)
			}
			this.processes.delete(terminalInfo.id)

			// Dispose the actual terminal
			terminalInfo.terminal.dispose()

			// Remove from registry
			TerminalRegistry.removeTerminal(terminalInfo.id)

			closedCount++
		}

		return closedCount
	}

	/**
	 * Handles terminal management when the terminal profile changes
	 * @param newShellPath New shell path to use
	 * @returns Object with information about closed terminals and remaining busy terminals
	 */
	handleTerminalProfileChange(newShellPath: string | undefined): {
		closedCount: number
		busyTerminals: TerminalInfo[]
	} {
		// Close non-busy terminals with different shell path
		const closedCount = this.closeTerminals((terminal) => !terminal.busy && terminal.shellPath !== newShellPath, false)

		// Get remaining busy terminals with different shell path
		const busyTerminals = this.filterTerminals((terminal) => terminal.busy && terminal.shellPath !== newShellPath)

		return {
			closedCount,
			busyTerminals,
		}
	}

	/**
	 * Forces closure of all terminals (including busy ones)
	 * @returns Number of terminals closed
	 */
	closeAllTerminals(): number {
		return this.closeTerminals(() => true, true)
	}
}
