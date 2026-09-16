import chokidar, { FSWatcher } from "chokidar"
import deepEqual from "fast-deep-equal"
import { HistoryItem } from "@/shared/HistoryItem"
import { Logger } from "@/shared/services/Logger"
import type { UnifyStore, UnifyStoreDatabase } from "./backend/api/UnifyStore"
import { desc, eq } from "./backend/api/UnifyStoreQuery"
import { SqliteUnifyStoreBackend } from "./backend/sqlite/SqliteUnifyStore"
import { type TaskCompletionProjection, TaskHistoryRow } from "./entities/TaskHistoryRow"

export interface TaskCompletionStateUpdate {
	taskId: string
	isCompleted: boolean
	revision: number
}

/**
 * Decide whether a completion update supersedes the projection already stored.
 *
 * A lower or equal revision is stale, and a repeated verdict carries no new
 * information; rejecting both keeps the durable value monotonic and avoids
 * rewriting a row that would not change.
 */
function supersedes(current: TaskCompletionProjection | undefined, update: TaskCompletionStateUpdate): boolean {
	if (!current) return true
	return update.revision > current.revision && update.isCompleted !== current.isCompleted
}

/**
 * Quiet period before a disk change is pulled into the current process.
 *
 * Every window watches the same database, so a burst of writes would otherwise
 * make each window re-read and re-publish the whole history repeatedly.
 */
const RELOAD_COALESCE_DELAY_MS = 250

/**
 * Task history store backed by `taskHistory.db`.
 *
 * The task id is the store's primary key, so a task has exactly one row by
 * construction and reads never have to reconcile superseded revisions. There is
 * one database per user; the instance is created and owned by StateManager,
 * which passes it to consumers as needed.
 */
export class TaskHistory {
	private _watcher: FSWatcher | null = null
	private _onChangeCallbacks: Array<() => void | Promise<void>> = []
	private _reloadTimer: NodeJS.Timeout | null = null
	private _reloadInFlight: Promise<void> | null = null
	private _reloadRequestedWhileInFlight = false
	/**
	 * Tail of writes still settling in the background.
	 *
	 * Metadata updates sit on the UI hot path, so `upsertTaskHistory` returns as
	 * soon as the write is queued and `flush` joins the tail when a caller needs
	 * durability.
	 */
	private _pendingWrite: Promise<void> = Promise.resolve()
	/**
	 * Rows staged by a queued write that has not settled yet.
	 *
	 * `upsertTaskHistory` hands its caller the staged row before the
	 * transaction commits, so a read that goes straight to disk can still
	 * observe the previous value. Keeping the staged row here lets a reader
	 * overlay what this process has already promised.
	 */
	private readonly stagedWrites = new Map<string, { item: HistoryItem; sequence: number }>()
	/** Tells a settled write apart from a later one that superseded it. */
	private stagedWriteSequence = 0

	constructor(
		private readonly store: UnifyStore<TaskHistoryRow>,
		private readonly database?: UnifyStoreDatabase,
	) {}

	/**
	 * Register a callback invoked when the history changes on disk, for example
	 * from another window. Returns a disposal function.
	 */
	onChange(cb: () => void | Promise<void>): () => void {
		this._onChangeCallbacks.push(cb)
		return () => {
			const idx = this._onChangeCallbacks.indexOf(cb)
			if (idx >= 0) this._onChangeCallbacks.splice(idx, 1)
		}
	}

	// ── Read ──

	/** Return every entry, newest first. */
	async getAll(): Promise<HistoryItem[]> {
		const { records } = await this.store.query({ orderBy: [desc(TaskHistoryRow.storage.fields.ts)] })
		return records.map((row) => row.toHistoryItem())
	}

	/**
	 * Return every entry, newest first.
	 *
	 * The task id is the primary key, so the result is deduplicated by
	 * construction. The name is kept because callers depend on it.
	 */
	async getDeduplicated(): Promise<HistoryItem[]> {
		return await this.getAll()
	}

	/**
	 * Return every entry, newest first, including writes still settling here.
	 *
	 * A caller refreshing from a disk change needs this rather than
	 * `getDeduplicated`. The change that woke it is not necessarily the only
	 * write in flight, and rebuilding a cache from disk alone would roll back
	 * a row this process already handed to its own callers.
	 */
	async getDeduplicatedWithPendingWrites(): Promise<HistoryItem[]> {
		const committed = await this.getAll()
		if (this.stagedWrites.size === 0) return committed
		const pending = new Map([...this.stagedWrites].map(([id, entry]) => [id, entry.item]))
		const merged = committed.map((item) => {
			const staged = pending.get(item.id)
			if (!staged) return item
			pending.delete(item.id)
			return staged
		})
		// A task whose first write has not landed yet is absent from disk, so
		// it has to be added rather than substituted.
		for (const item of pending.values()) merged.push(item)
		// Sorted unconditionally rather than only when a row was added: `ts` is
		// the time of the latest activity, so a staged row that replaced an
		// existing one has very likely moved. Returning the disk order would
		// hand the caller a sequence that contradicts what every other read of
		// this store promises.
		return merged.sort((left, right) => right.ts - left.ts)
	}

	/** Return the most recent N entries. */
	async getRecent(limit: number): Promise<HistoryItem[]> {
		if (limit <= 0) return []
		const { records } = await this.store.query({
			orderBy: [desc(TaskHistoryRow.storage.fields.ts)],
			limit,
		})
		return records.map((row) => row.toHistoryItem())
	}

	/** Look up a single entry by task id. */
	async getById(id: string): Promise<HistoryItem | undefined> {
		return (await this.findRow(id))?.toHistoryItem()
	}

	// ── Write ──

	/**
	 * Insert or update one entry with a single durable transaction.
	 *
	 * The completion projection is owned by `setCompletionState`, so an incoming
	 * item cannot establish or retract one: a metadata update may be built from a
	 * snapshot older than a completion already recorded by this or another window.
	 */
	async upsert(item: HistoryItem): Promise<HistoryItem> {
		return await this.store.transaction(async (transaction) => {
			const rows = await transaction.query({ where: eq(TaskHistoryRow.storage.fields.id, item.id) })
			const row = TaskHistoryRow.fromHistoryItem(item, rows[0]?.completionProjection())
			// Every durable message boundary republishes the whole row, so most
			// updates carry no change at all. Writing one anyway rewrites the
			// entire table, and the resulting database change wakes this
			// process's own watcher, which republishes state to every
			// controller. Comparing inside the transaction keeps that decision
			// against the same committed state the write would have replaced.
			const existingItem = rows[0]?.toHistoryItem()
			const nextItem = row.toHistoryItem()
			if (existingItem && isSameHistoryItem(existingItem, nextItem)) return existingItem
			await transaction.replaceAll([...(await transaction.query()).filter((candidate) => candidate.id !== item.id), row])
			return nextItem
		})
	}

	/**
	 * Toggle the favorite status of a task.
	 *
	 * @returns The new favorite status, or undefined when the task is unknown.
	 */
	async toggleFavorite(id: string): Promise<boolean | undefined> {
		const current = await this.getById(id)
		if (!current) return undefined
		const updated = { ...current, isFavorited: !current.isFavorited }
		await this.upsert(updated)
		return updated.isFavorited
	}

	/** Delete one task by id. */
	async softDelete(id: string): Promise<void> {
		await this.store.transaction(async (transaction) => {
			const remaining = (await transaction.query()).filter((row) => row.id !== id)
			await transaction.replaceAll(remaining)
		})
	}

	/**
	 * Delete every task except those marked as favorite.
	 *
	 * @returns Number of deleted tasks.
	 */
	async deleteAllExceptFavorites(): Promise<number> {
		return await this.store.transaction(async (transaction) => {
			const all = await transaction.query()
			const favorited = all.filter((row) => row.isFavorited)
			await transaction.replaceAll(favorited)
			return all.length - favorited.length
		})
	}

	/** Clear all task history. */
	async clearAll(): Promise<void> {
		await this.store.replaceAll([])
	}

	/**
	 * Replace the whole index with the supplied entries.
	 *
	 * The history is a derived index over `tasks/<id>/`, so rebuilding it is a
	 * wholesale replacement rather than a merge: entries missing from `items` are
	 * meant to disappear. Duplicate ids would violate the primary key, so the
	 * last occurrence wins, matching the append-order semantics of the sources
	 * this rebuild reads from.
	 */
	async replaceAllItems(items: readonly HistoryItem[]): Promise<HistoryItem[]> {
		const rowsById = new Map<string, TaskHistoryRow>()
		for (const item of items) {
			rowsById.set(item.id, TaskHistoryRow.fromHistoryItem(item))
		}
		const rows = [...rowsById.values()]
		await this.store.replaceAll(rows)
		return rows.map((row) => row.toHistoryItem())
	}

	/** Update metadata for one task. */
	async updateMetadata(item: HistoryItem): Promise<void> {
		await this.upsert(item)
	}

	/**
	 * Durably patch one completion projection without touching unrelated metadata.
	 *
	 * The read-compare-write runs inside one transaction so a concurrent window
	 * cannot interleave between the staleness check and the write.
	 *
	 * @returns The rewritten entry, or undefined when the update was rejected.
	 */
	async setCompletionState(update: TaskCompletionStateUpdate): Promise<HistoryItem | undefined> {
		const [applied] = await this.setCompletionStates([update])
		return applied
	}

	/**
	 * Durably patch many completion projections in one transaction.
	 *
	 * Committing each repaired row separately turned a large history into one
	 * full transaction per row, which is why the backfill batches them.
	 *
	 * @param updates Projection patches to apply; stale entries are skipped.
	 * @returns The entries that were actually rewritten.
	 */
	async setCompletionStates(updates: readonly TaskCompletionStateUpdate[]): Promise<HistoryItem[]> {
		if (updates.length === 0) return []
		return await this.store.transaction(async (transaction) => {
			const rowsById = new Map((await transaction.query()).map((row) => [row.id, row]))
			const applied: HistoryItem[] = []
			for (const update of updates) {
				const current = rowsById.get(update.taskId)
				if (!current || !supersedes(current.completionProjection(), update)) continue
				const updated = current.withCompletion({ isCompleted: update.isCompleted, revision: update.revision })
				rowsById.set(update.taskId, updated)
				applied.push(updated.toHistoryItem())
			}
			if (applied.length > 0) await transaction.replaceAll([...rowsById.values()])
			return applied
		})
	}

	/**
	 * Queue an upsert and return the entry that will be persisted.
	 *
	 * Callers on the UI hot path must not wait for the durable write, so the
	 * transaction settles in the background and `flush` joins it.
	 */
	async upsertTaskHistory(item: HistoryItem): Promise<HistoryItem> {
		// Registered before the first await. The caller has already accepted
		// this item into its own cache, and the store serializes operations, so
		// a refresh that starts during the lookup below would otherwise read
		// committed rows without seeing that this write exists and would
		// publish a cache that rolls the item back.
		const sequence = ++this.stagedWriteSequence
		this.stagedWrites.set(item.id, { item, sequence })
		const existing = await this.findRow(item.id)
		const staged = TaskHistoryRow.fromHistoryItem(item, existing?.completionProjection()).toHistoryItem()
		// Replaced with the reconciled row once the completion projection is
		// known: an incoming item cannot establish or retract one, so the
		// provisional entry above may carry a stale verdict.
		if (this.stagedWrites.get(item.id)?.sequence === sequence) {
			this.stagedWrites.set(item.id, { item: staged, sequence })
		}
		this.trackWrite(this.upsert(item).finally(() => this.releaseStagedWrite(item.id, sequence)))
		return staged
	}

	/**
	 * Drop a staged row once its own write settled.
	 *
	 * A later write for the same task supersedes this one while remaining
	 * uncommitted itself, so only a matching sequence may clear the entry.
	 */
	private releaseStagedWrite(id: string, sequence: number): void {
		if (this.stagedWrites.get(id)?.sequence === sequence) this.stagedWrites.delete(id)
	}

	/** Let a queued write settle in the background without blocking the caller. */
	private trackWrite(write: Promise<unknown>): void {
		const settled = write.then(
			() => undefined,
			(error) => {
				Logger.error("[TaskHistory] Failed to persist a metadata update:", error)
			},
		)
		this._pendingWrite = this._pendingWrite.then(() => settled)
	}

	/** Wait for all queued writes. Used by durability and shutdown barriers. */
	async flush(): Promise<void> {
		await this._pendingWrite
	}

	private async findRow(id: string): Promise<TaskHistoryRow | undefined> {
		const { records } = await this.store.query({ where: eq(TaskHistoryRow.storage.fields.id, id) })
		return records[0]
	}

	/** Re-read the history and notify listeners; called by the file watcher. */
	async reloadIndex(): Promise<void> {
		for (const cb of this._onChangeCallbacks) {
			try {
				await cb()
			} catch {
				/* ignore per-listener errors */
			}
		}
	}

	/**
	 * Watch the database for cross-process changes.
	 *
	 * @param filePath Absolute path to `taskHistory.db`
	 */
	async startWatcher(filePath: string): Promise<void> {
		try {
			if (this._watcher) {
				await this._watcher.close()
				this._watcher = null
			}

			// Committed data reaches the WAL before the main file, so both are
			// watched: waiting only on the database file would delay every
			// cross-window refresh until a checkpoint happened to run.
			this._watcher = chokidar.watch([filePath, `${filePath}-wal`], {
				persistent: true,
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
			})

			this._watcher
				.on("add", () => this.scheduleReload())
				.on("change", () => this.scheduleReload())
				.on("unlink", () => this.scheduleReload())
				.on("error", (error) => Logger.error("[TaskHistory] Watcher error:", error))
		} catch (err) {
			Logger.error("[TaskHistory] Failed to start file watcher:", err)
		}
	}

	/**
	 * Coalesce disk-change notifications into a single reload.
	 *
	 * Only one reload runs at a time; changes observed while it runs trigger
	 * exactly one follow-up.
	 */
	private scheduleReload(): void {
		if (this._reloadInFlight) {
			this._reloadRequestedWhileInFlight = true
			return
		}
		if (this._reloadTimer) clearTimeout(this._reloadTimer)
		this._reloadTimer = setTimeout(() => {
			this._reloadTimer = null
			this._reloadInFlight = this.runCoalescedReload().finally(() => {
				this._reloadInFlight = null
				if (this._reloadRequestedWhileInFlight) {
					this._reloadRequestedWhileInFlight = false
					this.scheduleReload()
				}
			})
		}, RELOAD_COALESCE_DELAY_MS)
		this._reloadTimer.unref?.()
	}

	private async runCoalescedReload(): Promise<void> {
		try {
			await this.reloadIndex()
		} catch (err) {
			// Losing a reload only costs freshness: the next change reschedules one
			// and the store still answers from disk, so it must not surface as an error.
			Logger.debug(`[TaskHistory] Deferred reload after file change: ${err instanceof Error ? err.message : err}`)
		}
	}

	/** Stop the watcher, drain queued writes and close the store. */
	async dispose(): Promise<void> {
		const watcher = this._watcher
		this._watcher = null
		this._onChangeCallbacks = []
		if (this._reloadTimer) {
			clearTimeout(this._reloadTimer)
			this._reloadTimer = null
		}
		this._reloadRequestedWhileInFlight = false
		if (watcher) {
			await watcher.close()
		}
		// Let an in-flight reload settle so it cannot touch a closed store.
		await this._reloadInFlight?.catch(() => undefined)
		await this.flush()
		await this.store.close()
		await this.database?.close()
	}
}

/**
 * Report whether two history entries would persist identically.
 *
 * Compared through the projected entry rather than a hand-written field list so
 * a column added later is covered without anyone remembering to extend this;
 * the projection is the same shape the store round-trips. Key order is stable
 * because both sides are produced by that one projection.
 */
function isSameHistoryItem(left: HistoryItem, right: HistoryItem): boolean {
	// Compared structurally rather than by serialization: two rows carrying the
	// same values in a different property order are the same durable row, and
	// treating them as different would reinstate the rewrite this check exists
	// to avoid.
	return deepEqual(left, right)
}

/**
 * Open the task history database at `location`, creating it when absent.
 *
 * @param location Absolute path to `taskHistory.db`
 */
export async function openTaskHistory(location: string): Promise<TaskHistory> {
	const database = await new SqliteUnifyStoreBackend().open(location)
	try {
		const store = await database.openStore(TaskHistoryRow)
		return new TaskHistory(store, database)
	} catch (error) {
		await database.close().catch(() => undefined)
		throw error
	}
}
