import fs from "fs/promises"
import path from "path"
import type { HistoryItem } from "@/shared/HistoryItem"
import { ensureTaskDirectoryExists, GlobalFileNames } from "./disk"
import { decodeLegacyTaskCompletionSnapshot } from "./legacy/LegacyTaskCompletionSnapshot"

/** Completion verdict recovered from one Task's canonical snapshot. */
export interface RecoveredCompletion {
	isCompleted: boolean
}

/**
 * Read one Task's completion verdict from its canonical snapshot.
 *
 * `snapshot.json` is the same source the runtime projects from, so a repair
 * built on it agrees with what the Task itself would persist on reopen.
 *
 * @param taskId Task whose snapshot should be inspected.
 * @returns The verdict, or undefined when no readable snapshot exists.
 */
export async function readPersistedTaskCompletion(taskId: string): Promise<RecoveredCompletion | undefined> {
	let raw: string
	try {
		const taskDir = await ensureTaskDirectoryExists(taskId)
		raw = await fs.readFile(path.join(taskDir, GlobalFileNames.taskSnapshot), "utf8")
	} catch {
		// A Task without a snapshot carries no authoritative verdict.
		return undefined
	}

	try {
		return decodeLegacyTaskCompletionSnapshot(JSON.parse(raw))
	} catch {
		return undefined
	}
}

/** One completion projection patch collected by the scan. */
export interface CompletionRepair {
	taskId: string
	isCompleted: boolean
	revision: number
}

export interface TaskCompletionBackfillOptions {
	/** History rows to inspect, newest first. */
	listTasks(): Promise<HistoryItem[]>
	/**
	 * Read the canonical completion verdict of one Task.
	 *
	 * Returns undefined when the Task has no readable snapshot, which is not an
	 * error: such a Task simply has no authoritative verdict to project.
	 */
	readCompletion(taskId: string): Promise<RecoveredCompletion | undefined>
	/**
	 * Durably patch the collected projections in one batch transaction.
	 *
	 * Per-row durable commits turned a large history into hundreds of full-file
	 * rewrites under the cross-process lock, so the scan only collects in memory
	 * and commits once. Returns how many rows were actually rewritten; stale
	 * entries are skipped inside the batch.
	 */
	persistBatch(updates: readonly CompletionRepair[]): Promise<number>
	/** Notify that at least one projection changed, so caches and views can refresh. */
	onRepaired?(repairedCount: number): Promise<void> | void
	/** Yield between chunks so the scan cannot monopolize the event loop. */
	yieldBetweenChunks?(): Promise<void>
}

export interface TaskCompletionBackfillResult {
	scanned: number
	repaired: number
	failed: number
}

/** Rows examined before yielding control back to the event loop. */
const CHUNK_SIZE = 25

/**
 * Delay before the one-time repair scan starts.
 *
 * Activation, the first webview render and history compaction all compete for
 * IO right after launch, so the scan waits until that burst has settled.
 */
export const TASK_COMPLETION_BACKFILL_DELAY_MS = 15_000

/**
 * Current repair generation of the completion projection.
 *
 * Raise this whenever a newly fixed defect could have written wrong
 * projections, so histories repaired under an earlier generation are scanned
 * once more. The stored marker records the generation a history already
 * satisfies, which keeps the scan at most once per generation.
 *
 * 1: initial repair of histories that lost the projection on reopen.
 * 2: repair of histories whose projection was retracted when a finished Task
 *    was closed, because terminal phases were treated as "not completed".
 */
export const TASK_COMPLETION_BACKFILL_GENERATION = 2

/**
 * Repair task-history completion projections that earlier versions lost.
 *
 * A defect used to persist `isCompleted: false` whenever a finished Task was
 * reopened, so histories written by those versions carry wrong or missing
 * verdicts. Those rows cannot repair themselves: the projection is only
 * rewritten while a Task is open, so a task the user never reopens would keep
 * showing no checkmark forever.
 *
 * This scan runs off the startup path, reads each Task's canonical snapshot and
 * rewrites only the rows whose stored verdict disagrees with it. It never
 * invents a verdict: a Task without a readable snapshot is left untouched.
 */
export class TaskCompletionBackfill {
	constructor(private readonly options: TaskCompletionBackfillOptions) {}

	/**
	 * Scan the whole history once and repair disagreeing projections.
	 *
	 * The scan itself only reads snapshots and collects patches in memory; all
	 * durable work happens in one batch commit at the end.
	 *
	 * @returns Counts describing what the scan observed and changed.
	 */
	async run(): Promise<TaskCompletionBackfillResult> {
		const tasks = await this.options.listTasks()
		const result: TaskCompletionBackfillResult = { scanned: 0, repaired: 0, failed: 0 }
		const repairs: CompletionRepair[] = []

		for (let index = 0; index < tasks.length; index++) {
			if (index > 0 && index % CHUNK_SIZE === 0) {
				await this.yield()
			}
			result.scanned++
			try {
				const repair = await this.collectRepair(tasks[index])
				if (repair) repairs.push(repair)
			} catch {
				// One unreadable Task must not abort the whole scan; the row simply
				// keeps its current projection and can be repaired on a later run.
				result.failed++
			}
		}

		if (repairs.length > 0) {
			result.repaired = await this.options.persistBatch(repairs)
		}
		if (result.repaired > 0) {
			await this.options.onRepaired?.(result.repaired)
		}
		return result
	}

	/** Build one repair patch when the stored verdict disagrees with the snapshot. */
	private async collectRepair(item: HistoryItem): Promise<CompletionRepair | undefined> {
		const recovered = await this.options.readCompletion(item.id)
		if (!recovered) return undefined

		const storedRevision = item.completionStateRevision
		const stored = storedRevision === undefined ? undefined : item.isCompleted === true
		if (stored === recovered.isCompleted) return undefined

		// Stay above the stored watermark so the durable store cannot reject the
		// repair as stale.
		return { taskId: item.id, isCompleted: recovered.isCompleted, revision: (storedRevision ?? 0) + 1 }
	}

	private async yield(): Promise<void> {
		const yieldBetweenChunks = this.options.yieldBetweenChunks
		if (yieldBetweenChunks) {
			await yieldBetweenChunks()
			return
		}
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
}
