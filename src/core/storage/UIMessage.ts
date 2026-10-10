import { normalizeStoredCheckpointMessage } from "@shared/checkpoints"
import path from "path"
import { UiMessage } from "@/shared/ExtensionMessage"
import type { BufferedUnifyStore } from "./backend/api/UnifyStore"
import { BufferedUnifyStore as BufferedStore } from "./backend/core/BufferedUnifyStore"
import { dedupeClineMessagesByTs } from "./disk"
import { ensureInstanceLayout, InstanceDatabase, resolveInstanceLayout } from "./instance"
import { importLegacyUiMessages } from "./messages/importLegacyUiMessages"
import { openUiMessageRows, UI_MESSAGE_WRITER } from "./messages/openUiMessageRows"
import { UI_MESSAGE_ORDINAL, UI_MESSAGE_TIMESTAMP } from "./messages/UiMessageRowStore"
import type { UiMessageRecord } from "./messages/UiMessageRows"
import { UIMessageWindowReader } from "./UIMessageWindowReader"

function subscriptionKey(databasePath: string): string {
    const resolved = path.resolve(databasePath)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * Chat history of one task, stored in the task's `messages.db`.
 *
 * This store is the only writer of that database. A legacy `ui_messages.jsonl` (or
 * older JSON file) is imported once on open and then renamed to `<name>.migrated`.
 */
export class UIMessage {
    private store: BufferedUnifyStore<UiMessage>

    private constructor(store: BufferedUnifyStore<UiMessage>) {
        this.store = store
    }

    /** Opens the writable chat history of a task, importing a legacy file first. */
    static async open(taskId: string): Promise<UIMessage> {
        const layout = await ensureInstanceLayout({ taskId })
        const rows = await openUiMessageRows(layout.root, UI_MESSAGE_WRITER)
        try {
            await importLegacyUiMessages(layout.root, rows)
        } catch (error) {
            await rows.close().catch(() => undefined)
            throw error
        }
        const store = await BufferedStore.open<UiMessageRecord, UiMessage>({
            store: rows,
            mapping: {
                ordinal: UI_MESSAGE_ORDINAL,
                timestamp: UI_MESSAGE_TIMESTAMP,
                toItem: (record) => record.message,
                toEntity: (message, ordinal) => ({ ordinal, ts: message.ts, message }),
            },
            bufferOptions: {
                subscriptionKey: subscriptionKey(layout.database(InstanceDatabase.Messages)),
                storeKind: "ui_message",
                acceptInitialItem: (message) => message.ts > 0,
            },
        })
        const stored = store.getAll()
        // Rows written before checkpoint references became multi-root carry a scalar hash.
        const hasLegacyCheckpointHash = stored.some(
            (message) => typeof (message as { lastCheckpointHash?: unknown }).lastCheckpointHash === "string",
        )
        if (new Set(stored.map((message) => message.ts)).size !== stored.length || hasLegacyCheckpointHash) {
            await store.mutate((current) => dedupeClineMessagesByTs(current).map(normalizeStoredCheckpointMessage))
        }
        return new UIMessage(store)
    }

    /**
     * Opens a bounded read-only window over a task's history.
     *
     * It never writes: a missing task directory, database or legacy file yields an
     * empty window instead of creating anything on disk.
     */
    static async openWindow(taskId: string): Promise<UIMessageWindowReader> {
        const layout = await resolveInstanceLayout({ taskId })
        return await UIMessageWindowReader.open(layout)
    }

    // ── Read ──
    getAll(): ReadonlyArray<UiMessage> {
        return this.store.getAll()
    }
    getByTs(ts: number): UiMessage | undefined {
        return this.store.getByTimestamp(ts)
    }
    getAt(index: number): UiMessage | undefined {
        return this.store.getAt(index)
    }
    findIndexByTs(ts: number): number {
        return this.store.findTimestampIndex(ts)
    }
    get count(): number {
        return this.store.count
    }

    // ── Low-level Write (delegated) ──
    async append(msg: UiMessage): Promise<void> {
        await this.store.append(msg)
    }
    async appendDurable(msg: UiMessage): Promise<UiMessage> {
        return await this.store.appendDurable(msg)
    }
    /** Commit any staged rewrite, then append one row durably, without another write in between. */
    async commitPendingAndAppendDurable(msg: UiMessage): Promise<UiMessage> {
        return await this.store.commitPendingAndAppendDurable(msg)
    }
    async truncate(beforeTs: number): Promise<void> {
        await this.store.truncateBeforeTimestamp(beforeTs)
    }
    async overwrite(items: UiMessage[]): Promise<void> {
        await this.store.replaceAll(items)
    }
    async insertAt(index: number, msg: UiMessage): Promise<void> {
        await this.store.insertAt(index, msg)
    }
    async updateAt(index: number, msg: UiMessage): Promise<void> {
        await this.store.stageUpdateAt(index, msg)
    }
    async deleteAt(index: number): Promise<void> {
        await this.store.removeAt(index)
    }
    async clear(): Promise<void> {
        await this.store.clear()
    }
    async truncateByLineNum(count: number): Promise<void> {
        await this.store.truncateAt(count)
    }
    /** Force flush any pending dirty data to disk (cross-process safe). */
    async flush(): Promise<void> {
        await this.store.flush()
    }

    // ── Business-level methods ──

    /**
     * Add a message, handling partial/complete state automatically.
     * Partial messages are upserted in-memory only (no disk write).
     * Complete messages are appended to both cache and disk.
     *
     * @returns The index and message as stored
     */
    async addMessage(msg: UiMessage): Promise<{ index: number; message: UiMessage }> {
        if (msg.partial === true) {
            return this.upsertMessage(msg)
        }

        // Complete message — append to cache + disk
        await this.store.append(msg)
        return { index: this.store.count - 1, message: msg }
    }

    /**
     * Upsert a message in memory by ts (no disk write).
     * If ts exists — replace in-place. If not — insert at ascending ts position.
     * Memory-layer only; disk sync is handled by flush timer.
     *
     * @param msg The message to upsert
     * @returns The index and message as stored
     */
    async upsertMessage(msg: UiMessage): Promise<{ index: number; message: UiMessage }> {
        const all = this.store.getAll() as UiMessage[]
        const existingIndex = all.findIndex((m) => m.ts === msg.ts)

        if (existingIndex >= 0) {
            // Same ts — update through the store so close/flush observes the latest delta.
            const updated = await this.store.stagePatchAt(existingIndex, msg)
            return { index: existingIndex, message: updated }
        }

        // New ts — find insertion point in ascending order, insert via memory-layer API
        let insertIndex = all.length
        for (let i = 0; i < all.length; i++) {
            if (all[i].ts > msg.ts) {
                insertIndex = i
                break
            }
        }
        await this.store.stageInsertAt(insertIndex, msg)
        return { index: insertIndex, message: msg }
    }

    /**
     * Finalize a partial message: set partial=false and persist to disk.
     * Uses upsertByTs for idempotent write (replace if exists, append if new).
     *
     * @param msg The finalized message (partial must be false)
     * @returns The finalized message
     */
    async finalizeMessage(msg: UiMessage): Promise<UiMessage> {
        msg.partial = false
        await this.store.stageUpsertByTimestamp(msg)
        return msg
    }

    /**
     * Update a message at the given index and mark it for the next flush.
     * For streaming chunk updates — disk persistence happens at key lifecycle points.
     *
     * @param index Zero-based index in the message array
     * @param updates Partial fields to merge into the existing message
     * @returns The updated message
     */
    async updateMessage(index: number, updates: Partial<UiMessage>): Promise<UiMessage> {
        return await this.store.stagePatchAt(index, updates)
    }

    /**
     * Delete a message at the given index.
     *
     * @param index Zero-based index
     * @returns The deleted message
     */
    async deleteMessage(index: number): Promise<UiMessage> {
        const all = this.store.getAll() as UiMessage[]
        if (index < 0 || index >= all.length) {
            throw new Error(`UIMessage.deleteMessage: index ${index} out of range [0, ${all.length})`)
        }
        const deleted = all[index]
        await this.store.removeAt(index)
        return deleted
    }

    /**
     * Flush a single message to disk (incremental append).
     * Skips partial messages.
     *
     * @param index Zero-based index
     */
    async flushMessage(index: number): Promise<void> {
        const msg = this.store.getAt(index)
        if (!msg || msg.partial) return
        await this.store.stageUpsertByTimestamp(msg)
        await this.store.flush()
    }

    /**
     * Flush multiple messages to disk.
     *
     * @param indices Array of indices to flush
     */
    async flushMessages(indices: number[]): Promise<void> {
        for (const idx of indices) {
            await this.flushMessage(idx)
        }
    }

    /**
     * Remove all partial messages in a single cross-process transaction.
     *
     * @returns Number of messages removed
     */
    async removePartialMessages(): Promise<number> {
        let removed = 0
        await this.store.mutate((items) => {
            const before = items.length
            const kept = (items as unknown as UiMessage[]).filter((m) => m.partial !== true)
            removed = before - kept.length
            return kept as unknown as typeof items
        })
        return removed
    }

    /**
     * Remove messages by their ts values in a single cross-process transaction.
     *
     * @param tsList Timestamps to remove
     * @returns Number of messages removed
     */
    async removeByTs(tsList: number[]): Promise<number> {
        if (tsList.length === 0) return 0
        const tsSet = new Set(tsList)
        let removed = 0
        await this.store.mutate((items) => {
            const before = items.length
            const kept = (items as unknown as UiMessage[]).filter((m) => !tsSet.has(m.ts))
            removed = before - kept.length
            return kept as unknown as typeof items
        })
        return removed
    }

    /**
     * Clear partial flag on all in-memory messages.
     * Partial messages are never persisted to disk, so this is memory-only.
     */
    clearPartialFlags(): void {
        const all = this.store.getAll() as UiMessage[]
        for (const msg of all) {
            if (msg.partial === true) {
                msg.partial = false
            }
        }
    }

    /**
     * Force-load all entries from disk into the in-memory cache.
     */
    async reload(): Promise<void> {
        await this.store.reload()
    }

    /** Stop accepting messages and wait until all pending data is durable. */
    async close(): Promise<void> {
        await this.store.close()
    }
}
