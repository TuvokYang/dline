import Mutex from "p-mutex"
import { recordPerfPhase, startPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { runWithSignalSpan, type SignalSpanHandle, startSignalSpan } from "@/services/telemetry/service/pipeline-port"
import { currentSignalSpan } from "@/services/telemetry/service/trace-scope"
import { Logger } from "@/shared/services/Logger"
import type { EntityFieldRef } from "../api/EntitySchema"
import type {
	BufferedUnifyStoreChangeListener,
	BufferedUnifyStore as BufferedUnifyStoreContract,
	UnifyStore,
} from "../api/UnifyStore"
import { asc } from "../api/UnifyStoreQuery"

const L2_MAX_SIZE = 500
const DEFAULT_FLUSH_INTERVAL_MS = 1_000
/**
 * Duration past which one commit is reported as slow.
 *
 * Kept below the default flush interval: a commit that outlasts the timer that
 * scheduled it means flushes have started to overlap, which is the point where
 * the cost stops being absorbed between beats and starts being felt.
 */
const SLOW_COMMIT_MS = 250
/** Upper bounds of the reported collection-size bands. */
const COLLECTION_SIZE_BANDS = [100, 1_000, 10_000, 100_000] as const

/**
 * Bucket a collection size for reporting.
 *
 * The size is what separates "this history is large" from "this store stopped
 * appending", but reporting it exactly would make almost every commit its own
 * metric series, since the value grows with the conversation. Bands keep the
 * distinction while leaving the label set bounded.
 */
function collectionSizeBand(count: number): string {
	for (const bound of COLLECTION_SIZE_BANDS) {
		if (count < bound) return `<${bound}`
	}
	return `>=${COLLECTION_SIZE_BANDS.at(-1)}`
}

export interface BufferedUnifyStoreMapping<TEntity extends object, TItem extends { ts: number }> {
	readonly ordinal: EntityFieldRef<TEntity, number>
	readonly timestamp: EntityFieldRef<TEntity, number>
	toItem(entity: TEntity): TItem
	toEntity(item: TItem, ordinal: number): TEntity
}

export interface BufferedUnifyStoreOptions<TItem extends { ts: number }> {
	readonly flushIntervalMs?: number
	readonly ensureUniqueAppendTimestamp?: boolean
	readonly subscriptionKey: string
	readonly storeKind?: string
	readonly acceptInitialItem?: (item: TItem) => boolean
	readonly truncateTail?: (keepCount: number, expectedCount: number) => Promise<void>
}

interface SubscriptionState {
	generation: number
	listeners: Set<BufferedUnifyStoreChangeListener>
}

const subscriptions = new Map<string, SubscriptionState>()

export class BufferedUnifyStore<TEntity extends object, TItem extends { ts: number }>
	implements BufferedUnifyStoreContract<TItem>
{
	private readonly mutex = new Mutex()
	private readonly flushIntervalMs: number
	private readonly ensureUniqueAppendTimestamp: boolean
	private readonly subscriptionState: SubscriptionState
	private readonly ownedListeners = new Set<BufferedUnifyStoreChangeListener>()
	private readonly acceptInitialItem: (item: TItem) => boolean
	private readonly truncateTail?: (keepCount: number, expectedCount: number) => Promise<void>
	private readonly storeKind: string
	private flushTimer: ReturnType<typeof setInterval> | undefined
	private closing = false
	private closed = false
	private closePromise: Promise<void> | undefined
	private dirty = false
	private items: TItem[] = []
	private persistedItems: TItem[] = []
	private sortedTimestamps: number[] = []
	/** Set when a mutation invalidated the index; cleared by ensureTimestampIndex(). */
	private timestampIndexStale = false
	private l2Cache = new Map<number, TItem>()
	private l2AccessOrder: number[] = []

	private constructor(
		private readonly store: UnifyStore<TEntity>,
		private readonly mapping: BufferedUnifyStoreMapping<TEntity, TItem>,
		options: BufferedUnifyStoreOptions<TItem>,
	) {
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
		this.ensureUniqueAppendTimestamp = options.ensureUniqueAppendTimestamp ?? false
		this.subscriptionState = getSubscriptionState(options.subscriptionKey)
		this.acceptInitialItem = options.acceptInitialItem ?? (() => true)
		this.truncateTail = options.truncateTail
		this.storeKind = options.storeKind ?? "other"
	}

	static async open<TEntity extends object, TItem extends { ts: number }>(options: {
		store: UnifyStore<TEntity>
		mapping: BufferedUnifyStoreMapping<TEntity, TItem>
		bufferOptions: BufferedUnifyStoreOptions<TItem>
	}): Promise<BufferedUnifyStore<TEntity, TItem>> {
		const buffered = new BufferedUnifyStore(options.store, options.mapping, options.bufferOptions)
		try {
			await buffered.loadInitialState()
			buffered.startFlushTimer()
			return buffered
		} catch (error) {
			await options.store.close().catch(() => undefined)
			throw error
		}
	}

	get count(): number {
		return this.items.length
	}

	get isFullyLoaded(): boolean {
		return true
	}

	getAll(): ReadonlyArray<TItem> {
		return this.items
	}

	getByTimestamp(timestamp: number): TItem | undefined {
		const cached = this.l2Cache.get(timestamp)
		if (cached) this.touchL2(timestamp)
		return cached
	}

	getAt(index: number): TItem | undefined {
		if (index < 0 || index >= this.items.length) return undefined
		return this.items[index]
	}

	findTimestampIndex(timestamp: number): number {
		this.ensureTimestampIndex()
		let low = 0
		let high = this.sortedTimestamps.length
		while (low < high) {
			const middle = (low + high) >>> 1
			if (this.sortedTimestamps[middle] < timestamp) low = middle + 1
			else high = middle
		}
		return low
	}

	async getRecent(limit: number): Promise<TItem[]> {
		if (limit <= 0) return []
		this.ensureTimestampIndex()
		const start = Math.max(0, this.sortedTimestamps.length - limit)
		return this.sortedTimestamps
			.slice(start)
			.map((timestamp) => this.resolveByTimestamp(timestamp))
			.filter(isDefined)
	}

	async getRange(fromTimestamp: number, toTimestamp: number): Promise<TItem[]> {
		const result: TItem[] = []
		// Refresh before the loop rather than relying on findTimestampIndex to do
		// it, so the bound read below cannot observe a different index than the
		// start position was computed against.
		this.ensureTimestampIndex()
		for (let index = this.findTimestampIndex(fromTimestamp); index < this.sortedTimestamps.length; index++) {
			const timestamp = this.sortedTimestamps[index]
			if (timestamp >= toTimestamp) break
			const item = this.resolveByTimestamp(timestamp)
			if (item) result.push(item)
		}
		return result
	}

	async reload(force = false): Promise<void> {
		if (!force) return
		await this.mutex.withLock(async () => {
			const items = await this.readCommittedItems(false)
			this.setCommittedState(items)
			this.dirty = false
		})
	}

	async append(item: TItem): Promise<void> {
		this.assertWritable()
		await this.mutex.withLock(() => {
			const admitted = this.ensureUniqueAppendTimestamp ? this.withLocallyUniqueTimestamp(item) : item
			this.items.push(admitted)
			// An append only adds one timestamp, so a materialized index can absorb
			// it directly. This matters for stores that force unique timestamps:
			// they must read the index on every append, which would otherwise
			// rebuild it every time and lose the benefit of deferring.
			this.insertIntoTimestampIndex(admitted.ts)
			this.addToL2(admitted.ts, admitted)
			this.dirty = true
		})
	}

	async appendDurable(item: TItem): Promise<TItem> {
		this.assertWritable()
		return await this.mutex.withLock(async () => {
			const tailAdditions = this.dirty ? this.getPureTailAdditions() : []
			if (!tailAdditions) {
				throw new Error("BufferedUnifyStore.appendDurable requires a clean or append-only buffer")
			}
			const admitted = this.ensureUniqueAppendTimestamp ? this.withLocallyUniqueTimestamp(item) : item
			if (this.items.some((candidate) => candidate.ts === admitted.ts)) {
				throw new Error(`BufferedUnifyStore.appendDurable: timestamp ${admitted.ts} already exists`)
			}
			const additions = [...tailAdditions, admitted]
			await this.store.insert(
				additions.map((addition, index) => this.mapping.toEntity(addition, this.persistedItems.length + index)),
			)
			this.setCommittedState([...this.persistedItems, ...additions])
			this.dirty = false
			this.publishCommittedChange()
			return admitted
		})
	}

	async stageInsertAt(index: number, item: TItem): Promise<void> {
		this.assertWritable()
		await this.mutex.withLock(() => {
			if (index >= this.items.length) this.items.push(item)
			else this.items.splice(Math.max(0, index), 0, item)
			this.invalidateTimestampIndex()
			this.addToL2(item.ts, item)
			this.dirty = true
		})
	}

	async stageUpdateAt(index: number, item: TItem): Promise<void> {
		this.assertWritable()
		await this.mutex.withLock(() => {
			this.assertIndex("stageUpdateAt", index)
			this.items[index] = item
			this.invalidateTimestampIndex()
			this.addToL2(item.ts, item)
			this.dirty = true
		})
	}

	async stagePatchAt(index: number, updates: Partial<TItem>): Promise<TItem> {
		this.assertWritable()
		return await this.mutex.withLock(() => {
			this.assertIndex("stagePatchAt", index)
			const item = { ...this.items[index], ...updates }
			this.items[index] = item
			this.invalidateTimestampIndex()
			this.addToL2(item.ts, item)
			this.dirty = true
			return item
		})
	}

	async stageUpsertByTimestamp(item: TItem): Promise<void> {
		this.assertWritable()
		await this.mutex.withLock(() => {
			const index = this.findLastTimestampIndex(item.ts)
			if (index >= 0) this.items[index] = item
			else this.items.push(item)
			this.invalidateTimestampIndex()
			this.addToL2(item.ts, item)
			this.dirty = true
		})
	}

	async removeAt(index: number): Promise<void> {
		await this.mutate((items) => {
			if (index < 0 || index >= items.length) {
				throw new Error(`BufferedUnifyStore.removeAt: index ${index} out of range [0, ${items.length})`)
			}
			items.splice(index, 1)
			return items
		})
	}

	async insertAt(index: number, item: TItem): Promise<void> {
		await this.mutate((items) => {
			if (index >= items.length) items.push(item)
			else items.splice(Math.max(0, index), 0, item)
			return items
		})
	}

	async clear(): Promise<void> {
		this.assertWritable()
		// A freshly created task clears an already-empty store on its startup path.
		// Routing that through `mutate` costs a flush plus a full query/replaceAll
		// transaction for no state change, which is pure latency before the first
		// request. Skip the round trip when there is provably nothing to remove.
		if (this.items.length === 0 && this.persistedItems.length === 0 && !this.dirty) {
			return
		}
		await this.mutate(() => [])
	}

	async truncateAt(count: number): Promise<void> {
		const keepCount = Math.min(this.items.length, Math.max(0, count))
		const truncateTail = this.truncateTail
		if (!truncateTail) {
			await this.mutate((items) => items.slice(0, keepCount))
			return
		}
		this.assertWritable()
		await this.mutex.withLock(async () => {
			const retained = this.items.slice(0, keepCount)
			const persistedPrefixLength = Math.min(keepCount, this.persistedItems.length)
			for (let index = 0; index < persistedPrefixLength; index++) {
				// Same reference short-circuit as the append path: an untouched entry
				// is still the identical object, so only replaced entries need the
				// expensive structural comparison.
				if (retained[index] === this.persistedItems[index]) continue
				if (JSON.stringify(retained[index]) !== JSON.stringify(this.persistedItems[index])) {
					throw new Error("BufferedUnifyStore.truncateAt cannot preserve a structurally modified prefix")
				}
			}
			if (keepCount > this.persistedItems.length) {
				const tailAdditions = this.getPureTailAdditions()
				if (!tailAdditions) throw new Error("BufferedUnifyStore.truncateAt requires an append-only dirty tail")
				const retainedAdditions = retained.slice(this.persistedItems.length)
				if (retainedAdditions.length > 0) {
					await this.store.insert(
						retainedAdditions.map((item, index) => this.mapping.toEntity(item, this.persistedItems.length + index)),
					)
				}
			} else if (keepCount < this.persistedItems.length) {
				await truncateTail(keepCount, this.persistedItems.length)
			}
			this.setCommittedState(retained)
			this.dirty = false
			this.publishCommittedChange()
		})
	}

	async truncateBeforeTimestamp(timestamp: number): Promise<void> {
		await this.truncateAt(this.findTimestampIndex(timestamp))
	}

	async mutate(transform: (items: TItem[]) => TItem[]): Promise<void> {
		this.assertWritable()
		await this.mutex.withLock(async () => {
			await this.flushLocked()
			let result: TItem[] = []
			await this.store.transaction(async (transaction) => {
				const entities = await transaction.query({ orderBy: [asc(this.mapping.ordinal)] })
				result = transform(entities.map((entity) => this.mapping.toItem(entity)))
				await transaction.replaceAll(result.map((item, ordinal) => this.mapping.toEntity(item, ordinal)))
			})
			this.setCommittedState(result)
			this.publishCommittedChange()
		})
	}

	async replaceAll(items: readonly TItem[]): Promise<void> {
		await this.mutate(() => [...items])
	}

	async flush(): Promise<void> {
		await this.mutex.withLock(() => this.flushLocked())
	}

	subscribe(listener: BufferedUnifyStoreChangeListener): () => void {
		this.subscriptionState.listeners.add(listener)
		this.ownedListeners.add(listener)
		return () => {
			this.subscriptionState.listeners.delete(listener)
			this.ownedListeners.delete(listener)
		}
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.closing = true
		if (this.flushTimer) clearInterval(this.flushTimer)
		this.flushTimer = undefined
		this.closePromise = this.mutex.withLock(async () => {
			await this.flushLocked()
			for (const listener of this.ownedListeners) this.subscriptionState.listeners.delete(listener)
			this.ownedListeners.clear()
			await this.store.close()
			this.closed = true
		})
		return this.closePromise
	}

	private async loadInitialState(): Promise<void> {
		this.setCommittedState(await this.readCommittedItems(true))
	}

	private async readCommittedItems(initial: boolean): Promise<TItem[]> {
		const result = await this.store.query({ orderBy: [asc(this.mapping.ordinal)] })
		const items: TItem[] = []
		for (const entity of result.records) {
			try {
				const item = this.mapping.toItem(entity)
				if (!initial || this.acceptInitialItem(item)) items.push(item)
			} catch {
				// Invalid persisted records are isolated at the compatibility boundary.
			}
		}
		return items
	}

	private startFlushTimer(): void {
		this.flushTimer = setInterval(() => {
			void this.flush().catch(() => undefined)
		}, this.flushIntervalMs)
		this.flushTimer.unref?.()
	}

	private async flushLocked(): Promise<void> {
		if (!this.dirty) return
		// Attached only to an operation already being traced. A flush also runs
		// from a repeating timer, and starting a span there would emit a root
		// trace every interval for every open store while explaining nothing:
		// the work would have no caller to attribute it to. When a task is
		// waiting on this commit the span is what shows that wait on its
		// waterfall, which is the case worth seeing.
		const span = this.beginFlushSpan()
		if (!span) {
			await this.commitLocked()
			return
		}
		try {
			await runWithSignalSpan(span, () => this.commitLocked(span))
			span.end("success")
		} catch (error) {
			span.recordException(error)
			span.end("failure")
			throw error
		}
	}

	/**
	 * Start a flush span only when this commit belongs to a traced operation.
	 *
	 * Returning undefined is the common case: the periodic flush has no caller
	 * to hang under, and an unparented span per interval per store would add
	 * traces without adding information.
	 */
	private beginFlushSpan(): SignalSpanHandle | undefined {
		const parent = currentSignalSpan()
		if (!parent) return undefined
		return startSignalSpan({ name: "storage.flush_commit", parent })
	}

	private async commitLocked(span?: SignalSpanHandle): Promise<void> {
		const startedAt = performance.now()
		try {
			await this.commitShape(span)
		} catch (error) {
			// A periodic flush swallows its rejection, and the success paths
			// below are the only ones that stop the phase. Without this a write
			// that keeps failing would report nothing at all: the file-lock
			// metric would still say it acquired the lock, and the store would
			// look idle rather than broken.
			//
			// Reported as another value of the existing `commit` dimension
			// rather than as a new label, so failures join the same series
			// instead of splitting every existing one in two.
			recordPerfPhase(PerfDomain.BufferedStore, "flush_commit", performance.now() - startedAt, {
				commit: "error",
				size: collectionSizeBand(this.items.length),
				store_kind: this.storeKind,
				rewrite_reason: "error",
			})
			throw error
		}
	}

	private async commitShape(span?: SignalSpanHandle): Promise<void> {
		// Both commit shapes report under one phase so a silent fall back to
		// rewriting the whole collection shows up as a shift in the `commit`
		// dimension instead of only as user-visible slowness.
		const phase = startPerfPhase(PerfDomain.BufferedStore, "flush_commit")
		const startedAt = performance.now()
		// The same two facts the metric carries. A duration alone would leave a
		// reader unable to tell a large history from a store that stopped
		// appending, which is the distinction the span exists to show.
		const describe = (commit: string, size: string, rewriteReason: string): void => {
			span?.setAttribute("commit", commit)
			span?.setAttribute("size", size)
			span?.setAttribute("store_kind", this.storeKind)
			span?.setAttribute("rewrite_reason", rewriteReason)
		}
		const tailAdditions = this.getPureTailAdditions()
		if (tailAdditions) {
			await this.store.insert(
				tailAdditions.map((item, index) => this.mapping.toEntity(item, this.persistedItems.length + index)),
			)
			this.setCommittedState([...this.persistedItems, ...tailAdditions])
			this.dirty = false
			this.publishCommittedChange()
			phase.stop({
				commit: "buffered_append",
				size: collectionSizeBand(this.items.length),
				store_kind: this.storeKind,
				rewrite_reason: "none",
			})
			describe("buffered_append", collectionSizeBand(this.items.length), "none")
			this.reportSlowCommit(startedAt, "buffered_append", this.items.length)
			return
		}
		let merged: TItem[] = []
		let commit = "rewrite"
		let rewriteReason = "patch"
		let committedChange = true
		await this.store.transaction(async (transaction) => {
			const entities = await transaction.query({ orderBy: [asc(this.mapping.ordinal)] })
			const committed = entities.map((entity) => this.mapping.toItem(entity))
			merged = this.mergeWithCommitted(committed)
			if (this.isSameCommittedSequence(committed, merged)) {
				commit = "noop"
				rewriteReason = "no_change"
				committedChange = false
				return
			}
			// The merge already ran against the committed state read inside this
			// transaction, so when it only grew a tail there is nothing to rewrite.
			// Deciding from `committed` rather than from the local baseline keeps
			// this correct even when another writer moved ahead of us, and keeps
			// cross-process timestamp allocation fully intact.
			const appended = this.suffixAfterUnchangedPrefixOf(committed, merged)
			if (appended) {
				commit = "append"
				rewriteReason = "none"
				await transaction.insert(appended.map((item, index) => this.mapping.toEntity(item, committed.length + index)))
				return
			}
			rewriteReason = this.classifyRewriteReason(committed, merged)
			await transaction.replaceAll(merged.map((item, ordinal) => this.mapping.toEntity(item, ordinal)))
		})
		this.setCommittedState(merged)
		this.dirty = false
		if (committedChange) this.publishCommittedChange()
		phase.stop({
			commit,
			size: collectionSizeBand(merged.length),
			store_kind: this.storeKind,
			rewrite_reason: rewriteReason,
		})
		describe(commit, collectionSizeBand(merged.length), rewriteReason)
		this.reportSlowCommit(startedAt, commit, merged.length)
	}

	/**
	 * Log a commit that took long enough to be felt.
	 *
	 * Telemetry alone leaves a local user with no way to see why their session
	 * degraded, and the collection size plus the commit shape is what separates
	 * "this history is large" from "this store stopped appending".
	 */
	private reportSlowCommit(startedAt: number, commit: string, itemCount: number): void {
		const durationMs = Math.round(performance.now() - startedAt)
		if (durationMs < SLOW_COMMIT_MS) return
		// The collection identity is deliberately absent: it derives from a user
		// file path, and the size plus the commit shape already say whether this
		// is a large history or a store that stopped appending.
		Logger.warn(`[BufferedUnifyStore] slow commit: durationMs=${durationMs}, commit=${commit}, items=${itemCount}`)
	}

	/**
	 * Return the entries appended after an unchanged prefix, when there are any.
	 *
	 * Identity is the only prefix test used here: merging reuses the very
	 * objects it was given for untouched entries, so a replaced entry always
	 * breaks reference equality and correctly forces a full rewrite.
	 */
	private isSameCommittedSequence(committed: readonly TItem[], merged: readonly TItem[]): boolean {
		return committed.length === merged.length && committed.every((item, index) => item === merged[index])
	}

	private classifyRewriteReason(committed: readonly TItem[], merged: readonly TItem[]): string {
		if (merged.length < committed.length) return "remove"
		if (merged.length > committed.length) return "insert_or_merge"
		if (committed.some((item, index) => item.ts !== merged[index]?.ts)) return "reorder"
		return "patch"
	}

	private suffixAfterUnchangedPrefixOf(committed: readonly TItem[], merged: readonly TItem[]): TItem[] | undefined {
		if (merged.length <= committed.length) return undefined
		for (let index = 0; index < committed.length; index++) {
			if (merged[index] !== committed[index]) return undefined
		}
		return merged.slice(committed.length)
	}

	private getPureTailAdditions(): TItem[] | undefined {
		if (this.ensureUniqueAppendTimestamp || this.items.length <= this.persistedItems.length) return undefined
		for (let index = 0; index < this.persistedItems.length; index++) {
			// Reference equality settles the common case without serializing: an
			// untouched prefix still holds the very objects the baseline captured,
			// because staging replaces whole entries instead of mutating them.
			// Serializing every retained entry on each flush turned an append into
			// work proportional to the entire history.
			if (this.items[index] === this.persistedItems[index]) continue
			if (JSON.stringify(this.items[index]) !== JSON.stringify(this.persistedItems[index])) return undefined
		}
		return this.items.slice(this.persistedItems.length)
	}

	private mergeWithCommitted(committedItems: TItem[]): TItem[] {
		const baselineByTimestamp = new Map(this.persistedItems.map((item) => [item.ts, item]))
		const baselineTimestamps = new Set(baselineByTimestamp.keys())
		const localByTimestamp = new Map(this.items.map((item) => [item.ts, item]))
		const removedTimestamps = new Set(
			this.persistedItems.filter((item) => !localByTimestamp.has(item.ts)).map((item) => item.ts),
		)
		let merged = committedItems.filter((item) => !removedTimestamps.has(item.ts))
		const additions: Array<{ item: TItem; localIndex: number }> = []

		for (let localIndex = 0; localIndex < this.items.length; localIndex++) {
			const localItem = this.items[localIndex]
			const baselineItem = baselineByTimestamp.get(localItem.ts)
			if (!baselineItem) {
				additions.push({ item: localItem, localIndex })
				continue
			}
			// Staging replaces whole entries, so an untouched entry is still the
			// very object the baseline captured. Serializing both sides of that
			// comparison cost a full pass over the history on every flush.
			if (localItem === baselineItem) continue
			if (JSON.stringify(localItem) === JSON.stringify(baselineItem)) continue
			const committedIndex = merged.findIndex((item) => item.ts === localItem.ts)
			if (committedIndex >= 0) merged[committedIndex] = localItem
			else additions.push({ item: localItem, localIndex })
		}

		if (additions.length === 0) return merged
		if (this.ensureUniqueAppendTimestamp) this.allocateUniqueCommittedTimestamps(merged, additions)

		const additionTimestamps = new Set(additions.map(({ item }) => item.ts))
		merged = merged.filter((item) => !additionTimestamps.has(item.ts))
		const groups = new Map<string, { previous?: number; next?: number; items: TItem[] }>()
		for (const addition of additions) {
			const previous = findBaselineTimestamp(this.items, baselineTimestamps, addition.localIndex, -1)
			const next = findBaselineTimestamp(this.items, baselineTimestamps, addition.localIndex, 1)
			const key = `${previous ?? "start"}:${next ?? "end"}`
			const group = groups.get(key) ?? { previous, next, items: [] }
			group.items.push(addition.item)
			groups.set(key, group)
		}

		for (const group of groups.values()) {
			const previousIndex = group.previous === undefined ? -1 : merged.findIndex((item) => item.ts === group.previous)
			const nextIndex = group.next === undefined ? merged.length : merged.findIndex((item) => item.ts === group.next)
			const start = previousIndex >= 0 ? previousIndex + 1 : 0
			const end = nextIndex >= start ? nextIndex : merged.length
			const gap = merged.slice(start, end)
			if (gap.some((item) => baselineTimestamps.has(item.ts))) {
				merged.splice(end, 0, ...group.items)
				continue
			}
			const byTimestamp = new Map(gap.map((item) => [item.ts, item]))
			for (const item of group.items) byTimestamp.set(item.ts, item)
			merged.splice(start, end - start, ...[...byTimestamp.values()].sort((left, right) => left.ts - right.ts))
		}
		return merged
	}

	private allocateUniqueCommittedTimestamps(
		committed: readonly TItem[],
		additions: Array<{ item: TItem; localIndex: number }>,
	): void {
		const used = new Set(committed.map((item) => item.ts))
		let maximum = committed.reduce((value, item) => Math.max(value, item.ts), 0)
		for (const addition of additions) {
			if (used.has(addition.item.ts)) {
				let next = Math.max(addition.item.ts, maximum) + 1
				while (used.has(next)) next += 1
				addition.item = { ...addition.item, ts: next }
				this.items[addition.localIndex] = addition.item
			}
			used.add(addition.item.ts)
			maximum = Math.max(maximum, addition.item.ts)
		}
	}

	private setCommittedState(items: TItem[]): void {
		this.items = items
		// The baseline is only ever read: it is compared against `this.items` and
		// sliced, never written through. Every staging path replaces a whole entry
		// (`this.items[index] = item`) or builds a new object from a spread, so no
		// entry is mutated in place and the two arrays cannot alias into each other.
		//
		// Deep-cloning every entry here doubled both the load time and the resident
		// memory of a task's message history, which for a large task meant copying
		// tens of megabytes on open before anything could be displayed.
		this.persistedItems = [...items]
		this.l2Cache.clear()
		this.l2AccessOrder = []
		this.invalidateTimestampIndex()
		for (let index = 0; index < Math.min(items.length, L2_MAX_SIZE); index++) {
			if (items[index].ts > 0) this.addToL2(items[index].ts, items[index])
		}
	}

	private resolveByTimestamp(timestamp: number): TItem | undefined {
		const cached = this.getByTimestamp(timestamp)
		if (cached) return cached
		const item = [...this.items].reverse().find((candidate) => candidate.ts === timestamp)
		if (item) this.addToL2(timestamp, item)
		return item
	}

	/**
	 * Mark the timestamp index for rebuilding on the next read.
	 *
	 * Sorting eagerly inside every mutation made a burst of staged updates pay
	 * one full sort each, which on a long conversation dominated streaming. The
	 * rebuild itself is unchanged and still the only writer of the index, so
	 * deferring it cannot make a reader observe a partially maintained order.
	 */
	private invalidateTimestampIndex(): void {
		this.timestampIndexStale = true
	}

	/**
	 * Add one timestamp to an already materialized index.
	 *
	 * A stale index is left alone: the pending rebuild reads `items`, which
	 * already holds the new entry.
	 */
	private insertIntoTimestampIndex(timestamp: number): void {
		if (this.timestampIndexStale || timestamp <= 0) return
		this.sortedTimestamps.splice(this.findTimestampIndex(timestamp), 0, timestamp)
	}

	/** Restore the sorted index before any reader depends on its ordering. */
	private ensureTimestampIndex(): void {
		if (!this.timestampIndexStale) return
		this.timestampIndexStale = false
		this.rebuildTimestampIndex()
	}

	private rebuildTimestampIndex(): void {
		this.sortedTimestamps = this.items
			.filter((item) => item.ts > 0)
			.map((item) => item.ts)
			.sort((left, right) => left - right)
	}

	/**
	 * Report whether the index already holds this timestamp.
	 *
	 * findTimestampIndex() refreshes a stale index first, so a collision staged
	 * since the last read is still visible here.
	 */
	private hasTimestamp(timestamp: number): boolean {
		return this.sortedTimestamps[this.findTimestampIndex(timestamp)] === timestamp
	}

	private addToL2(timestamp: number, item: TItem): void {
		const existing = this.l2AccessOrder.indexOf(timestamp)
		if (existing >= 0) this.l2AccessOrder.splice(existing, 1)
		while (this.l2Cache.size >= L2_MAX_SIZE && this.l2AccessOrder.length > 0) {
			const oldest = this.l2AccessOrder.shift()
			if (oldest !== undefined) this.l2Cache.delete(oldest)
		}
		this.l2Cache.set(timestamp, item)
		this.l2AccessOrder.push(timestamp)
	}

	private touchL2(timestamp: number): void {
		const index = this.l2AccessOrder.indexOf(timestamp)
		if (index < 0) return
		this.l2AccessOrder.splice(index, 1)
		this.l2AccessOrder.push(timestamp)
	}

	private withLocallyUniqueTimestamp(item: TItem): TItem {
		// Uniqueness is decided against the index, so a run of appends that never
		// gets read in between must still refresh it here. Skipping this let
		// consecutive colliding appends all keep the same timestamp.
		this.ensureTimestampIndex()
		// Scanning the index linearly here cost a full pass per append, and the
		// probe loop repeated that pass on every attempt. The index is sorted,
		// so membership is a binary search.
		if (!this.hasTimestamp(item.ts)) return item
		let next = Math.max(item.ts, this.sortedTimestamps.at(-1) ?? item.ts) + 1
		while (this.hasTimestamp(next)) next += 1
		return { ...item, ts: next }
	}

	private findLastTimestampIndex(timestamp: number): number {
		for (let index = this.items.length - 1; index >= 0; index--) {
			if (this.items[index].ts === timestamp) return index
		}
		return -1
	}

	private assertIndex(operation: string, index: number): void {
		if (index < 0 || index >= this.items.length) {
			throw new Error(`BufferedUnifyStore.${operation}: index ${index} out of range [0, ${this.items.length})`)
		}
	}

	private assertWritable(): void {
		if (this.closing || this.closed) throw new Error("BufferedUnifyStore is closed")
	}

	private publishCommittedChange(): void {
		this.subscriptionState.generation += 1
		const change = { generation: this.subscriptionState.generation }
		for (const listener of this.subscriptionState.listeners) {
			void Promise.resolve(listener(change)).catch(() => undefined)
		}
	}
}

function getSubscriptionState(key: string): SubscriptionState {
	let state = subscriptions.get(key)
	if (!state) {
		state = { generation: 0, listeners: new Set() }
		subscriptions.set(key, state)
	}
	return state
}

function findBaselineTimestamp<TItem extends { ts: number }>(
	items: readonly TItem[],
	baseline: ReadonlySet<number>,
	fromIndex: number,
	direction: -1 | 1,
): number | undefined {
	for (let index = fromIndex + direction; index >= 0 && index < items.length; index += direction) {
		if (baseline.has(items[index].ts)) return items[index].ts
	}
	return undefined
}

function isDefined<TValue>(value: TValue | undefined): value is TValue {
	return value !== undefined
}
