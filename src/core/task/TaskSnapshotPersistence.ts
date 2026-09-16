import fs from "node:fs/promises"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { runWithSignalSpan, type SignalSpanHandle, startSignalSpan } from "@/services/telemetry/service/pipeline-port"
import { Logger } from "@/shared/services/Logger"
import type { TaskSnapshot } from "./TaskSnapshot"

const DEFAULT_FLUSH_INTERVAL_MS = 100
const SNAPSHOT_RENAME_MAX_ATTEMPTS = 3
const SNAPSHOT_RENAME_RETRY_DELAYS_MS = [10, 25] as const
const RETRYABLE_SNAPSHOT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"])

type RenameFile = (sourcePath: string, destinationPath: string) => Promise<void>

interface SnapshotRenameError extends NodeJS.ErrnoException {
	dest?: string
}

export interface RenameTaskSnapshotOptions {
	renameFile?: RenameFile
	sleep?: (delayMs: number) => Promise<void>
}

function snapshotRenameErrorDetails(error: unknown, sourcePath: string, destinationPath: string, attempt: number) {
	const nodeError = error as SnapshotRenameError | undefined
	return {
		code: nodeError?.code ?? "UNKNOWN",
		syscall: nodeError?.syscall ?? "rename",
		path: nodeError?.path ?? sourcePath,
		dest: nodeError?.dest ?? destinationPath,
		attempt,
	}
}

/**
 * Rename a completed task snapshot temp file into place.
 * Windows file locks can transiently reject replacement, so only the known
 * lock-related error codes are retried and the destination is never removed.
 */
export async function renameTaskSnapshotWithRetry(
	sourcePath: string,
	destinationPath: string,
	options: RenameTaskSnapshotOptions = {},
): Promise<void> {
	const renameFile = options.renameFile ?? fs.rename
	const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))

	for (let attempt = 1; attempt <= SNAPSHOT_RENAME_MAX_ATTEMPTS; attempt++) {
		try {
			await renameFile(sourcePath, destinationPath)
			return
		} catch (error) {
			const details = snapshotRenameErrorDetails(error, sourcePath, destinationPath, attempt)
			Logger.warn("[TaskSnapshotPersistence] Failed to rename task snapshot", details)
			if (!RETRYABLE_SNAPSHOT_RENAME_CODES.has(details.code) || attempt === SNAPSHOT_RENAME_MAX_ATTEMPTS) {
				throw error
			}
			await sleep(SNAPSHOT_RENAME_RETRY_DELAYS_MS[attempt - 1] ?? 0)
		}
	}
}

export interface TaskSnapshotPersistenceOptions {
	writeSnapshot: (snapshot: TaskSnapshot) => Promise<void>
	onSnapshot?: (stage: "scheduled" | "persisted" | "failed", snapshot: TaskSnapshot, error?: unknown) => void
	flushIntervalMs?: number
	setTimeoutFn?: typeof setTimeout
	clearTimeoutFn?: typeof clearTimeout
}

/**
 * Coalesces task snapshot.json writes while keeping the latest snapshot available for forced flushes.
 */
export class TaskSnapshotPersistence {
	private readonly writeSnapshot: (snapshot: TaskSnapshot) => Promise<void>
	private readonly flushIntervalMs: number
	private readonly setTimeoutFn: typeof setTimeout
	private readonly clearTimeoutFn: typeof clearTimeout
	private pendingSnapshot: TaskSnapshot | undefined
	private flushTimer: ReturnType<typeof setTimeout> | undefined
	private writeChain: Promise<void> = Promise.resolve()

	constructor(private readonly options: TaskSnapshotPersistenceOptions) {
		this.writeSnapshot = options.writeSnapshot
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
	}

	/**
	 * Schedule a snapshot.json write, coalescing multiple updates into one interval.
	 * @param snapshot Latest snapshot to persist.
	 */
	schedule(snapshot: TaskSnapshot): void {
		this.pendingSnapshot = snapshot
		this.observe("scheduled", snapshot)
		if (this.flushTimer) {
			return
		}
		this.flushTimer = this.setTimeoutFn(() => {
			this.flushTimer = undefined
			void this.flushNow()
		}, this.flushIntervalMs)
	}

	private observe(stage: "scheduled" | "persisted" | "failed", snapshot: TaskSnapshot, error?: unknown): void {
		try {
			this.options.onSnapshot?.(stage, snapshot, error)
		} catch {
			/* Preserve persistence semantics. */
		}
	}

	/**
	 * Immediately write the latest pending snapshot and cancel any scheduled timer.
	 */
	async flushNow(): Promise<void> {
		let traceSpan: SignalSpanHandle | undefined
		if (this.flushTimer) {
			this.clearTimeoutFn(this.flushTimer)
			this.flushTimer = undefined
		}
		const requestedAt = performance.now()
		const attempt = this.writeChain.then(async () => {
			const snapshot = this.pendingSnapshot
			if (!snapshot) return
			traceSpan = startSignalSpan({
				name: "task_snapshot.flush",
				startTime: requestedAt,
				attributes: snapshot.taskId ? { task_id: snapshot.taskId } : undefined,
			})
			// Callers await this flush inside runtime transitions, so separate the
			// wait behind earlier writes from the write itself: only the latter is
			// this snapshot's own disk cost.
			const queueMs = Math.round(performance.now() - requestedAt)
			const writeStartedAt = performance.now()

			try {
				await runWithSignalSpan(traceSpan, () => this.writeSnapshot(snapshot))
				this.observe("persisted", snapshot)
			} catch (error: unknown) {
				this.observe("failed", snapshot, error)
				throw error
			}
			if (this.pendingSnapshot === snapshot) {
				this.pendingSnapshot = undefined
			}
			const writeMs = Math.round(performance.now() - writeStartedAt)
			// Telemetry keeps the full distribution; the threshold only limits the
			// human-readable mirror to snapshots slow enough to be worth reading.
			recordPerfPhase(
				PerfDomain.TaskSnapshot,
				"flush_now",
				performance.now() - requestedAt,
				{ queueMs, writeMs },
				{ taskId: snapshot.taskId },
			)
			if (queueMs + writeMs >= 250 && Logger.isDebugEnabled()) {
				Logger.debug(
					`[TaskSnapshotPerf] phase=flush_now taskId=${snapshot.taskId} queueMs=${queueMs} writeMs=${writeMs} totalMs=${Math.round(performance.now() - requestedAt)}`,
				)
			}
		})
		// The caller still observes this attempt's failure, while the internal tail
		// remains usable so a later flush can retry the retained snapshot.
		this.writeChain = attempt.catch(() => undefined)
		try {
			await attempt
			traceSpan?.end("success")
		} catch (error) {
			traceSpan?.recordException(error)
			traceSpan?.end("failure")
			throw error
		}
	}
}
