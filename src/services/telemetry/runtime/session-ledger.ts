import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const SCHEMA_VERSION = 1 as const
const HEARTBEAT_INTERVAL_MS = 10_000
const ACTIVE_HEARTBEAT_MS = 30_000
const REPORT_CLAIM_STALE_MS = 30_000
const REPORT_CLAIM_SEPARATOR = ".report-claim-"
const REPORT_LOCK_SUFFIX = ".report-lock"
const RETENTION_SUMMARY_FILE = ".retention-summary"
const MAX_LEDGER_FILES = 20
let temporaryFileSequence = 0

export interface RuntimeSessionLedgerDocument {
	schemaVersion: typeof SCHEMA_VERSION
	sessionId: string
	pid: number
	startedAt: number
	heartbeatAt: number
	stage?: string
	deactivationCompletedAt?: number
	/** Terminal previous-session reconciliation has been admitted to consented telemetry. */
	reconciliationReportedAt?: number
}

export type PreviousSessionOutcome = "deactivation_completed" | "still_active" | "unclean_inferred" | "stale_unknown" | "corrupt"

export interface PreviousSessionReconciliation {
	readonly outcome: PreviousSessionOutcome
	readonly ageMs?: number
}

interface PendingTerminalReconciliation {
	readonly kind: "document" | "corrupt"
	readonly reconciliation: PreviousSessionReconciliation
}

interface ClaimedTerminalReconciliation extends PendingTerminalReconciliation {
	readonly sourcePath: string
	readonly claimPath: string
	commitInFlight?: Promise<void>
}

interface ReportLockDocument {
	readonly pid: number
	readonly createdAt: number
}

export interface ClaimedPreviousSessionReconciliation extends PreviousSessionReconciliation {
	/** Persist that this consent-gated event was admitted. Safe to retry. */
	commit(): Promise<void>
}

export interface RuntimeSessionLedgerOptions {
	readonly dataDir: string
	readonly sessionId: string
	readonly now?: () => number
	readonly pid?: number
	readonly processAlive?: (pid: number) => boolean | undefined
	readonly heartbeatIntervalMs?: number
	/** Test seam for deterministic transient-write failures. */
	readonly writeDocument?: (filePath: string, document: RuntimeSessionLedgerDocument) => Promise<void>
}

function defaultProcessAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
		if (code === "ESRCH") return false
		if (code === "EPERM") return true
		return undefined
	}
}

export function classifyPreviousSession(input: {
	document: RuntimeSessionLedgerDocument
	now: number
	processAlive: boolean | undefined
}): PreviousSessionReconciliation {
	if (input.document.deactivationCompletedAt !== undefined) {
		return { outcome: "deactivation_completed", ageMs: Math.max(0, input.now - input.document.deactivationCompletedAt) }
	}
	const ageMs = Math.max(0, input.now - input.document.heartbeatAt)
	if (input.processAlive === true && ageMs <= ACTIVE_HEARTBEAT_MS) return { outcome: "still_active", ageMs }
	if (input.processAlive === false) return { outcome: "unclean_inferred", ageMs }
	return { outcome: "stale_unknown", ageMs }
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isDocument(value: unknown): value is RuntimeSessionLedgerDocument {
	if (!value || typeof value !== "object") return false
	const candidate = value as Partial<RuntimeSessionLedgerDocument>
	return (
		candidate.schemaVersion === SCHEMA_VERSION &&
		typeof candidate.sessionId === "string" &&
		candidate.sessionId.length > 0 &&
		Number.isSafeInteger(candidate.pid) &&
		(candidate.pid ?? 0) > 0 &&
		isNonNegativeFinite(candidate.startedAt) &&
		isNonNegativeFinite(candidate.heartbeatAt) &&
		(candidate.stage === undefined || typeof candidate.stage === "string") &&
		(candidate.deactivationCompletedAt === undefined || isNonNegativeFinite(candidate.deactivationCompletedAt)) &&
		(candidate.reconciliationReportedAt === undefined || isNonNegativeFinite(candidate.reconciliationReportedAt))
	)
}

function isTerminalOutcome(outcome: PreviousSessionOutcome): boolean {
	return outcome === "deactivation_completed" || outcome === "unclean_inferred" || outcome === "corrupt"
}

async function writeDocument(filePath: string, document: RuntimeSessionLedgerDocument): Promise<void> {
	const temporary = `${filePath}.tmp-${process.pid}-${++temporaryFileSequence}`
	try {
		await fs.writeFile(temporary, JSON.stringify(document), { encoding: "utf8", mode: 0o600 })
		await fs.rename(temporary, filePath)
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined)
	}
}

export class RuntimeSessionLedger {
	private readonly directory: string
	private readonly filePath: string
	private readonly now: () => number
	private readonly pid: number
	private readonly processAlive: (pid: number) => boolean | undefined
	private readonly heartbeatIntervalMs: number
	private readonly writeLedgerDocument: (filePath: string, document: RuntimeSessionLedgerDocument) => Promise<void>
	private document: RuntimeSessionLedgerDocument
	private heartbeatTimer?: NodeJS.Timeout
	private writeChain: Promise<void> = Promise.resolve()
	private pendingNonterminalReconciliations: PreviousSessionReconciliation[] = []
	private readonly pendingTerminalReconciliations = new Map<string, PendingTerminalReconciliation>()
	private readonly claimedTerminalReconciliations = new Map<string, ClaimedTerminalReconciliation>()

	constructor(private readonly options: RuntimeSessionLedgerOptions) {
		this.directory = path.join(options.dataDir, "runtime", "session-ledgers")
		this.filePath = path.join(this.directory, `${options.sessionId}.json`)
		this.now = options.now ?? Date.now
		this.pid = options.pid ?? process.pid
		this.processAlive = options.processAlive ?? defaultProcessAlive
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
		this.writeLedgerDocument = options.writeDocument ?? writeDocument
		const now = this.now()
		this.document = {
			schemaVersion: SCHEMA_VERSION,
			sessionId: options.sessionId,
			pid: this.pid,
			startedAt: now,
			heartbeatAt: now,
		}
	}

	async startAndReconcile(): Promise<PreviousSessionReconciliation[]> {
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
		await this.recoverAbandonedClaims()
		const reconciliations = await this.reconcilePrevious()
		await this.persist()
		this.heartbeatTimer = setInterval(() => {
			this.document = { ...this.document, heartbeatAt: this.now() }
			void this.persist().catch(() => undefined)
		}, this.heartbeatIntervalMs)
		this.heartbeatTimer.unref?.()
		await this.enforceRetention().catch(() => undefined)
		return reconciliations
	}

	markStage(stage: string): Promise<void> {
		this.document = { ...this.document, stage, heartbeatAt: this.now() }
		return this.persist()
	}

	/**
	 * Atomically claims reportable observations only after consent is enabled.
	 * A terminal claim is committed after the caller queues its event. If the
	 * process stops between those steps, the next activation may replay it rather
	 * than silently losing diagnostic evidence.
	 */
	async claimReconciliationsForReporting(): Promise<ClaimedPreviousSessionReconciliation[]> {
		const claimed: ClaimedPreviousSessionReconciliation[] = this.pendingNonterminalReconciliations.map((reconciliation) => ({
			...reconciliation,
			commit: async () => undefined,
		}))
		this.pendingNonterminalReconciliations = []

		for (const existing of this.claimedTerminalReconciliations.values()) {
			claimed.push(this.projectClaim(existing))
		}

		for (const [sourcePath, pending] of this.pendingTerminalReconciliations) {
			const terminalClaim = await this.claimTerminalReconciliation(sourcePath, pending)
			if (!terminalClaim) continue
			this.pendingTerminalReconciliations.delete(sourcePath)
			this.claimedTerminalReconciliations.set(terminalClaim.claimPath, terminalClaim)
			claimed.push(this.projectClaim(terminalClaim))
		}
		return claimed
	}

	async complete(): Promise<void> {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
		this.heartbeatTimer = undefined
		const now = this.now()
		this.document = { ...this.document, stage: "deactivation_completed", heartbeatAt: now, deactivationCompletedAt: now }
		await this.persist()
		await this.writeChain
	}

	private async reconcilePrevious(): Promise<PreviousSessionReconciliation[]> {
		const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => [])
		const results: PreviousSessionReconciliation[] = []
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === path.basename(this.filePath)) continue
			const filePath = path.join(this.directory, entry.name)
			let raw: string
			try {
				raw = await fs.readFile(filePath, "utf8")
			} catch {
				// Transient I/O and concurrent removal are not evidence of corruption.
				continue
			}

			let parsed: unknown
			try {
				parsed = JSON.parse(raw)
			} catch {
				const reconciliation = { outcome: "corrupt" } as const
				results.push(reconciliation)
				this.pendingTerminalReconciliations.set(filePath, { kind: "corrupt", reconciliation })
				continue
			}
			if (!isDocument(parsed)) {
				const reconciliation = { outcome: "corrupt" } as const
				results.push(reconciliation)
				this.pendingTerminalReconciliations.set(filePath, { kind: "corrupt", reconciliation })
				continue
			}
			if (parsed.reconciliationReportedAt !== undefined) continue

			let processAlive: boolean | undefined
			try {
				processAlive = this.processAlive(parsed.pid)
			} catch {
				processAlive = undefined
			}
			const reconciliation = classifyPreviousSession({ document: parsed, now: this.now(), processAlive })
			results.push(reconciliation)
			if (isTerminalOutcome(reconciliation.outcome)) {
				this.pendingTerminalReconciliations.set(filePath, { kind: "document", reconciliation })
			} else {
				this.pendingNonterminalReconciliations.push(reconciliation)
			}
		}
		return results
	}

	private async claimTerminalReconciliation(
		sourcePath: string,
		pending: PendingTerminalReconciliation,
	): Promise<ClaimedTerminalReconciliation | undefined> {
		const lockPath = `${sourcePath}${REPORT_LOCK_SUFFIX}`
		try {
			await fs.mkdir(lockPath, { mode: 0o700 })
			await fs.writeFile(
				path.join(lockPath, "owner.json"),
				JSON.stringify({ pid: this.pid, createdAt: this.now() } satisfies ReportLockDocument),
				{ encoding: "utf8", mode: 0o600, flag: "wx" },
			)
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
			if (code !== "EEXIST") await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
			return undefined
		}

		const claimPath = `${sourcePath}${REPORT_CLAIM_SEPARATOR}${this.pid}-${this.now()}-${randomUUID()}`
		try {
			await fs.rename(sourcePath, claimPath)
			return { ...pending, sourcePath, claimPath }
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
			if (code === "ENOENT") this.pendingTerminalReconciliations.delete(sourcePath)
			return undefined
		} finally {
			await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
		}
	}

	private projectClaim(claim: ClaimedTerminalReconciliation): ClaimedPreviousSessionReconciliation {
		return {
			...claim.reconciliation,
			commit: () => this.commitClaim(claim),
		}
	}

	private commitClaim(claim: ClaimedTerminalReconciliation): Promise<void> {
		if (claim.commitInFlight) return claim.commitInFlight
		const commit = (async () => {
			if (claim.kind === "corrupt") {
				await fs.rm(claim.claimPath, { force: true })
			} else {
				const raw = await fs.readFile(claim.claimPath, "utf8")
				const parsed: unknown = JSON.parse(raw)
				if (!isDocument(parsed)) throw new Error("Claimed runtime session ledger became invalid")
				await this.writeLedgerDocument(claim.claimPath, { ...parsed, reconciliationReportedAt: this.now() })
				await fs.rename(claim.claimPath, claim.sourcePath)
			}
			this.claimedTerminalReconciliations.delete(claim.claimPath)
			await this.enforceRetention().catch(() => undefined)
		})().finally(() => {
			if (claim.commitInFlight === commit) claim.commitInFlight = undefined
		})
		claim.commitInFlight = commit
		return commit
	}

	private async recoverAbandonedClaims(): Promise<void> {
		const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.endsWith(REPORT_LOCK_SUFFIX)) {
				const lockPath = path.join(this.directory, entry.name)
				const stat = await fs.stat(lockPath).catch(() => undefined)
				if (!stat) continue
				const ageMs = Math.max(0, this.now() - stat.mtimeMs)
				let ownerAlive: boolean | undefined
				try {
					const owner: unknown = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"))
					if (owner && typeof owner === "object") {
						const candidate = owner as Partial<ReportLockDocument>
						if (
							Number.isSafeInteger(candidate.pid) &&
							(candidate.pid ?? 0) > 0 &&
							isNonNegativeFinite(candidate.createdAt)
						) {
							ownerAlive = this.processAlive(candidate.pid as number)
						}
					}
				} catch {
					// An empty lock can exist only if its owner stopped between mkdir and owner write.
				}
				if (ownerAlive === false || (ownerAlive === undefined && ageMs > REPORT_CLAIM_STALE_MS)) {
					await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
				}
				continue
			}
			if (!entry.isFile()) continue
			const separatorIndex = entry.name.indexOf(REPORT_CLAIM_SEPARATOR)
			if (separatorIndex < 0) continue
			const sourcePath = path.join(this.directory, entry.name.slice(0, separatorIndex))
			const claimPath = path.join(this.directory, entry.name)
			const [rawPid, rawClaimedAt] = entry.name.slice(separatorIndex + REPORT_CLAIM_SEPARATOR.length).split("-", 3)
			const ownerPid = Number(rawPid)
			const claimedAt = Number(rawClaimedAt)
			if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !isNonNegativeFinite(claimedAt)) continue

			const ownerAlive = this.processAlive(ownerPid)
			if (ownerAlive === true || (ownerAlive === undefined && this.now() - claimedAt <= REPORT_CLAIM_STALE_MS)) continue
			try {
				await fs.access(sourcePath)
				await fs.rm(claimPath, { force: true })
				continue
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
				if (code !== "ENOENT") continue
			}
			await fs.rename(claimPath, sourcePath).catch(() => undefined)
		}
	}

	private persist(): Promise<void> {
		const snapshot = { ...this.document }
		const operation = this.writeChain.then(async () => {
			await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
			await this.writeLedgerDocument(this.filePath, snapshot)
		})
		// A transient failure is visible to this caller but cannot poison future writes.
		this.writeChain = operation.catch(() => undefined)
		return operation
	}

	private async enforceRetention(): Promise<void> {
		const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => [])
		const files = (
			await Promise.all(
				entries
					.filter(
						(entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== path.basename(this.filePath),
					)
					.map(async (entry) => {
						const filePath = path.join(this.directory, entry.name)
						let stat: Awaited<ReturnType<typeof fs.stat>>
						let raw: string
						try {
							;[stat, raw] = await Promise.all([fs.stat(filePath), fs.readFile(filePath, "utf8")])
						} catch {
							return undefined
						}
						try {
							const document: unknown = JSON.parse(raw)
							return {
								filePath,
								mtime: stat.mtimeMs,
								reported: isDocument(document) && document.reconciliationReportedAt !== undefined,
							}
						} catch {
							return { filePath, mtime: stat.mtimeMs, reported: false }
						}
					}),
			)
		).filter((file): file is { filePath: string; mtime: number; reported: boolean } => file !== undefined)

		let overflow = Math.max(0, files.length - (MAX_LEDGER_FILES - 1))
		if (overflow === 0) return
		const oldestFirst = [...files].sort((left, right) => left.mtime - right.mtime)
		const reported = oldestFirst.filter((file) => file.reported).slice(0, overflow)
		await Promise.all(reported.map((file) => fs.rm(file.filePath, { force: true })))
		overflow -= reported.length
		if (overflow === 0) return

		// A long-term opt-out cannot grow one file per extension session forever.
		// Preserve the newest evidence and aggregate how many older unreported
		// records were dropped without inventing a crash classification.
		const unreported = oldestFirst.filter((file) => !file.reported).slice(0, overflow)
		await Promise.all(unreported.map((file) => fs.rm(file.filePath, { force: true })))
		if (unreported.length > 0) await this.recordRetentionDrops(unreported.length)
	}

	private async recordRetentionDrops(count: number): Promise<void> {
		const summaryPath = path.join(this.directory, RETENTION_SUMMARY_FILE)
		let previousCount = 0
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(summaryPath, "utf8"))
			if (parsed && typeof parsed === "object" && "droppedUnreportedCount" in parsed) {
				const value = (parsed as { droppedUnreportedCount?: unknown }).droppedUnreportedCount
				if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) previousCount = value
			}
		} catch {
			// The summary is advisory; a missing or invalid one starts a fresh count.
		}
		const temporary = `${summaryPath}.tmp-${process.pid}-${++temporaryFileSequence}`
		try {
			await fs.writeFile(
				temporary,
				JSON.stringify({ schemaVersion: 1, droppedUnreportedCount: previousCount + count, updatedAt: this.now() }),
				{ encoding: "utf8", mode: 0o600 },
			)
			await fs.rename(temporary, summaryPath)
		} finally {
			await fs.rm(temporary, { force: true }).catch(() => undefined)
		}
	}
}
