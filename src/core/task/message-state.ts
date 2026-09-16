import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { EventEmitter } from "events"
import getFolderSize from "get-folder-size"
import { findLastIndex } from "@/shared/array"
import { combineApiRequests } from "@/shared/combineApiRequests"
import { combineCommandSequences } from "@/shared/combineCommandSequences"
import { ClineMessage } from "@/shared/ExtensionMessage"
import { getApiMetrics } from "@/shared/getApiMetrics"
import { HistoryItem, summarizeHistoryTaskText } from "@/shared/HistoryItem"
import { ClineStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import { ApiConversation } from "../storage/ApiConversation"
import { ensureTaskDirectoryExists } from "../storage/disk"
import { UIMessage } from "../storage/UIMessage"
import { TaskState } from "./TaskState"

// Event types for clineMessages changes
export type ClineMessageChangeType = "add" | "update" | "delete" | "set"

export interface ClineMessageChange {
	type: ClineMessageChangeType
	/** The full array after the change */
	messages: ClineMessage[]
	/** The affected index (for add/update/delete) */
	index?: number
	/** The new/updated message (for add/update) */
	message?: ClineMessage
	/** The old message before change (for update/delete) */
	previousMessage?: ClineMessage
	/** The entire previous array (for set) */
	previousMessages?: ClineMessage[]
}

// Strongly-typed event emitter interface
export interface MessageStateHandlerEvents {
	clineMessagesChanged: [change: ClineMessageChange]
}

interface MessageStateHandlerParams {
	taskId: string
	ulid: string
	taskIsFavorited?: boolean
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	publishTaskHistoryClose?: () => void
	taskState: TaskState
	checkpointManagerErrorMessage?: string
	/** UI messages store — optional for tests (memory-only mode). */
	uiMessage?: UIMessage
	/** API conversation store — optional for tests. */
	apiConversation?: ApiConversation
}

/**
 * Coordinates message state across UIMessage and ApiConversation stores.
 *
 * All data persistence is delegated to UIMessage / ApiConversation,
 * which themselves delegate to the backend-neutral buffered storage layer.
 * This class focuses on cross-store coordination and event emission.
 */
/**
 * How long a measured task-directory size stays usable.
 *
 * The size only labels a history row, but measuring it walks the whole task
 * directory. A long task reaches hundreds of megabytes across message logs,
 * activities and checkpoints, so re-walking it on every persisted message put
 * a full directory scan on the message write path.
 */
const TASK_DIRECTORY_SIZE_TTL_MS = 30_000

export class MessageStateHandler extends EventEmitter<MessageStateHandlerEvents> {
	private taskIsFavorited: boolean
	private checkpointTracker: CheckpointTracker | undefined
	private _updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private readonly _publishTaskHistoryClose: () => void
	private taskId: string
	private ulid: string
	private taskState: TaskState
	private readonly transientClineMessages = new Map<number, ClineMessage>()
	/** Bumped by every mutation that can change how messages aggregate. */
	private messageRevision = 0
	/** Aggregated metrics reused while the message sequence is unchanged. */
	private historyMetricsCache?: { revision: number; metrics: ReturnType<typeof getApiMetrics> }
	/**
	 * Metrics over the whole sequence, kept apart from the history aggregate.
	 *
	 * The history row excludes the leading task message while the state push
	 * reports every message, so one shared slot would silently change whichever
	 * surface read it second.
	 */
	private stateMetricsCache?: { revision: number; metrics: ReturnType<typeof getApiMetrics> }
	/** Last measured task-directory size with the time it was taken. */
	private taskDirectorySizeCache?: { bytes: number; measuredAt: number }

	/** UI messages (clineMessages) — single source of truth for ui_messages.jsonl plus transient presentation overlays. */
	public readonly uiMessage: UIMessage | undefined

	/** API conversation history — single source of truth for api_conversation_history.jsonl */
	public readonly apiConversation: ApiConversation | undefined

	constructor(params: MessageStateHandlerParams) {
		super()
		this.taskId = params.taskId
		this.ulid = params.ulid
		this.taskState = params.taskState
		this.taskIsFavorited = params.taskIsFavorited ?? false
		this._updateTaskHistory = params.updateTaskHistory
		this._publishTaskHistoryClose = params.publishTaskHistoryClose ?? (() => {})
		this.uiMessage = params.uiMessage
		this.apiConversation = params.apiConversation
	}

	// ── ClineMessages (read from UIMessage store) ──

	/** ClineMessages as a property getter — merges durable rows with transient presentation overlays by timestamp. */
	get clineMessages(): ClineMessage[] {
		const durable = this.uiMessage ? (this.uiMessage.getAll() as unknown as ClineMessage[]) : []
		if (this.transientClineMessages.size === 0) return durable
		const merged = new Map(durable.map((message) => [message.ts, message]))
		for (const [ts, message] of this.transientClineMessages) merged.set(ts, message)
		return [...merged.values()].sort((left, right) => left.ts - right.ts)
	}

	set clineMessages(msgs: ClineMessage[]) {
		if (!this.uiMessage) return
		// Replacing the whole sequence changes every derived aggregate, and this
		// path writes the store directly instead of going through the mutation
		// funnel, so the revision has to be advanced here.
		this.bumpMessageRevision()
		this.uiMessage.overwrite(msgs).catch((e) => Logger.error("set clineMessages failed:", e))
	}

	/**
	 * Invalidate aggregates after the durable store was written directly.
	 *
	 * Startup clears the store and checkpoint restore truncates it without going
	 * through the mutation funnel, so a caller that reaches the store on its own
	 * has to say so. Without it a cached aggregate outlives the messages it was
	 * computed from and a state publication reports the previous task's totals.
	 */
	invalidateDerivedAggregates(): void {
		this.bumpMessageRevision()
	}

	/**
	 * Durable UI rows without transient presentation overlays.
	 *
	 * Checkpoint restore truncates the durable store, so its boundary arithmetic and
	 * staleness check must read the same sequence. Reading the merged `clineMessages`
	 * view instead made the loaded length disagree with the durable count whenever an
	 * in-flight compaction card was present, which rejected the restore outright.
	 */
	get durableClineMessages(): ClineMessage[] {
		return this.uiMessage ? (this.uiMessage.getAll() as unknown as ClineMessage[]) : []
	}

	/** ApiConversationHistory as a property getter — reads directly from apiConversation store. */
	get apiConversationHistory(): ClineStorageMessage[] {
		return this.apiConversation ? (this.apiConversation.getAll() as unknown as ClineStorageMessage[]) : []
	}

	set apiConversationHistory(msgs: ClineStorageMessage[]) {
		if (!this.apiConversation) return
		this.apiConversation.overwrite(msgs).catch((e) => Logger.error("set apiConversationHistory failed:", e))
	}

	// ── Event emission ──

	/**
	 * Emit a clineMessagesChanged event with the change details
	 */
	private emitClineMessagesChanged(change: ClineMessageChange): void {
		// Every mutation path funnels through here, so invalidating at this single
		// point keeps message-derived aggregates exact without asking each caller
		// to remember. A non-tail edit changes the aggregate while leaving the
		// message count and the tail untouched, so shape-based keys would miss it.
		this.bumpMessageRevision()
		this.emit("clineMessagesChanged", change)
	}

	setCheckpointTracker(tracker: CheckpointTracker | undefined) {
		this.checkpointTracker = tracker
	}

	reloadFromStore(): void {
		const uiMsg = this.uiMessage
		if (!uiMsg) return
		uiMsg
			.reload()
			.then(() => {
				this.emitClineMessagesChanged({
					type: "set",
					messages: [...uiMsg.getAll()],
					previousMessages: [],
				})
			})
			.catch((e) => Logger.error("reloadFromStore failed:", e))
	}

	// ── Task history metadata ──

	/**
	 * Compute and update task history metadata without touching message files.
	 * Used by incremental add paths that handle file I/O separately.
	 */
	private async updateTaskHistoryOnly(): Promise<void> {
		try {
			const allMessages = this.clineMessages
			const persisted = allMessages.filter((m) => !m.partial)
			if (persisted.length === 0) return
			const apiMetrics = this.readAggregatedMetrics(allMessages)
			// Read the task header from the in-memory message list instead of
			// re-reading ui_messages.jsonl on every history-only update: the disk
			// path bypasses the jsonl cache and does a full read + JSON.parse.
			// History entries are list labels: the panel title, the history row,
			// and search all use short text, while the authoritative task text
			// stays in ui_messages.jsonl. Storing it verbatim here made the one
			// global taskHistory key grow without bound.
			const taskText = summarizeHistoryTaskText(this.clineMessages.find((m) => m.say === "task")?.text ?? "")
			const lastRelevantIndex = findLastIndex(
				persisted,
				(message) => !(message.ask === "resume_task" || message.ask === "resume_completed_task"),
			)
			const lastRelevantMessage = lastRelevantIndex >= 0 ? persisted[lastRelevantIndex] : persisted[persisted.length - 1]
			const apiHistory = this.apiConversationHistory
			const lastModelInfo = [...apiHistory].reverse().find((msg) => msg.modelInfo !== undefined)
			const taskDir = await ensureTaskDirectoryExists(this.taskId)
			const taskDirSize = await this.readTaskDirectorySize(taskDir)
			const cwd = await getCwd(getDesktopDir())
			// Use _updateTaskHistory (constructor-injected callback), NOT this.updateTaskHistory
			await this._updateTaskHistory({
				id: this.taskId,
				ulid: this.ulid,
				ts: lastRelevantMessage.ts,
				task: taskText,
				tokensIn: apiMetrics.totalTokensIn,
				tokensOut: apiMetrics.totalTokensOut,
				cacheWrites: apiMetrics.totalCacheWrites,
				cacheReads: apiMetrics.totalCacheReads,
				totalCost: apiMetrics.totalCost,
				currency: apiMetrics.currency || "",
				size: taskDirSize,
				shadowGitConfigWorkTree: await this.checkpointTracker?.getShadowGitConfigWorkTree(),
				cwdOnTaskInitialization: cwd,
				conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
				isFavorited: this.taskIsFavorited,
				checkpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
				modelId: lastModelInfo?.modelInfo?.modelId,
				providerId: lastModelInfo?.modelInfo?.providerId,
				mode: lastModelInfo?.modelInfo?.mode,
			})
		} catch (error) {
			Logger.error("Failed to update task history:", error)
		}
	}

	/**
	 * Aggregate history metrics, reusing the last result while messages are unchanged.
	 *
	 * Every persisted message triggers a history update, and the aggregation walks
	 * the entire conversation. Keying on the mutation revision keeps the result
	 * exact — any add, update, delete or transient overlay change invalidates it —
	 * while collapsing the repeated work a single unchanged sequence would cause.
	 */
	private readAggregatedMetrics(allMessages: ClineMessage[]): ReturnType<typeof getApiMetrics> {
		const cached = this.historyMetricsCache
		if (cached?.revision === this.messageRevision) return cached.metrics
		const metrics = getApiMetrics(combineApiRequests(combineCommandSequences(allMessages.slice(1))))
		this.historyMetricsCache = { revision: this.messageRevision, metrics }
		return metrics
	}

	/**
	 * Aggregate metrics over the whole message sequence for a state publication.
	 *
	 * The aggregation walks every message and re-serializes each paired API
	 * request, whose text carries the full request body. A publication burst
	 * repeated that work per push even though nothing had been appended, which
	 * is what made a long conversation spend over a hundred milliseconds per
	 * push. Keying on the mutation revision keeps the result exact while
	 * collapsing an unchanged sequence to a single computation.
	 */
	readStateMetrics(): ReturnType<typeof getApiMetrics> {
		const cached = this.stateMetricsCache
		if (cached?.revision === this.messageRevision) return cached.metrics
		const metrics = getApiMetrics(combineApiRequests(combineCommandSequences(this.clineMessages)))
		this.stateMetricsCache = { revision: this.messageRevision, metrics }
		return metrics
	}

	/**
	 * Measure the task directory, reusing a recent measurement when one exists.
	 *
	 * The value is only a history-row label, so a slightly stale size is
	 * acceptable; walking a large task directory on every persisted message is
	 * not. A failed measurement keeps the previous value when one is available
	 * rather than reporting the task as empty.
	 */
	private async readTaskDirectorySize(taskDir: string): Promise<number> {
		const cached = this.taskDirectorySizeCache
		if (cached && Date.now() - cached.measuredAt < TASK_DIRECTORY_SIZE_TTL_MS) {
			return cached.bytes
		}
		try {
			const bytes = await getFolderSize.loose(taskDir)
			this.taskDirectorySizeCache = { bytes, measuredAt: Date.now() }
			return bytes
		} catch (error) {
			Logger.error("Failed to get task directory size:", taskDir, error)
			return cached?.bytes ?? 0
		}
	}

	/** Invalidate aggregates derived from the message sequence. */
	private bumpMessageRevision(): void {
		this.messageRevision++
	}

	/** Current message mutation revision, exposed for aggregate cache tests. */
	get messageMutationRevision(): number {
		return this.messageRevision
	}

	async updateTaskHistory(): Promise<void> {
		await this.updateTaskHistoryOnly()
	}

	publishTaskHistoryClose(): void {
		this._publishTaskHistoryClose()
	}

	// ── API conversation history ──

	/**
	 * Add a message to the API conversation history.
	 * Delegates to ApiConversation.addMessage (auto-ts, cache + disk).
	 */
	async addToApiConversationHistory(message: ClineStorageMessage): Promise<void> {
		return await this.apiConversation?.addMessage(message)
	}

	/** Replace the entire API conversation history in one atomic store transaction. */
	async overwriteApiConversationHistory(newHistory: ClineStorageMessage[]): Promise<void> {
		await this.apiConversation?.overwrite(newHistory)
	}

	/** Truncate the API conversation tail while keeping the first `count` durable rows. */
	async truncateApiConversationHistory(count: number): Promise<void> {
		await this.apiConversation?.truncateByLineNum(count)
	}

	/**
	 * Force flush the API conversation history to disk immediately.
	 * Used in hook cancellation paths where state must be persisted before abort.
	 */
	async flushApiConversationHistory(): Promise<void> {
		await this.apiConversation?.flush()
	}

	/**
	 * Force flush UI messages to disk immediately.
	 * Used in hook cancellation paths where state must be persisted before abort.
	 */
	async flushUiMessages(): Promise<void> {
		await this.uiMessage?.flush()
	}

	/** Close both stores after all task-owned continuations have exited. */
	async close(): Promise<void> {
		await Promise.all([this.apiConversation?.close(), this.uiMessage?.close()])
	}

	// ── ClineMessages lifecycle ──

	/**
	 * Add a new message to clineMessages.
	 * Handles partial vs complete messages, coordinates with API conversation history,
	 * and emits change events.
	 */
	async addToClineMessages(message: Partial<ClineMessage>): Promise<void> {
		if (message.ts === undefined) {
			throw new Error("addToClineMessages: ts is required")
		}
		const msg = message as ClineMessage
		if (msg.partial === true) {
			// Partial messages stay memory-only — upsert without disk write
			await this.upsertClineMessageInMemory(message)
			return
		}

		// Set cross-store context before persisting. Callers may provide an
		// explicit index when replaying or responding to historical asks.
		msg.conversationHistoryIndex = msg.conversationHistoryIndex ?? this.apiConversationHistory.length - 1
		msg.conversationHistoryDeletedRange = this.taskState.conversationHistoryDeletedRange

		// Persist via UIMessage store (cache + disk, Mutex-protected)
		await this.uiMessage?.addMessage(msg)
		const index = (this.uiMessage?.count ?? 0) - 1

		this.emitClineMessagesChanged({
			type: "add",
			messages: this.clineMessages,
			index,
			message: msg,
		})

		await this.updateTaskHistoryOnly()
	}

	/**
	 * Upsert a message in memory only — no disk write.
	 */
	async upsertClineMessageInMemory(message: Partial<ClineMessage>): Promise<ClineMessage> {
		if (message.ts === undefined) {
			throw new Error("upsertClineMessageInMemory: ts is required")
		}
		const msg = message as ClineMessage
		const all = this.clineMessages
		const existingIndex = all.findIndex((m) => m.ts === msg.ts)

		if (existingIndex >= 0) {
			const previousMessage = { ...all[existingIndex] }
			msg.conversationHistoryIndex = all[existingIndex].conversationHistoryIndex
			msg.conversationHistoryDeletedRange = all[existingIndex].conversationHistoryDeletedRange
			// The upsert replaces the whole row, so a presentation refresh that does
			// not carry the causal identity would silently drop it. The Webview
			// matches its active interaction against exactly this field, and losing
			// it leaves an awaiting approval with no reachable anchor.
			if (msg.interactionId === undefined && all[existingIndex].interactionId !== undefined) {
				msg.interactionId = all[existingIndex].interactionId
			}

			await this.uiMessage?.upsertMessage(msg)
			const freshAll = this.clineMessages

			this.emitClineMessagesChanged({
				type: "update",
				messages: freshAll,
				index: existingIndex,
				previousMessage,
				message: freshAll[existingIndex],
			})

			return freshAll[existingIndex]
		}

		msg.conversationHistoryIndex = msg.conversationHistoryIndex ?? this.apiConversationHistory.length - 1
		msg.conversationHistoryDeletedRange = this.taskState.conversationHistoryDeletedRange

		// Find insertion point in ascending ts order
		let insertIndex = all.length
		for (let i = 0; i < all.length; i++) {
			if (all[i].ts > msg.ts) {
				insertIndex = i
				break
			}
		}

		const inserted = await this.uiMessage?.upsertMessage(msg)
		const freshAll = this.clineMessages
		const actualIndex = inserted?.index ?? insertIndex
		const storedMessage = inserted?.message ?? msg
		this.emitClineMessagesChanged({
			type: "add",
			messages: freshAll,
			index: actualIndex,
			message: storedMessage,
		})

		return storedMessage
	}

	/**
	 * Finalize a partial message — persist to disk.
	 */
	async finalizeClineMessage(message: Partial<ClineMessage>): Promise<ClineMessage> {
		if (message.ts === undefined) {
			throw new Error("finalizeClineMessage: ts is required")
		}
		const msg = message as ClineMessage
		const all = this.clineMessages
		const existingIndex = all.findIndex((m) => m.ts === msg.ts)
		const durableIndex = this.uiMessage?.findIndexByTs(msg.ts) ?? -1

		if (existingIndex >= 0) {
			msg.conversationHistoryIndex = all[existingIndex].conversationHistoryIndex
			msg.conversationHistoryDeletedRange = all[existingIndex].conversationHistoryDeletedRange
		} else {
			msg.conversationHistoryIndex = msg.conversationHistoryIndex ?? this.apiConversationHistory.length - 1
			msg.conversationHistoryDeletedRange = this.taskState.conversationHistoryDeletedRange
		}

		msg.partial = false

		// Idempotency guard
		const existing = existingIndex >= 0 ? all[existingIndex] : null
		const alreadyFinalized =
			existing !== null &&
			existing.partial === false &&
			existing.type === msg.type &&
			existing.say === msg.say &&
			existing.ask === msg.ask &&
			existing.text === msg.text
		if (alreadyFinalized) {
			return all[existingIndex]
		}

		// Persist via store only at the terminal boundary, then remove the transient overlay.
		await this.uiMessage?.finalizeMessage(msg)
		this.transientClineMessages.delete(msg.ts)

		const freshAll = this.clineMessages
		const freshIndex = freshAll.findIndex((m) => m.ts === msg.ts)

		if (freshIndex >= 0 && (durableIndex >= 0 || existingIndex >= 0)) {
			const previousMessage = { ...all[existingIndex >= 0 ? existingIndex : 0] }
			this.emitClineMessagesChanged({
				type: "update",
				messages: freshAll,
				index: freshIndex,
				previousMessage,
				message: freshAll[freshIndex],
			})
		} else {
			this.emitClineMessagesChanged({
				type: "add",
				messages: freshAll,
				index: freshAll.length - 1,
				message: msg,
			})
		}

		await this.updateTaskHistoryOnly()
		return msg
	}

	/** Upsert a transient presentation row without marking the durable UI store dirty. */
	upsertTransientClineMessage(message: ClineMessage): ClineMessage {
		const previousMessages = this.clineMessages
		const previousIndex = previousMessages.findIndex((candidate) => candidate.ts === message.ts)
		const previousMessage = previousIndex >= 0 ? previousMessages[previousIndex] : undefined
		this.transientClineMessages.set(message.ts, message)
		const messages = this.clineMessages
		const index = messages.findIndex((candidate) => candidate.ts === message.ts)
		this.emitClineMessagesChanged({
			type: previousMessage ? "update" : "add",
			messages,
			index,
			...(previousMessage ? { previousMessage } : {}),
			message,
		})
		return message
	}

	/** Commit a new transient row durably before exposing it as durable in memory. */
	async commitTransientClineMessage(message: ClineMessage): Promise<ClineMessage> {
		const transient = this.transientClineMessages.get(message.ts)
		if (!transient) throw new Error(`Transient message ${message.ts} is unavailable for durable commit`)
		if (this.uiMessage?.getByTs(message.ts)) throw new Error(`Durable message ${message.ts} already exists`)
		const committed = await this.uiMessage?.appendDurable({ ...message, partial: false })
		if (!committed) throw new Error("UI message store is unavailable for durable commit")
		this.transientClineMessages.delete(message.ts)
		const messages = this.clineMessages
		const index = messages.findIndex((candidate) => candidate.ts === message.ts)
		try {
			this.emitClineMessagesChanged({ type: "update", messages, index, previousMessage: transient, message: committed })
		} catch (error) {
			Logger.error("Failed to publish a durably committed UI message:", error)
		}
		await this.updateTaskHistoryOnly()
		return committed
	}

	/**
	 * Drop every transient presentation row without touching durable UI history.
	 *
	 * Checkpoint restore rewinds durable conversation state only. Any presentation
	 * overlay that never reached a durable commit belongs to the superseded
	 * continuation, so it must not survive the rewind and keep rendering.
	 *
	 * @returns The timestamps of the removed transient rows.
	 */
	clearTransientClineMessages(): number[] {
		const removed = [...this.transientClineMessages.keys()]
		for (const ts of removed) this.removeTransientClineMessage(ts)
		return removed
	}

	/** Remove a transient presentation row without touching durable UI history. */
	removeTransientClineMessage(ts: number): boolean {
		const previousMessages = this.clineMessages
		const previousMessage = this.transientClineMessages.get(ts)
		if (!previousMessage) return false
		this.transientClineMessages.delete(ts)
		this.emitClineMessagesChanged({
			type: "delete",
			messages: this.clineMessages,
			index: previousMessages.findIndex((message) => message.ts === ts),
			previousMessage,
		})
		return true
	}

	/**
	 * Flush a single message to disk.
	 */
	async flushMessageUpdate(index: number): Promise<void> {
		await this.uiMessage?.flushMessage(index)
		await this.updateTaskHistoryOnly()
	}

	/**
	 * Flush multiple messages to disk.
	 */
	async flushMessageUpdates(indices: number[]): Promise<void> {
		await this.uiMessage?.flushMessages(indices)
		await this.updateTaskHistoryOnly()
	}

	/**
	 * Update a specific message in the clineMessages array and mark it for persistence.
	 */
	async updateClineMessage(index: number, updates: Partial<ClineMessage>): Promise<void> {
		const all = this.clineMessages
		if (index < 0 || index >= all.length) {
			throw new Error(`Invalid message index: ${index}`)
		}
		const previousMessage = { ...all[index] }
		await this.uiMessage?.updateMessage(index, updates)

		const freshAll = this.clineMessages
		this.emitClineMessagesChanged({
			type: "update",
			messages: freshAll,
			index,
			previousMessage,
			message: freshAll[index],
		})
	}

	/**
	 * Delete a specific message from the clineMessages array.
	 */
	async deleteClineMessage(index: number): Promise<void> {
		const all = this.clineMessages
		if (index < 0 || index >= all.length) {
			throw new Error(`Invalid message index: ${index}`)
		}
		const previousMessage = all[index]
		await this.uiMessage?.deleteMessage(index)

		const freshAll = this.clineMessages
		this.emitClineMessagesChanged({
			type: "delete",
			messages: freshAll,
			index,
			previousMessage,
		})
		await this.updateTaskHistoryOnly()
	}

	/**
	 * Remove messages by their timestamps.
	 *
	 * Retry recovery may defer task-history metadata because the replacement
	 * status message immediately becomes the new history boundary.
	 */
	async removeMessagesByTs(tsList: number[], options: { updateTaskHistory?: boolean } = {}): Promise<void> {
		if (tsList.length === 0) return
		const previousMessages = [...this.clineMessages]
		await this.uiMessage?.removeByTs(tsList)
		const freshAll = this.clineMessages
		const removed = previousMessages.length - freshAll.length
		if (removed === 0) return
		Logger.debug(`[removeMessagesByTs] removed=${removed}`)
		this.emitClineMessagesChanged({
			type: "set",
			messages: freshAll,
			previousMessages,
		})
		if (options.updateTaskHistory !== false) {
			await this.updateTaskHistoryOnly()
		}
	}

	/**
	 * Remove all partial messages from clineMessages.
	 */
	async removePartialMessages(): Promise<void> {
		const all = this.clineMessages
		const partialMessages = all.filter((m) => m.partial === true)
		if (partialMessages.length === 0) return

		Logger.debug(
			`[removePartialMessages] total=${all.length}, partial=${partialMessages.length}` +
				partialMessages.map((m) => ` [ts=${m.ts} type=${m.type} say=${m.say}]`).join(""),
		)

		const previousMessages = [...all]
		await this.uiMessage?.removePartialMessages()

		this.emitClineMessagesChanged({
			type: "set",
			messages: this.clineMessages,
			previousMessages,
		})

		await this.updateTaskHistoryOnly()
	}
}
