import { randomUUID } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { normalizeRuntimeError } from "./error-normalizer"
import type { RuntimeOperationDescriptor } from "./operation-registry"

const LEGACY_SCHEMA_VERSION = 1 as const
const SCHEMA_VERSION = 2 as const
const HEARTBEAT_INTERVAL_MS = 10_000
const ACTIVE_HEARTBEAT_MS = 30_000
const REPORT_CLAIM_STALE_MS = 30_000
const REPORT_CLAIM_SEPARATOR = ".report-claim-"
const REPORT_LOCK_SUFFIX = ".report-lock"
const RETENTION_SUMMARY_FILE = ".retention-summary"
const MAX_LEDGER_FILES = 20
const MAX_ACTIVE_TASKS = 8
const MAX_ACTIVE_OPERATIONS = 16
const MAX_TASK_ID_LENGTH = 128
const MAX_PHASE_LENGTH = 64
let temporaryFileSequence = 0

export type RuntimeSessionStage = "activation_started" | "running" | "shutdown_started" | "deactivation_completed"

export interface RuntimeSessionActiveTask {
    readonly taskId: string
    readonly phase?: string
}

export interface RuntimeSessionHealth {
    readonly sampledAt: number
    readonly eventLoopDelayMs: number
    readonly cpuUtilizationRatio: number
    readonly heapUsedBytes: number
    readonly rssBytes: number
    readonly queueDepth: number
    readonly droppedEvents: number
}

export interface RuntimeSessionTerminationHint {
    readonly kind: "uncaught_exception" | "process_exit" | "process_exit_nonzero"
    readonly recordedAt: number
    readonly exitCode?: number
    readonly origin?: string
    readonly errorName?: string
    readonly errorCode?: string
    readonly errorFingerprint?: string
}

export interface RuntimeSessionLedgerDocumentV1 {
    readonly schemaVersion: typeof LEGACY_SCHEMA_VERSION
    readonly sessionId: string
    readonly pid: number
    readonly startedAt: number
    readonly heartbeatAt: number
    readonly stage?: string
    readonly deactivationCompletedAt?: number
    readonly reconciliationReportedAt?: number
}

export interface RuntimeSessionLedgerDocumentV2 {
    readonly schemaVersion: typeof SCHEMA_VERSION
    readonly sessionId: string
    readonly pid: number
    readonly startedAt: number
    readonly heartbeatAt: number
    readonly stage?: RuntimeSessionStage
    readonly activeTasks?: readonly RuntimeSessionActiveTask[]
    readonly activeTasksTruncated?: boolean
    readonly activeOperations?: readonly RuntimeOperationDescriptor[]
    readonly activeOperationsTruncated?: boolean
    readonly lastHealth?: RuntimeSessionHealth
    readonly terminationHint?: RuntimeSessionTerminationHint
    readonly deactivationCompletedAt?: number
    /** Terminal previous-session reconciliation has been admitted to consented telemetry. */
    readonly reconciliationReportedAt?: number
}

export type RuntimeSessionLedgerDocument = RuntimeSessionLedgerDocumentV1 | RuntimeSessionLedgerDocumentV2

export type RuntimeSessionHealthInput = Omit<RuntimeSessionHealth, "sampledAt">

export type PreviousSessionOutcome = "deactivation_completed" | "still_active" | "unclean_inferred" | "stale_unknown" | "corrupt"

export interface PreviousSessionReconciliation {
    readonly outcome: PreviousSessionOutcome
    readonly ageMs?: number
    readonly sessionId?: string
    readonly pid?: number
    readonly stage?: string
    readonly activeTasks?: readonly RuntimeSessionActiveTask[]
    readonly activeTasksTruncated?: boolean
    readonly activeOperations?: readonly RuntimeOperationDescriptor[]
    readonly activeOperationsTruncated?: boolean
    readonly lastHealth?: RuntimeSessionHealth
    readonly terminationHint?: RuntimeSessionTerminationHint
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
    readonly activeTaskIds?: () => readonly string[]
    readonly activeOperations?: () => readonly RuntimeOperationDescriptor[]
    readonly installProcessListeners?: boolean
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
    const metadata = previousSessionMetadata(input.document)
    if (input.document.deactivationCompletedAt !== undefined) {
        return {
            ...metadata,
            outcome: "deactivation_completed",
            ageMs: Math.max(0, input.now - input.document.deactivationCompletedAt),
        }
    }
    const ageMs = Math.max(0, input.now - input.document.heartbeatAt)
    if (input.processAlive === true && ageMs <= ACTIVE_HEARTBEAT_MS) {
        return { ...metadata, outcome: "still_active", ageMs }
    }
    if (input.processAlive === false) return { ...metadata, outcome: "unclean_inferred", ageMs }
    return { ...metadata, outcome: "stale_unknown", ageMs }
}

function previousSessionMetadata(
    document: RuntimeSessionLedgerDocument,
): Omit<PreviousSessionReconciliation, "outcome" | "ageMs"> {
    return {
        sessionId: document.sessionId,
        pid: document.pid,
        ...(document.stage === undefined ? {} : { stage: document.stage }),
        ...(document.schemaVersion === SCHEMA_VERSION && document.activeTasks
            ? { activeTasks: document.activeTasks.map((task) => ({ ...task })) }
            : {}),
        ...(document.schemaVersion === SCHEMA_VERSION && document.activeTasksTruncated !== undefined
            ? { activeTasksTruncated: document.activeTasksTruncated }
            : {}),
        ...(document.schemaVersion === SCHEMA_VERSION && document.activeOperations
            ? { activeOperations: document.activeOperations.map((operation) => ({ ...operation })) }
            : {}),
        ...(document.schemaVersion === SCHEMA_VERSION && document.activeOperationsTruncated !== undefined
            ? { activeOperationsTruncated: document.activeOperationsTruncated }
            : {}),
        ...(document.schemaVersion === SCHEMA_VERSION && document.lastHealth ? { lastHealth: { ...document.lastHealth } } : {}),
        ...(document.schemaVersion === SCHEMA_VERSION && document.terminationHint
            ? { terminationHint: { ...document.terminationHint } }
            : {}),
    }
}

function isNonNegativeFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength
}

function isStage(value: unknown): value is RuntimeSessionStage {
    return (
        value === "activation_started" ||
        value === "running" ||
        value === "shutdown_started" ||
        value === "deactivation_completed"
    )
}

function isActiveTask(value: unknown): value is RuntimeSessionActiveTask {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<RuntimeSessionActiveTask>
    return (
        isBoundedString(candidate.taskId, MAX_TASK_ID_LENGTH) &&
        (candidate.phase === undefined || isBoundedString(candidate.phase, MAX_PHASE_LENGTH))
    )
}

function isOperation(value: unknown): value is RuntimeOperationDescriptor {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<RuntimeOperationDescriptor>
    return (
        isBoundedString(candidate.operationId, 128) &&
        (candidate.kind === "api" ||
            candidate.kind === "tool" ||
            candidate.kind === "subagent" ||
            candidate.kind === "mcp_transport") &&
        isBoundedString(candidate.name, 128) &&
        isNonNegativeFinite(candidate.startedAt) &&
        (candidate.taskId === undefined || isBoundedString(candidate.taskId, MAX_TASK_ID_LENGTH))
    )
}

function isHealth(value: unknown): value is RuntimeSessionHealth {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<RuntimeSessionHealth>
    return (
        isNonNegativeFinite(candidate.sampledAt) &&
        isNonNegativeFinite(candidate.eventLoopDelayMs) &&
        isNonNegativeFinite(candidate.cpuUtilizationRatio) &&
        isNonNegativeFinite(candidate.heapUsedBytes) &&
        isNonNegativeFinite(candidate.rssBytes) &&
        Number.isSafeInteger(candidate.queueDepth) &&
        (candidate.queueDepth ?? -1) >= 0 &&
        Number.isSafeInteger(candidate.droppedEvents) &&
        (candidate.droppedEvents ?? -1) >= 0
    )
}

function isTerminationHint(value: unknown): value is RuntimeSessionTerminationHint {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<RuntimeSessionTerminationHint>
    return (
        (candidate.kind === "uncaught_exception" ||
            candidate.kind === "process_exit" ||
            candidate.kind === "process_exit_nonzero") &&
        isNonNegativeFinite(candidate.recordedAt) &&
        (candidate.exitCode === undefined || Number.isSafeInteger(candidate.exitCode)) &&
        (candidate.origin === undefined || isBoundedString(candidate.origin, 64)) &&
        (candidate.errorName === undefined || isBoundedString(candidate.errorName, 128)) &&
        (candidate.errorCode === undefined || isBoundedString(candidate.errorCode, 128)) &&
        (candidate.errorFingerprint === undefined || isBoundedString(candidate.errorFingerprint, 128))
    )
}

function hasValidBaseDocument(candidate: Record<string, unknown>): boolean {
    return (
        isBoundedString(candidate.sessionId, 256) &&
        Number.isSafeInteger(candidate.pid) &&
        (candidate.pid as number) > 0 &&
        isNonNegativeFinite(candidate.startedAt) &&
        isNonNegativeFinite(candidate.heartbeatAt) &&
        (candidate.deactivationCompletedAt === undefined || isNonNegativeFinite(candidate.deactivationCompletedAt)) &&
        (candidate.reconciliationReportedAt === undefined || isNonNegativeFinite(candidate.reconciliationReportedAt))
    )
}

function isDocument(value: unknown): value is RuntimeSessionLedgerDocument {
    if (!value || typeof value !== "object") return false
    const candidate = value as Record<string, unknown>
    if (!hasValidBaseDocument(candidate)) return false
    if (candidate.schemaVersion === LEGACY_SCHEMA_VERSION) {
        return candidate.stage === undefined || typeof candidate.stage === "string"
    }
    if (candidate.schemaVersion !== SCHEMA_VERSION) return false
    return (
        (candidate.stage === undefined || isStage(candidate.stage)) &&
        (candidate.activeTasks === undefined ||
            (Array.isArray(candidate.activeTasks) &&
                candidate.activeTasks.length <= MAX_ACTIVE_TASKS &&
                candidate.activeTasks.every(isActiveTask))) &&
        (candidate.activeTasksTruncated === undefined || typeof candidate.activeTasksTruncated === "boolean") &&
        (candidate.activeOperations === undefined ||
            (Array.isArray(candidate.activeOperations) &&
                candidate.activeOperations.length <= MAX_ACTIVE_OPERATIONS &&
                candidate.activeOperations.every(isOperation))) &&
        (candidate.activeOperationsTruncated === undefined || typeof candidate.activeOperationsTruncated === "boolean") &&
        (candidate.lastHealth === undefined || isHealth(candidate.lastHealth)) &&
        (candidate.terminationHint === undefined || isTerminationHint(candidate.terminationHint))
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
    private document: RuntimeSessionLedgerDocumentV2
    private heartbeatTimer?: NodeJS.Timeout
    private writeChain: Promise<void> = Promise.resolve()
    private pendingNonterminalReconciliations: PreviousSessionReconciliation[] = []
    private readonly pendingTerminalReconciliations = new Map<string, PendingTerminalReconciliation>()
    private readonly claimedTerminalReconciliations = new Map<string, ClaimedTerminalReconciliation>()
    private processListenersInstalled = false

    private readonly handleUncaughtExceptionMonitor = (error: Error, origin: string): void => {
        const normalized = normalizeRuntimeError(error)
        this.recordTerminationHint({
            kind: "uncaught_exception",
            recordedAt: this.now(),
            origin,
            errorName: normalized.name,
            ...(normalized.code === undefined ? {} : { errorCode: normalized.code }),
            errorFingerprint: normalized.fingerprint,
        })
    }

    private readonly handleProcessExit = (exitCode: number): void => {
        if (this.document.deactivationCompletedAt !== undefined) return
        if (this.document.terminationHint?.kind === "uncaught_exception") {
            this.persistSynchronously()
            return
        }
        this.recordTerminationHint({
            kind: exitCode === 0 ? "process_exit" : "process_exit_nonzero",
            recordedAt: this.now(),
            exitCode,
        })
    }

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
            stage: "activation_started",
        }
        this.refreshActiveTasks()
        this.refreshActiveOperations()
    }

    async startAndReconcile(): Promise<PreviousSessionReconciliation[]> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
        await this.recoverAbandonedClaims()
        const reconciliations = await this.reconcilePrevious()
        this.refreshHeartbeat()
        await this.persist()
        this.installProcessListeners()
        this.heartbeatTimer = setInterval(() => {
            this.refreshHeartbeat()
            void this.persist().catch(() => undefined)
        }, this.heartbeatIntervalMs)
        this.heartbeatTimer.unref?.()
        await this.enforceRetention().catch(() => undefined)
        return reconciliations
    }

    markStage(stage: RuntimeSessionStage): Promise<void> {
        this.refreshActiveTasks()
        this.document = { ...this.document, stage, heartbeatAt: this.now() }
        return this.persist()
    }

    updateHealth(health: RuntimeSessionHealthInput): void {
        const snapshot: RuntimeSessionHealth = { ...health, sampledAt: this.now() }
        if (!isHealth(snapshot)) return
        this.document = { ...this.document, lastHealth: snapshot }
    }

    recordTerminationHint(hint: RuntimeSessionTerminationHint): void {
        if (this.document.deactivationCompletedAt !== undefined || !isTerminationHint(hint)) return
        if (this.document.terminationHint?.kind === "uncaught_exception" && hint.kind !== "uncaught_exception") return
        this.document = { ...this.document, heartbeatAt: this.now(), terminationHint: { ...hint } }
        this.persistSynchronously()
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
        this.refreshActiveTasks()
        this.document = { ...this.document, stage: "deactivation_completed", heartbeatAt: now, deactivationCompletedAt: now }
        await this.persist()
        await this.writeChain
        this.uninstallProcessListeners()
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

    private refreshHeartbeat(): void {
        this.refreshActiveTasks()
        this.refreshActiveOperations()
        this.document = { ...this.document, heartbeatAt: this.now() }
    }

    private refreshActiveTasks(): void {
        let taskIds: readonly string[]
        try {
            taskIds = this.options.activeTaskIds?.() ?? []
        } catch {
            return
        }
        const unique = [...new Set(taskIds.filter((taskId) => isBoundedString(taskId, MAX_TASK_ID_LENGTH)))]
        this.document = {
            ...this.document,
            activeTasks: unique.slice(0, MAX_ACTIVE_TASKS).map((taskId) => ({ taskId })),
            ...(unique.length > MAX_ACTIVE_TASKS ? { activeTasksTruncated: true } : { activeTasksTruncated: false }),
        }
    }

    private refreshActiveOperations(): void {
        let operations: readonly RuntimeOperationDescriptor[]
        try {
            operations = this.options.activeOperations?.() ?? []
        } catch {
            return
        }
        const valid = operations.filter(isOperation)
        this.document = {
            ...this.document,
            activeOperations: valid.slice(0, MAX_ACTIVE_OPERATIONS).map((operation) => ({ ...operation })),
            activeOperationsTruncated: valid.length > MAX_ACTIVE_OPERATIONS,
        }
    }

    private installProcessListeners(): void {
        if (this.processListenersInstalled || this.options.installProcessListeners === false || this.pid !== process.pid) return
        process.on("uncaughtExceptionMonitor", this.handleUncaughtExceptionMonitor)
        process.on("exit", this.handleProcessExit)
        this.processListenersInstalled = true
    }

    private uninstallProcessListeners(): void {
        if (!this.processListenersInstalled) return
        process.off("uncaughtExceptionMonitor", this.handleUncaughtExceptionMonitor)
        process.off("exit", this.handleProcessExit)
        this.processListenersInstalled = false
    }

    private persistSynchronously(): void {
        const temporary = `${this.filePath}.tmp-${process.pid}-${++temporaryFileSequence}`
        try {
            fsSync.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
            fsSync.writeFileSync(temporary, JSON.stringify(this.document), { encoding: "utf8", mode: 0o600 })
            fsSync.renameSync(temporary, this.filePath)
        } catch {
            // A fatal-path breadcrumb is best-effort and must not replace the
            // process error that caused it.
        } finally {
            try {
                fsSync.rmSync(temporary, { force: true })
            } catch {
                // Ignore cleanup failures in a process termination path.
            }
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
