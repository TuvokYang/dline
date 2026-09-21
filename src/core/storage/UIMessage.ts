import { fileExistsAtPath } from "@utils/fs"
import path from "path"
import { ClineMessage } from "@/shared/ExtensionMessage"
import type { BufferedUnifyStore } from "./backend/api/UnifyStore"
import { openBufferedJsonlStore } from "./backend/jsonl/JsonlUnifyStore"
import { readJsonl, writeJsonl } from "./backend/jsonl/jsonl-utils"
import { dedupeClineMessagesByTs, ensureTaskDirectoryExists, GlobalFileNames } from "./disk"
import { UIMessageWindowReader } from "./UIMessageWindowReader"

async function ensureUiMessageFile(taskId: string): Promise<string> {
	const dir = await ensureTaskDirectoryExists(taskId)
	const filePath = path.join(dir, GlobalFileNames.uiMessages)
	if (await fileExistsAtPath(filePath)) return filePath

	for (const legacyName of ["ui_messages.json", "claude_messages.json"]) {
		const legacyPath = path.join(dir, legacyName)
		if (!(await fileExistsAtPath(legacyPath))) continue
		const legacyMessages = dedupeClineMessagesByTs(await readJsonl<ClineMessage>(legacyPath))
		if (legacyMessages.length > 0) await writeJsonl(filePath, legacyMessages)
		break
	}
	return filePath
}

/**
 * UI messages store backed by ui_messages.jsonl.
 *
 * Uses the backend-neutral buffered layer over the raw JSONL backend.
 */
export class UIMessage {
	private store: BufferedUnifyStore<ClineMessage>

	private constructor(store: BufferedUnifyStore<ClineMessage>) {
		this.store = store
	}

	/** Open (or create) the writable ui_messages.jsonl for a given task. */
	static async open(taskId: string): Promise<UIMessage> {
		const filePath = await ensureUiMessageFile(taskId)
		const store = await openBufferedJsonlStore<ClineMessage>(filePath, {
			schemaId: "ui-message",
			acceptInitialItem: (message) => message.ts > 0,
		})
		const stored = store.getAll()
		if (new Set(stored.map((message) => message.ts)).size !== stored.length) {
			await store.mutate((current) => dedupeClineMessagesByTs(current))
		}
		return new UIMessage(store)
	}

	/** Open a bounded read-only historical window without materializing every message body. */
	static async openWindow(taskId: string): Promise<UIMessageWindowReader> {
		return await UIMessageWindowReader.open(await ensureUiMessageFile(taskId))
	}

	// ── Read ──
	getAll(): ReadonlyArray<ClineMessage> {
		return this.store.getAll()
	}
	getByTs(ts: number): ClineMessage | undefined {
		return this.store.getByTimestamp(ts)
	}
	getAt(index: number): ClineMessage | undefined {
		return this.store.getAt(index)
	}
	findIndexByTs(ts: number): number {
		return this.store.findTimestampIndex(ts)
	}
	get count(): number {
		return this.store.count
	}

	// ── Low-level Write (delegated) ──
	async append(msg: ClineMessage): Promise<void> {
		await this.store.append(msg)
	}
	async appendDurable(msg: ClineMessage): Promise<ClineMessage> {
		return await this.store.appendDurable(msg)
	}
	async truncate(beforeTs: number): Promise<void> {
		await this.store.truncateBeforeTimestamp(beforeTs)
	}
	async overwrite(items: ClineMessage[]): Promise<void> {
		await this.store.replaceAll(items)
	}
	async insertAt(index: number, msg: ClineMessage): Promise<void> {
		await this.store.insertAt(index, msg)
	}
	async updateAt(index: number, msg: ClineMessage): Promise<void> {
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
	async addMessage(msg: ClineMessage): Promise<{ index: number; message: ClineMessage }> {
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
	async upsertMessage(msg: ClineMessage): Promise<{ index: number; message: ClineMessage }> {
		const all = this.store.getAll() as ClineMessage[]
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
	async finalizeMessage(msg: ClineMessage): Promise<ClineMessage> {
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
	async updateMessage(index: number, updates: Partial<ClineMessage>): Promise<ClineMessage> {
		return await this.store.stagePatchAt(index, updates)
	}

	/**
	 * Delete a message at the given index.
	 *
	 * @param index Zero-based index
	 * @returns The deleted message
	 */
	async deleteMessage(index: number): Promise<ClineMessage> {
		const all = this.store.getAll() as ClineMessage[]
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
			const kept = (items as unknown as ClineMessage[]).filter((m) => m.partial !== true)
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
			const kept = (items as unknown as ClineMessage[]).filter((m) => !tsSet.has(m.ts))
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
		const all = this.store.getAll() as ClineMessage[]
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
