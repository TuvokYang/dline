import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { EventEmitter } from "events"
import getFolderSize from "get-folder-size"
import { findLastIndex } from "@/shared/array"
import type { ContextWindowIndicatorSnapshot } from "@/shared/context-window-indicator"
import { UiMessage } from "@/shared/ExtensionMessage"
import type { ApiMetrics } from "@/shared/getApiMetrics"
import { HistoryItem, summarizeHistoryTaskText } from "@/shared/HistoryItem"
import { orderMessagesByTs } from "@/shared/message-order"
import { ClineStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import { ApiConversation } from "../storage/ApiConversation"
import { ensureTaskDirectoryExists } from "../storage/disk"
import { UIMessage } from "../storage/UIMessage"
import type { ConversationHistoryReader } from "./conversation/ConversationHistoryReader"
import { readHistoryContextWindowIndicator } from "./HistoryContextWindow"
import { MessageUsageProjection } from "./performance/MessageUsageProjection"

// Event types for clineMessages changes
export type ClineMessageChangeType = "add" | "update" | "delete" | "set"

export interface ClineMessageChange {
    type: ClineMessageChangeType
    /** The full array after the change */
    messages: UiMessage[]
    /** The affected index (for add/update/delete) */
    index?: number
    /** The new/updated message (for add/update) */
    message?: UiMessage
    /** The old message before change (for update/delete) */
    previousMessage?: UiMessage
    /** The entire previous array (for set) */
    previousMessages?: UiMessage[]
}

// Strongly-typed event emitter interface
export interface MessageStateHandlerEvents {
    clineMessagesChanged: [change: ClineMessageChange]
}

/** A UI row that is already visible in memory and registered in the durable write order. */
export interface RegisteredClineMessagePersistence {
    readonly message: UiMessage
    readonly persistence: Promise<UiMessage>
}

export interface MessageTaskMetadataSource {
    readonly conversationHistoryDeletedRange?: HistoryItem["conversationHistoryDeletedRange"]
    readonly checkpointManagerErrorMessage?: string
    /** Occupancy the task header shows; saved so a reopened task can draw it before sending. */
    readonly contextWindowIndicator?: ContextWindowIndicatorSnapshot
}

export interface MessageStateHandlerParams {
    taskId: string
    ulid: string
    taskIsFavorited?: boolean
    updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
    publishTaskHistoryClose?: () => void
    metadata?: MessageTaskMetadataSource
    /** Structural compatibility for callers being migrated off legacy TaskState. */
    taskState?: MessageTaskMetadataSource
    checkpointManagerErrorMessage?: string
    /** UI messages store — optional for tests (memory-only mode). */
    uiMessage?: UIMessage
    /** API conversation store — optional for tests. */
    apiConversation?: ApiConversation
    /** The task's provider conversation; see readConversationHistory. */
    conversation?: ConversationHistoryReader
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

/**
 * Whether `next` may replace the row held under the same `ts`.
 *
 * A slow partial presenter must never regress a row that already reached its
 * canonical final state under the same causal identity.
 */
function mayReplaceRow(current: UiMessage, next: UiMessage): boolean {
    return current.partial === true || next.partial !== true
}

export class MessageStateHandler extends EventEmitter<MessageStateHandlerEvents> {
    private taskIsFavorited: boolean
    private checkpointTracker: CheckpointTracker | undefined
    private _updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
    private readonly _publishTaskHistoryClose: () => void
    private taskId: string
    private ulid: string
    private readonly metadata: MessageTaskMetadataSource
    private readonly transientClineMessages = new Map<number, UiMessage>()
    /** Bumped by every mutation that can change how messages aggregate. */
    private messageRevision = 0
    /** Bumped when positional message windows must be fetched again. */
    private messageWindowRevision = 0
    /** Usage read from message facts; caches each request's scalar usage instead of its body. */
    private readonly usageProjection = new MessageUsageProjection()
    /** Aggregated metrics reused while the message sequence is unchanged. */
    private historyMetricsCache?: { revision: number; metrics: ApiMetrics }
    /**
     * Metrics over the whole sequence, kept apart from the history aggregate.
     *
     * The history row excludes the leading task message while the state push
     * reports every message, so one shared slot would silently change whichever
     * surface read it second.
     */
    private stateMetricsCache?: { revision: number; metrics: ApiMetrics }
    /** Last measured task-directory size with the time it was taken. */
    private taskDirectorySizeCache?: { bytes: number; measuredAt: number }

    /** UI messages (clineMessages) — the task's only writer of messages.db, plus transient presentation overlays. */
    public readonly uiMessage: UIMessage | undefined

    /** Legacy api_conversation_history.jsonl, read only when the journal holds no conversation. */
    public readonly apiConversation: ApiConversation | undefined
    private readonly conversation: ConversationHistoryReader | undefined

    constructor(params: MessageStateHandlerParams) {
        super()
        this.taskId = params.taskId
        this.ulid = params.ulid
        this.metadata = params.metadata ?? params.taskState ?? {}
        this.taskIsFavorited = params.taskIsFavorited ?? false
        this._updateTaskHistory = params.updateTaskHistory
        this._publishTaskHistoryClose = params.publishTaskHistoryClose ?? (() => {})
        this.uiMessage = params.uiMessage
        this.apiConversation = params.apiConversation
        this.conversation = params.conversation
    }

    /** Stable anonymous Task identity used by usage telemetry; never derived from message content. */
    get taskUlid(): string {
        return this.ulid
    }

    // ── ClineMessages (read from UIMessage store) ──

    /** ClineMessages as a property getter — merges durable rows with transient presentation overlays by timestamp. */
    get clineMessages(): UiMessage[] {
        const durable = this.uiMessage ? (this.uiMessage.getAll() as unknown as UiMessage[]) : []
        if (this.transientClineMessages.size === 0) return orderMessagesByTs(durable)
        const merged = new Map(durable.map((message) => [message.ts, message]))
        for (const [ts, message] of this.transientClineMessages) merged.set(ts, message)
        return [...merged.values()].sort((left, right) => left.ts - right.ts)
    }

    /**
     * The highest timestamp of any row, durable or transient, without
     * materializing the merged history. New rows must be stamped above it.
     */
    latestMessageTs(): number | undefined {
        const store = this.uiMessage
        let latest: number | undefined
        for (const message of store?.getAll() ?? []) latest = Math.max(latest ?? message.ts, message.ts)
        for (const ts of this.transientClineMessages.keys()) latest = latest === undefined ? ts : Math.max(latest, ts)
        return latest
    }

    set clineMessages(msgs: UiMessage[]) {
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
    get durableClineMessages(): UiMessage[] {
        return this.uiMessage ? (this.uiMessage.getAll() as unknown as UiMessage[]) : []
    }

    /**
     * The conversation the provider is sent.
     *
     * The journal is its only record. A task written before the journal existed
     * has an empty journal and its conversation in the legacy file, which is
     * read instead so such a task still has a history.
     */
    async readConversationHistory(): Promise<ClineStorageMessage[]> {
        const journal = this.conversation ? await this.conversation.read() : []
        return journal.length > 0 ? journal : this.legacyConversationHistory()
    }

    /** How many messages the conversation holds, for positions a chat row records. */
    conversationSize(): number {
        const journal = this.conversation?.size() ?? 0
        return journal > 0 ? journal : (this.apiConversation?.count ?? 0)
    }

    /**
     * The conversation length now, counting journal entries written since the last read.
     *
     * A chat row records the index of the conversation message it follows, and the
     * provider reply or tool result it follows may have been journaled a moment ago.
     */
    async currentConversationSize(): Promise<number> {
        const journal = this.conversation ? await this.conversation.count() : 0
        return journal > 0 ? journal : (this.apiConversation?.count ?? 0)
    }

    /** Stamp where the conversation stands on a new row, unless the caller already placed it. */
    private placeRow(msg: UiMessage, size: number): void {
        msg.conversationHistoryIndex = msg.conversationHistoryIndex ?? size - 1
        msg.conversationJournalSeq = msg.conversationJournalSeq ?? this.conversation?.position()
        msg.conversationHistoryDeletedRange = this.metadata.conversationHistoryDeletedRange
    }

    /** A replaced row keeps the place it was first written at. */
    private keepPlace(msg: UiMessage, existing: UiMessage): void {
        msg.conversationHistoryIndex = existing.conversationHistoryIndex
        msg.conversationJournalSeq = existing.conversationJournalSeq
        msg.conversationHistoryDeletedRange = existing.conversationHistoryDeletedRange
    }

    private legacyConversationHistory(): ClineStorageMessage[] {
        return this.apiConversation ? (this.apiConversation.getAll() as unknown as ClineStorageMessage[]) : []
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
        if (change.type === "delete" || change.type === "set") this.messageWindowRevision++
        this.emit("clineMessagesChanged", change)
    }

    setCheckpointTracker(tracker: CheckpointTracker | undefined) {
        this.checkpointTracker = tracker
    }

    /**
     * Replaces the whole durable history through this task's writer and waits until
     * it is stored. Recovery uses it so a rebuilt history never needs a second writer.
     */
    async replaceClineMessages(messages: UiMessage[]): Promise<void> {
        if (!this.uiMessage) return
        const previousMessages = [...this.clineMessages]
        await this.uiMessage.overwrite(messages)
        await this.uiMessage.flush()
        this.emitClineMessagesChanged({ type: "set", messages: this.clineMessages, previousMessages })
        await this.updateTaskHistoryOnly()
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
            // re-reading the stored chat history on every history-only update.
            // History entries are list labels: the panel title, the history row,
            // and search all use short text, while the authoritative task text
            // stays in the task's messages.db. Storing it verbatim here made the one
            // global taskHistory key grow without bound.
            const taskText = summarizeHistoryTaskText(this.clineMessages.find((m) => m.say === "task")?.text ?? "")
            const lastRelevantIndex = findLastIndex(
                persisted,
                (message) => !(message.ask === "resume_task" || message.ask === "resume_completed_task"),
            )
            const lastRelevantMessage = lastRelevantIndex >= 0 ? persisted[lastRelevantIndex] : persisted[persisted.length - 1]
            const apiHistory = await this.readConversationHistory()
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
                conversationHistoryDeletedRange: this.metadata.conversationHistoryDeletedRange,
                isFavorited: this.taskIsFavorited,
                checkpointManagerErrorMessage: this.metadata.checkpointManagerErrorMessage,
                // Stored as the stopped baseline a reopen will draw: a request still
                // in flight when the task closed never reaches the conversation.
                contextWindowIndicator: readHistoryContextWindowIndicator(this.metadata.contextWindowIndicator, this.taskId),
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
    private readAggregatedMetrics(allMessages: UiMessage[]): ApiMetrics {
        const cached = this.historyMetricsCache
        if (cached?.revision === this.messageRevision) return cached.metrics
        const metrics = this.usageProjection.read(allMessages.slice(1))
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
    readStateMetrics(): ApiMetrics {
        const cached = this.stateMetricsCache
        if (cached?.revision === this.messageRevision) return cached.metrics
        const metrics = this.usageProjection.read(this.clineMessages)
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

    /** Revision of destructive sequence changes that invalidate a positional Webview window. */
    get messageWindowMutationRevision(): number {
        return this.messageWindowRevision
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
    async addToClineMessages(message: Partial<UiMessage>): Promise<void> {
        if (message.ts === undefined) {
            throw new Error("addToClineMessages: ts is required")
        }
        const msg = message as UiMessage
        if (msg.partial === true) {
            // Partial messages stay memory-only — upsert without disk write
            await this.upsertClineMessageInMemory(message)
            return
        }

        // Set cross-store context before persisting. A caller that prepared the
        // row before starting its causal work may provide the exact conversation
        // index; do not issue a redundant database count on that hot path.
        if (msg.conversationHistoryIndex === undefined) this.placeRow(msg, await this.currentConversationSize())
        else this.placeRow(msg, 0)

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
    async upsertClineMessageInMemory(message: Partial<UiMessage>): Promise<UiMessage> {
        if (message.ts === undefined) {
            throw new Error("upsertClineMessageInMemory: ts is required")
        }
        const msg = message as UiMessage
        const all = this.clineMessages
        const existingIndex = all.findIndex((m) => m.ts === msg.ts)

        // The store re-checks the row under its own lock: a final write still
        // queued there is invisible to the snapshot read above, and a partial
        // admitted against that snapshot would land after it and regress the row.
        const admit = (current: UiMessage) => mayReplaceRow(current, msg)

        if (existingIndex >= 0) {
            const existing = all[existingIndex]
            if (!admit(existing)) return existing
            const previousMessage = { ...existing }
            this.keepPlace(msg, existing)
            // The upsert replaces the whole row, so a presentation refresh that does
            // not carry the causal identity would silently drop it. The Webview
            // matches its active interaction against exactly this field, and losing
            // it leaves an awaiting approval with no reachable anchor.
            if (msg.interactionId === undefined && all[existingIndex].interactionId !== undefined) {
                msg.interactionId = all[existingIndex].interactionId
            }

            const stored = await this.uiMessage?.upsertMessage(msg, admit)
            if (stored?.applied === false) return stored.message
            const freshAll = this.clineMessages
            // Look the row up again: a row inserted ahead of it while the write
            // waited on the lock moves it off the index read before the wait.
            const freshIndex = freshAll.findIndex((m) => m.ts === msg.ts)
            const current = freshAll[freshIndex] ?? msg

            this.emitClineMessagesChanged({
                type: "update",
                messages: freshAll,
                index: freshIndex >= 0 ? freshIndex : existingIndex,
                previousMessage,
                message: current,
            })

            return current
        }

        this.placeRow(msg, await this.currentConversationSize())

        // Find insertion point in ascending ts order
        let insertIndex = all.length
        for (let i = 0; i < all.length; i++) {
            if (all[i].ts > msg.ts) {
                insertIndex = i
                break
            }
        }

        const inserted = await this.uiMessage?.upsertMessage(msg, admit)
        if (inserted?.applied === false) return inserted.message
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
     *
     * `keepRecordedFields` merges onto the stored row under the store lock instead
     * of replacing it, for a writer that takes over a row others still record
     * fields on (a completion's checkpoint settles beside the dialog anchoring it).
     */
    async finalizeClineMessage(
        message: Partial<UiMessage>,
        options?: { readonly keepRecordedFields?: boolean },
    ): Promise<UiMessage> {
        if (message.ts === undefined) {
            throw new Error("finalizeClineMessage: ts is required")
        }
        const msg = message as UiMessage
        const all = this.clineMessages
        const existingIndex = all.findIndex((m) => m.ts === msg.ts)
        const durableIndex = this.uiMessage?.findIndexByTs(msg.ts) ?? -1

        if (existingIndex >= 0) {
            this.keepPlace(msg, all[existingIndex])
        } else {
            this.placeRow(msg, await this.currentConversationSize())
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
        if (options?.keepRecordedFields && durableIndex >= 0) await this.uiMessage?.finalizeMessageOnto(msg)
        else await this.uiMessage?.finalizeMessage(msg)
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
    upsertTransientClineMessage(message: UiMessage): UiMessage {
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
    async commitTransientClineMessage(message: UiMessage): Promise<UiMessage> {
        return await this.commitTransientClineMessageByTimestamp(message, false)
    }

    /**
     * Make a complete row visible immediately and synchronously register its durable write.
     *
     * Calling the returned persistence Promise is not what starts the write: the backing
     * store mutex is entered before this method returns. Later message writes therefore
     * queue behind this row even when the physical commit is delayed by a file lock.
     */
    beginDurableClineMessage(message: UiMessage): RegisteredClineMessagePersistence {
        const prepared: UiMessage = { ...this.placeShownRow(message), partial: false }
        this.upsertTransientClineMessage(prepared)
        return {
            message: prepared,
            persistence: this.commitTransientClineMessageByTimestamp(prepared, true),
        }
    }

    /**
     * Show a row that has not settled yet at its presentation place, stamped with
     * where the conversation stands now.
     *
     * The row stays in memory as a partial row until `beginDurableClineMessage`
     * commits it under the same ts, which keeps this place, or
     * `removeTransientClineMessage` drops it. It never reaches disk unsettled.
     */
    holdClineMessage(message: UiMessage): UiMessage {
        return this.upsertTransientClineMessage({ ...this.placeShownRow(message), partial: true })
    }

    /** A row that is already shown keeps the conversation place it was first shown at. */
    private placeShownRow(message: UiMessage): UiMessage {
        const existing = this.clineMessages.find((candidate) => candidate.ts === message.ts)
        return {
            ...existing,
            ...message,
            conversationHistoryIndex:
                existing?.conversationHistoryIndex ?? message.conversationHistoryIndex ?? this.conversationSize() - 1,
            conversationJournalSeq:
                existing?.conversationJournalSeq ?? message.conversationJournalSeq ?? this.conversation?.position(),
            conversationHistoryDeletedRange:
                existing?.conversationHistoryDeletedRange ??
                message.conversationHistoryDeletedRange ??
                this.metadata.conversationHistoryDeletedRange,
        }
    }

    /** Persist one transient row, optionally replacing the durable row with the same timestamp. */
    private async commitTransientClineMessageByTimestamp(
        message: UiMessage,
        allowDurableReplacement: boolean,
    ): Promise<UiMessage> {
        const transient = this.transientClineMessages.get(message.ts)
        if (!transient) throw new Error(`Transient message ${message.ts} is unavailable for durable commit`)
        const uiMessage = this.uiMessage
        if (!uiMessage) throw new Error("UI message store is unavailable for durable commit")

        const durableIndex = uiMessage.findIndexByTs(message.ts)
        if (!allowDurableReplacement && durableIndex >= 0) {
            throw new Error(`Durable message ${message.ts} already exists`)
        }

        let committed: UiMessage
        if (durableIndex >= 0) {
            committed = await uiMessage.updateMessage(durableIndex, { ...message, partial: false })
            await uiMessage.flush()
        } else if (this.sortsAfterDurableRows(message.ts)) {
            // Rows elsewhere are patched in place and left staged (a request's
            // cost, a dialog anchor) until the store's timer commits them. A new
            // row must not depend on that timer having run first.
            committed = await uiMessage.commitPendingAndAppendDurable({ ...message, partial: false })
        } else {
            // A row shown before rows written while it was settling keeps that place
            // on disk too: restore truncates the stored sequence by position, so the
            // stored order must be the presentation order.
            committed = (await uiMessage.upsertMessage({ ...message, partial: false })).message
            await uiMessage.flush()
        }

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

    /** Whether a new row would follow every stored row in presentation order. */
    private sortsAfterDurableRows(ts: number): boolean {
        const stored = this.durableClineMessages
        const last = stored[stored.length - 1]
        return last === undefined || last.ts < ts
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
        const message = this.clineMessages[index]
        const storedIndex = message ? (this.uiMessage?.findIndexByTs(message.ts) ?? -1) : -1
        if (storedIndex >= 0) await this.uiMessage?.flushMessage(storedIndex)
        await this.updateTaskHistoryOnly()
    }

    /**
     * Flush multiple messages to disk.
     */
    async flushMessageUpdates(indices: number[]): Promise<void> {
        const messages = this.clineMessages
        const storedIndices = indices
            .map((index) => (messages[index] ? (this.uiMessage?.findIndexByTs(messages[index].ts) ?? -1) : -1))
            .filter((index) => index >= 0)
        await this.uiMessage?.flushMessages(storedIndices)
        await this.updateTaskHistoryOnly()
    }

    /**
     * Update a specific message in the clineMessages array and mark it for persistence.
     */
    async updateClineMessage(index: number, updates: Partial<UiMessage>): Promise<void> {
        const all = this.clineMessages
        if (index < 0 || index >= all.length) {
            throw new Error(`Invalid message index: ${index}`)
        }
        const previousMessage = { ...all[index] }
        if (this.transientClineMessages.has(previousMessage.ts)) {
            this.upsertTransientClineMessage({ ...previousMessage, ...updates })
            return
        }
        const storedIndex = this.uiMessage?.findIndexByTs(previousMessage.ts) ?? -1
        if (storedIndex >= 0) await this.uiMessage?.updateMessage(storedIndex, updates)

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
        const storedIndex = this.uiMessage?.findIndexByTs(previousMessage.ts) ?? -1
        if (storedIndex >= 0) await this.uiMessage?.deleteMessage(storedIndex)
        this.transientClineMessages.delete(previousMessage.ts)

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
