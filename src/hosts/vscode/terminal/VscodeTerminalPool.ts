import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import type { TerminalCompletionDetails, TerminalLaunchConfiguration } from "@/integrations/terminal/types"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import { recordDiagnostic } from "@/services/telemetry/instrumentation/diagnostic-recorder"
import { Logger } from "@/shared/services/Logger"
import { arePathsEqual } from "@/utils/path"
import type { TerminalInfo } from "./VscodeTerminalRegistry"

export const DEFAULT_TERMINAL_STANDBY_COUNT = 3

/**
 * Why the pool could not hand out a warm terminal.
 *
 * A bounded set, because the caller reports it as a metric dimension. It is
 * carried on the error itself rather than parsed back out of the message:
 * message text is free to change, and a reworded error would otherwise
 * silently collapse every reason to `unknown`.
 */
export type WarmAcquireFailureReason =
	/** The partition already has as many leases as it is allowed to hand out. */
	| "capacity_reached"
	/** The bounded wait for a warming terminal expired. */
	| "warm_timeout"
	/** A previous warm attempt failed and the backoff has not elapsed yet. */
	| "retry_pending"
	/** Nothing is ready and nothing is warming, so waiting would be pointless. */
	| "none_ready"
	/** The partition is shutting down. */
	| "partition_draining"
	/** The pool itself has been disposed. */
	| "pool_disposed"

/** An acquire failure that names its own reason. */
export class WarmAcquireFailure extends Error {
	constructor(
		readonly reason: WarmAcquireFailureReason,
		message: string,
	) {
		super(message)
		this.name = "WarmAcquireFailure"
	}
}

/**
 * Why a terminal that could have been reused was retired instead.
 *
 * A bounded set, because these values become metric labels. Callers supply the
 * release reason as free text, so it is mapped onto this set rather than
 * reported directly.
 */
type TerminalReuseRejectionReason =
	/** The terminal window was closed while the command was running. */
	| "terminal_disposed"
	/** No shell integration, so the exit code could not be trusted. */
	| "no_shell_integration"
	/** The process raised an error before it completed. */
	| "process_error"
	/** The caller reported the terminal as unhealthy without a known reason. */
	| "unhealthy"
	/** The partition was draining, so nothing may return to standby. */
	| "partition_draining"
	/** The terminal had already been closed by the time it was released. */
	| "terminal_closed"

const KNOWN_REUSE_REJECTION_REASONS = new Set<TerminalReuseRejectionReason>([
	"terminal_disposed",
	"no_shell_integration",
	"process_error",
])

function classifyReuseRejection(
	result: VscodeTerminalReleaseResult,
	draining: boolean,
	closed: boolean,
): TerminalReuseRejectionReason {
	// Ordered to match the disposal decision, so the reported reason is the one
	// that actually retired the terminal rather than a later coincidence.
	if (!result.healthy) {
		const reported = result.reason as TerminalReuseRejectionReason | undefined
		return reported !== undefined && KNOWN_REUSE_REJECTION_REASONS.has(reported) ? reported : "unhealthy"
	}
	if (draining) return "partition_draining"
	if (closed) return "terminal_closed"
	return "unhealthy"
}

export type VscodeTerminalPoolState = "warming" | "ready" | "leased" | "retiring" | "invalid" | "disposed"
export type VscodeTerminalReusePolicy = "reusable" | "consume"

export interface VscodeTerminalPoolPreparation {
	readonly cwd: string
	readonly workspaceRoot: string
	readonly profileId: string
	readonly shellPath?: string
	readonly configurationId?: string
	readonly environmentFingerprint: string
	readonly createLaunchConfiguration: () => TerminalLaunchConfiguration
}

export interface VscodeTerminalLease {
	readonly leaseId: string
	readonly partitionKey: string
	readonly terminalInfo: TerminalInfo
	readonly reusePolicy: VscodeTerminalReusePolicy
	readonly acquiredAt: number
}

export interface VscodeTerminalReleaseResult {
	readonly healthy: boolean
	readonly reason?: string
}

export interface VscodeTerminalPoolSnapshot {
	warming: number
	ready: number
	leased: number
	draining: boolean
}

interface TerminalProcessCompletionSink {
	setCompletionDetails(details: TerminalCompletionDetails): void
}

export interface VscodeTerminalPoolRuntime {
	createTerminal(
		cwd: string,
		shellPath: string | undefined,
		launchConfiguration: TerminalLaunchConfiguration | undefined,
	): TerminalInfo
	prepareTerminal?(
		terminal: TerminalInfo,
		preparation: VscodeTerminalPoolPreparation,
		launchConfiguration: TerminalLaunchConfiguration,
	): Promise<void>
	prepareCwd?(terminal: TerminalInfo, cwd: string): Promise<void>
	disposeTerminal(terminal: TerminalInfo): void
	isTerminalClosed(terminal: TerminalInfo): boolean
	onDidCloseTerminal(listener: (terminal: TerminalInfo["terminal"]) => void): { dispose(): void }
	onDidStartTerminalShellExecution?(
		listener: (event: { execution?: { read?: () => unknown } }) => void,
	): { dispose(): void } | undefined
	onDidEndTerminalShellExecution?(
		listener: (event: { terminal: TerminalInfo["terminal"]; exitCode: number | undefined }) => void,
	): { dispose(): void } | undefined
	setShellIntegrationTimeout?(timeoutMs: number): void
}

interface PooledTerminal {
	readonly terminalInfo: TerminalInfo
	readonly partitionKey: string
	readonly partition: TerminalPartition
	state: VscodeTerminalPoolState
	currentCwd: string
	userCommandCount: number
	createdAt: number
	activeLeaseId?: string
}

interface TerminalPartition {
	readonly key: string
	readonly scopeKey: string
	preparation: VscodeTerminalPoolPreparation
	readonly entries: Map<number, PooledTerminal>
	readonly stateWaiters: Set<() => void>
	draining: boolean
	lastActiveAt: number
	retryAttempt: number
	retryTimer?: NodeJS.Timeout
	ensurePromise?: Promise<void>
	warmDeadlineAt?: number
}

export interface VscodeTerminalPoolOptions {
	readonly targetStandby?: number
	readonly maxConcurrentLeases?: number
	readonly maxGlobalTerminals?: number
	readonly idlePartitionTtlMs?: number
	readonly cleanupIntervalMs?: number
	readonly retryDelaysMs?: readonly number[]
	/** Maximum time one acquire may wait for the first terminal in a warm batch to become ready. */
	readonly acquireWaitTimeoutMs?: number
}

export class VscodeTerminalPool {
	private readonly targetStandby: number
	private readonly maxConcurrentLeases: number
	private readonly maxGlobalTerminals: number
	private readonly idlePartitionTtlMs: number
	private readonly retryDelaysMs: readonly number[]
	private readonly hasExplicitAcquireWaitTimeout: boolean
	private acquireWaitTimeoutMs: number
	private readonly partitions = new Map<string, TerminalPartition>()
	private readonly leases = new Map<string, PooledTerminal>()
	private readonly processByTerminal = new Map<TerminalInfo["terminal"], TerminalProcessCompletionSink>()
	private readonly disposables: Array<{ dispose(): void }> = []
	private readonly cleanupTimer: NodeJS.Timeout
	private disposed = false

	constructor(
		private readonly runtime: VscodeTerminalPoolRuntime,
		options: VscodeTerminalPoolOptions = {},
	) {
		this.targetStandby = options.targetStandby ?? DEFAULT_TERMINAL_STANDBY_COUNT
		this.maxConcurrentLeases = options.maxConcurrentLeases ?? DEFAULT_TERMINAL_STANDBY_COUNT
		this.maxGlobalTerminals = options.maxGlobalTerminals ?? 24
		this.idlePartitionTtlMs = options.idlePartitionTtlMs ?? 10 * 60_000
		this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000, 30_000]
		this.hasExplicitAcquireWaitTimeout = options.acquireWaitTimeoutMs !== undefined
		this.acquireWaitTimeoutMs = options.acquireWaitTimeoutMs ?? 250
		this.disposables.push(runtime.onDidCloseTerminal((terminal) => this.handleTerminalClosed(terminal)))
		const startDisposable = runtime.onDidStartTerminalShellExecution?.((event) => event.execution?.read?.())
		if (startDisposable) this.disposables.push(startDisposable)
		const endDisposable = runtime.onDidEndTerminalShellExecution?.((event) => {
			this.processByTerminal.get(event.terminal)?.setCompletionDetails({ exitCode: event.exitCode })
		})
		if (endDisposable) this.disposables.push(endDisposable)
		this.cleanupTimer = setInterval(() => this.pruneIdlePartitions(), options.cleanupIntervalMs ?? 60_000)
		this.cleanupTimer.unref?.()
	}

	configureShellIntegrationTimeout(timeoutMs: number): void {
		this.runtime.setShellIntegrationTimeout?.(timeoutMs)
		if (!this.hasExplicitAcquireWaitTimeout) {
			this.acquireWaitTimeoutMs = Math.max(0, timeoutMs)
		}
	}

	registerProcess(terminalInfo: TerminalInfo, process: TerminalProcessCompletionSink): void {
		this.processByTerminal.set(terminalInfo.terminal, process)
	}

	unregisterProcess(terminalInfo: TerminalInfo, process: TerminalProcessCompletionSink): void {
		if (this.processByTerminal.get(terminalInfo.terminal) === process) this.processByTerminal.delete(terminalInfo.terminal)
	}

	getPartitionScopeKey(preparation: VscodeTerminalPoolPreparation): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					workspaceRoot: path.resolve(preparation.workspaceRoot),
					profileId: preparation.profileId,
					shellPath: preparation.shellPath ?? "",
				}),
			)
			.digest("hex")
			.slice(0, 16)
	}

	getPartitionKey(preparation: VscodeTerminalPoolPreparation): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					workspaceRoot: path.resolve(preparation.workspaceRoot),
					profileId: preparation.profileId,
					shellPath: preparation.shellPath ?? "",
					configurationId: preparation.configurationId ?? "",
					environmentFingerprint: preparation.environmentFingerprint,
				}),
			)
			.digest("hex")
			.slice(0, 16)
	}

	getPartitionSnapshot(preparation: VscodeTerminalPoolPreparation): VscodeTerminalPoolSnapshot {
		const partition = this.partitions.get(this.getPartitionKey(preparation))
		if (!partition) return { warming: 0, ready: 0, leased: 0, draining: false }
		return this.snapshot(partition)
	}

	ensureWarm(preparation: VscodeTerminalPoolPreparation): Promise<void> {
		if (this.disposed) return Promise.resolve()
		const partition = this.getOrCreatePartition(preparation)
		partition.lastActiveAt = Date.now()
		if (partition.retryTimer || partition.draining) return partition.ensurePromise ?? Promise.resolve()
		const desiredDeficit = Math.max(0, this.targetStandby - this.countStandby(partition))
		const deficit = Math.min(desiredDeficit, Math.max(0, this.maxGlobalTerminals - this.countGlobalTerminals()))
		if (deficit === 0) {
			if (desiredDeficit > 0) this.scheduleWarmRetry(partition)
			return partition.ensurePromise ?? Promise.resolve()
		}

		const startedAt = performance.now()
		partition.warmDeadlineAt = Date.now() + this.acquireWaitTimeoutMs
		const warming = Array.from({ length: deficit }, () => this.warmOne(partition))
		const pending = Promise.allSettled(warming).then(() => {
			if (partition.ensurePromise === pending) {
				partition.ensurePromise = undefined
				partition.warmDeadlineAt = undefined
			}
			const snapshot = this.snapshot(partition)
			if (snapshot.ready === this.targetStandby) partition.retryAttempt = 0
			else this.scheduleWarmRetry(partition)
			this.notifyPartitionStateChanged(partition)
			Logger.debug(
				`[TerminalPool] operation=ensureWarm partition=${partition.key} target=${this.targetStandby} durationMs=${Math.round(performance.now() - startedAt)} ready=${snapshot.ready} warming=${snapshot.warming}`,
			)
		})
		partition.ensurePromise = pending
		return pending
	}

	async acquire(
		preparation: VscodeTerminalPoolPreparation,
		cwd: string,
		reusePolicy: VscodeTerminalReusePolicy,
	): Promise<VscodeTerminalLease> {
		const startedAt = performance.now()
		const partition = this.getOrCreatePartition(preparation)
		partition.lastActiveAt = Date.now()
		if (this.countLeased(partition) >= this.maxConcurrentLeases) {
			throw new WarmAcquireFailure("capacity_reached", `Terminal partition lease capacity reached: ${partition.key}`)
		}
		let entry = this.selectReadyTerminal(partition, cwd, reusePolicy)
		if (!entry) {
			if (partition.retryTimer && !partition.ensurePromise) {
				throw new WarmAcquireFailure("retry_pending", `Terminal warming retry pending: ${partition.key}`)
			}
			if (!partition.ensurePromise) void this.ensureWarm(preparation)
			const deadlineAt = partition.warmDeadlineAt ?? Date.now() + this.acquireWaitTimeoutMs
			entry = await this.waitForReadyTerminal(partition, cwd, reusePolicy, deadlineAt)
		}
		if (!entry) throw new WarmAcquireFailure("none_ready", `No ready terminal available for partition ${partition.key}`)
		const sameCwd = arePathsEqual(entry.currentCwd, cwd)

		const leaseId = randomUUID()
		entry.state = "leased"
		entry.activeLeaseId = leaseId
		entry.userCommandCount++
		entry.terminalInfo.busy = true
		this.leases.set(leaseId, entry)

		if (!sameCwd) {
			try {
				await this.runtime.prepareCwd?.(entry.terminalInfo, cwd)
				entry.currentCwd = cwd
			} catch (error) {
				await this.invalidateEntry(entry, error instanceof Error ? error.message : String(error))
				throw error
			}
		}

		void this.ensureWarm(preparation)
		Logger.debug(
			`[TerminalPool] operation=acquire partition=${partition.key} terminalId=${entry.terminalInfo.id} policy=${reusePolicy} sameCwd=${sameCwd} durationMs=${Math.round(performance.now() - startedAt)} readyAfter=${this.snapshot(partition).ready}`,
		)
		return { leaseId, partitionKey: partition.key, terminalInfo: entry.terminalInfo, reusePolicy, acquiredAt: Date.now() }
	}

	async release(lease: VscodeTerminalLease, result: VscodeTerminalReleaseResult): Promise<void> {
		const startedAt = performance.now()
		const entry = this.leases.get(lease.leaseId)
		if (!entry || entry.activeLeaseId !== lease.leaseId) return
		this.leases.delete(lease.leaseId)
		entry.activeLeaseId = undefined
		entry.terminalInfo.busy = false
		const partition = entry.partition
		partition.lastActiveAt = Date.now()
		const draining = partition?.draining === true
		const closed = this.runtime.isTerminalClosed(entry.terminalInfo)
		const shouldDispose = !result.healthy || lease.reusePolicy === "consume" || draining || closed
		if (shouldDispose) {
			// A `consume` lease is always destroyed by contract, so reporting it
			// would drown the real signal: a terminal the pool expected to keep
			// and had to throw away instead.
			if (lease.reusePolicy === "reusable") {
				recordDiagnostic(DiagnosticDomain.Terminal, "reuse_rejected", DiagnosticOutcome.Degraded, {
					reason: classifyReuseRejection(result, draining, closed),
				})
			}
			await this.invalidateEntry(entry, result.reason ?? (lease.reusePolicy === "consume" ? "consumed" : "unhealthy"))
		} else {
			entry.state = "ready"
			entry.terminalInfo.lastActive = Date.now()
			this.trimExcessStandby(partition)
			this.notifyPartitionStateChanged(partition)
		}
		if (partition && !partition.draining) void this.ensureWarm(partition.preparation)
		Logger.debug(
			`[TerminalPool] operation=release partition=${entry.partitionKey} terminalId=${entry.terminalInfo.id} disposition=${shouldDispose ? "disposed" : "reusable"} durationMs=${Math.round(performance.now() - startedAt)} ready=${this.snapshot(partition).ready}`,
		)
	}

	drainAll(reason: string): { closedCount: number; busyTerminals: TerminalInfo[] } {
		let closedCount = 0
		const busyTerminals: TerminalInfo[] = []
		for (const partition of [...this.partitions.values()]) {
			const result = this.drainPartition(partition)
			closedCount += result.closedCount
			busyTerminals.push(...result.busyTerminals)
		}
		Logger.debug(`[TerminalPool] operation=drain reason=${reason} closed=${closedCount} leased=${busyTerminals.length}`)
		return { closedCount, busyTerminals }
	}

	pruneIdlePartitions(now = Date.now()): number {
		let closedCount = 0
		for (const partition of [...this.partitions.values()]) {
			if (this.countLeased(partition) > 0 || now - partition.lastActiveAt < this.idlePartitionTtlMs) continue
			closedCount += this.drainPartition(partition).closedCount
		}
		if (closedCount > 0) Logger.debug(`[TerminalPool] operation=pruneIdle closed=${closedCount}`)
		return closedCount
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		clearInterval(this.cleanupTimer)
		for (const disposable of this.disposables.splice(0)) disposable.dispose()
		const entries = new Set<PooledTerminal>()
		for (const partition of this.partitions.values()) {
			if (partition.retryTimer) clearTimeout(partition.retryTimer)
			for (const entry of partition.entries.values()) entries.add(entry)
		}
		for (const entry of this.leases.values()) entries.add(entry)
		for (const entry of entries) this.disposeEntry(entry)
		this.partitions.clear()
		this.leases.clear()
		this.processByTerminal.clear()
	}

	private getOrCreatePartition(preparation: VscodeTerminalPoolPreparation): TerminalPartition {
		const key = this.getPartitionKey(preparation)
		const scopeKey = this.getPartitionScopeKey(preparation)
		let partition = this.partitions.get(key)
		if (!partition) {
			for (const existing of [...this.partitions.values()]) {
				if (existing.scopeKey === scopeKey && existing.key !== key) this.drainPartition(existing)
			}
			partition = {
				key,
				scopeKey,
				preparation,
				entries: new Map(),
				stateWaiters: new Set(),
				draining: false,
				lastActiveAt: Date.now(),
				retryAttempt: 0,
			}
			this.partitions.set(key, partition)
		} else {
			partition.preparation = preparation
			partition.lastActiveAt = Date.now()
		}
		return partition
	}

	private async warmOne(partition: TerminalPartition): Promise<void> {
		const startedAt = performance.now()
		const preparation = partition.preparation
		const launchConfiguration = preparation.createLaunchConfiguration()
		const terminalInfo = this.runtime.createTerminal(preparation.cwd, preparation.shellPath, launchConfiguration)
		const entry: PooledTerminal = {
			terminalInfo,
			partitionKey: partition.key,
			partition,
			state: "warming",
			currentCwd: preparation.cwd,
			userCommandCount: 0,
			createdAt: Date.now(),
		}
		partition.entries.set(terminalInfo.id, entry)
		try {
			await this.runtime.prepareTerminal?.(terminalInfo, preparation, launchConfiguration)
			if (partition.draining || this.runtime.isTerminalClosed(terminalInfo)) {
				this.disposeEntry(entry)
				return
			}
			entry.state = "ready"
			terminalInfo.busy = false
			terminalInfo.lastCommand = ""
			this.trimExcessStandby(partition)
			this.notifyPartitionStateChanged(partition)
			Logger.debug(
				`[TerminalPool] operation=warm partition=${partition.key} terminalId=${terminalInfo.id} state=ready durationMs=${Math.round(performance.now() - startedAt)}`,
			)
		} catch (error) {
			await this.invalidateEntry(entry, error instanceof Error ? error.message : String(error))
			throw error
		}
	}

	private async invalidateEntry(entry: PooledTerminal, reason: string): Promise<void> {
		entry.state = "invalid"
		Logger.warn(
			`[TerminalPool] operation=invalidate partition=${entry.partitionKey} terminalId=${entry.terminalInfo.id} reason=${reason}`,
		)
		this.disposeEntry(entry)
	}

	private disposeEntry(entry: PooledTerminal): void {
		if (entry.state === "disposed") return
		entry.state = "disposed"
		entry.terminalInfo.busy = false
		this.leases.forEach((leasedEntry, leaseId) => {
			if (leasedEntry === entry) this.leases.delete(leaseId)
		})
		entry.partition.entries.delete(entry.terminalInfo.id)
		if (!this.runtime.isTerminalClosed(entry.terminalInfo)) this.runtime.disposeTerminal(entry.terminalInfo)
		this.notifyPartitionStateChanged(entry.partition)
	}

	private handleTerminalClosed(terminal: TerminalInfo["terminal"]): void {
		const activeEntry = [...this.partitions.values()]
			.flatMap((partition) => [...partition.entries.values()])
			.find((candidate) => candidate.terminalInfo.terminal === terminal)
		const entry =
			activeEntry ?? [...new Set(this.leases.values())].find((candidate) => candidate.terminalInfo.terminal === terminal)
		if (!entry) return
		const partition = entry.partition
		this.processByTerminal.delete(entry.terminalInfo.terminal)
		this.disposeEntry(entry)
		if (!partition.draining) void this.ensureWarm(partition.preparation)
	}

	private trimExcessStandby(partition: TerminalPartition): void {
		let excess = this.countStandby(partition) - this.targetStandby
		if (excess <= 0) return
		const candidates = [...partition.entries.values()]
			.filter((entry) => entry.state === "ready" && entry.userCommandCount === 0)
			.sort((left, right) => right.createdAt - left.createdAt)
		for (const candidate of candidates) {
			if (excess <= 0) break
			this.disposeEntry(candidate)
			excess--
		}
	}

	private drainPartition(partition: TerminalPartition): { closedCount: number; busyTerminals: TerminalInfo[] } {
		partition.draining = true
		this.notifyPartitionStateChanged(partition)
		this.partitions.delete(partition.key)
		if (partition.retryTimer) clearTimeout(partition.retryTimer)
		let closedCount = 0
		const busyTerminals: TerminalInfo[] = []
		for (const entry of [...partition.entries.values()]) {
			if (entry.state === "leased") {
				busyTerminals.push(entry.terminalInfo)
				continue
			}
			closedCount++
			this.disposeEntry(entry)
		}
		return { closedCount, busyTerminals }
	}

	private scheduleWarmRetry(partition: TerminalPartition): void {
		if (this.disposed || partition.draining || partition.retryTimer || this.countStandby(partition) >= this.targetStandby)
			return
		const delay = this.retryDelaysMs[Math.min(partition.retryAttempt, this.retryDelaysMs.length - 1)] ?? 30_000
		partition.retryAttempt++
		Logger.warn(
			`[TerminalPool] operation=retry partition=${partition.key} delayMs=${delay} attempt=${partition.retryAttempt}`,
		)
		partition.retryTimer = setTimeout(() => {
			partition.retryTimer = undefined
			void this.ensureWarm(partition.preparation)
		}, delay)
		partition.retryTimer.unref?.()
	}

	private selectReadyTerminal(
		partition: TerminalPartition,
		cwd: string,
		reusePolicy: VscodeTerminalReusePolicy,
	): PooledTerminal | undefined {
		const ready = [...partition.entries.values()].filter(
			(entry) =>
				entry.state === "ready" &&
				(reusePolicy === "reusable" || entry.userCommandCount === 0) &&
				!this.runtime.isTerminalClosed(entry.terminalInfo),
		)
		return ready.find((candidate) => arePathsEqual(candidate.currentCwd, cwd)) ?? ready[0]
	}

	private async waitForReadyTerminal(
		partition: TerminalPartition,
		cwd: string,
		reusePolicy: VscodeTerminalReusePolicy,
		deadlineAt: number,
	): Promise<PooledTerminal> {
		while (true) {
			if (this.disposed) throw new WarmAcquireFailure("pool_disposed", "Terminal pool is disposed")
			if (partition.draining) {
				throw new WarmAcquireFailure("partition_draining", `Terminal partition is draining: ${partition.key}`)
			}
			if (this.countLeased(partition) >= this.maxConcurrentLeases) {
				throw new WarmAcquireFailure("capacity_reached", `Terminal partition lease capacity reached: ${partition.key}`)
			}

			const ready = this.selectReadyTerminal(partition, cwd, reusePolicy)
			if (ready) return ready

			const snapshot = this.snapshot(partition)
			if (partition.retryTimer && !partition.ensurePromise && snapshot.warming === 0) {
				throw new WarmAcquireFailure("retry_pending", `Terminal warming retry pending: ${partition.key}`)
			}
			if (!partition.ensurePromise && snapshot.warming === 0) {
				throw new WarmAcquireFailure("none_ready", `No ready terminal available for partition ${partition.key}`)
			}

			const remainingMs = deadlineAt - Date.now()
			if (remainingMs <= 0) {
				throw new WarmAcquireFailure(
					"warm_timeout",
					`Terminal warm wait timed out after ${this.acquireWaitTimeoutMs}ms: ${partition.key}`,
				)
			}
			await this.waitForPartitionStateChange(partition, remainingMs)
		}
	}

	private waitForPartitionStateChange(partition: TerminalPartition, timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			let timeout: NodeJS.Timeout | undefined
			let settled = false
			const finish = (error?: Error) => {
				if (settled) return
				settled = true
				partition.stateWaiters.delete(onStateChanged)
				if (timeout) clearTimeout(timeout)
				if (error) reject(error)
				else resolve()
			}
			const onStateChanged = () => finish()
			partition.stateWaiters.add(onStateChanged)
			// This timer, not the deadline check in the acquire loop, is what
			// expires when nothing changes while waiting. Rejecting with a plain
			// Error here would leave the caller unable to name the reason, and
			// the resulting diagnostic would report `unknown` for the most
			// common warm miss there is.
			timeout = setTimeout(
				() =>
					finish(
						new WarmAcquireFailure(
							"warm_timeout",
							`Terminal warm wait timed out after ${this.acquireWaitTimeoutMs}ms: ${partition.key}`,
						),
					),
				timeoutMs,
			)
			timeout.unref?.()
		})
	}

	private notifyPartitionStateChanged(partition: TerminalPartition): void {
		for (const waiter of [...partition.stateWaiters]) waiter()
	}

	private countGlobalTerminals(): number {
		const entries = new Set<PooledTerminal>()
		for (const partition of this.partitions.values()) {
			for (const entry of partition.entries.values()) entries.add(entry)
		}
		for (const entry of this.leases.values()) entries.add(entry)
		return entries.size
	}

	private countLeased(partition: TerminalPartition): number {
		return [...partition.entries.values()].filter((entry) => entry.state === "leased").length
	}

	private countStandby(partition: TerminalPartition): number {
		return [...partition.entries.values()].filter((entry) => entry.state === "ready" || entry.state === "warming").length
	}

	private snapshot(partition: TerminalPartition): VscodeTerminalPoolSnapshot {
		const entries = [...partition.entries.values()]
		return {
			warming: entries.filter((entry) => entry.state === "warming").length,
			ready: entries.filter((entry) => entry.state === "ready").length,
			leased: entries.filter((entry) => entry.state === "leased").length,
			draining: partition.draining,
		}
	}
}
