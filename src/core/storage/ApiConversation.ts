import { ClineStorageMessage } from "@shared/messages/content"
import { normalizeLegacyConversation, requiresLegacyConversationMigration } from "@shared/messages/legacy-identity-migration"
import { fileExistsAtPath } from "@utils/fs"
import path from "path"
import type { BufferedUnifyStore } from "./backend/api/UnifyStore"
import { openBufferedJsonlStore } from "./backend/jsonl/JsonlUnifyStore"
import { readJsonl } from "./backend/jsonl/jsonl-utils"
import { ensureTaskDirectoryExists, GlobalFileNames } from "./disk"

/** ClineStorageMessage with the timestamp required by the buffered projection. */
type IndexedApiMessage = ClineStorageMessage & { ts: number }

function requiresIndexedApiMigration(messages: readonly unknown[]): boolean {
	const seenTs = new Set<number>()
	return (
		requiresLegacyConversationMigration(messages) ||
		messages.some((message) => {
			const ts = (message as { ts?: unknown } | undefined)?.ts
			if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0 || seenTs.has(ts)) return true
			seenTs.add(ts)
			return false
		})
	)
}

function assignUniqueApiMessageTs(messages: readonly ClineStorageMessage[]): IndexedApiMessage[] {
	const usedTs = new Set<number>()
	let fallbackTs = Date.now()
	return messages.map((message) => {
		let ts = typeof message.ts === "number" && Number.isFinite(message.ts) && message.ts > 0 ? message.ts : fallbackTs
		while (usedTs.has(ts)) ts = Math.max(ts + 1, fallbackTs)
		usedTs.add(ts)
		fallbackTs = Math.max(fallbackTs, ts + 1)
		return { ...message, ts }
	})
}

function normalizeIndexedApiMessages(messages: readonly unknown[]): IndexedApiMessage[] {
	return assignUniqueApiMessageTs(normalizeLegacyConversation(messages))
}

/**
 * API conversation history store backed by api_conversation_history.jsonl.
 *
 * Uses the backend-neutral buffered layer over the raw JSONL backend.
 */
export class ApiConversation {
	private store: BufferedUnifyStore<IndexedApiMessage>

	private constructor(store: BufferedUnifyStore<IndexedApiMessage>) {
		this.store = store
	}

	/** Open (or create) the api_conversation_history.jsonl for a given task. */
	static async open(taskId: string): Promise<ApiConversation> {
		const dir = await ensureTaskDirectoryExists(taskId)
		const filePath = path.join(dir, GlobalFileNames.apiConversationHistory)
		const targetExists = await fileExistsAtPath(filePath)
		const targetNeedsMigration = targetExists && requiresIndexedApiMigration(await readJsonl<unknown>(filePath))
		const store = await openBufferedJsonlStore<IndexedApiMessage>(filePath, {
			schemaId: "api-conversation-message",
			ensureUniqueAppendTimestamp: true,
			acceptInitialItem: (message) => message.ts > 0,
		})

		if (!targetExists) {
			const legacyPath = path.join(dir, "api_conversation_history.json")
			if (await fileExistsAtPath(legacyPath)) {
				const legacyMessages = await readJsonl<unknown>(legacyPath)
				if (legacyMessages.length > 0) {
					await store.mutate((current) =>
						current.length > 0
							? requiresIndexedApiMigration(current)
								? normalizeIndexedApiMessages(current)
								: current
							: normalizeIndexedApiMessages(legacyMessages),
					)
				}
			}
		} else if (targetNeedsMigration) {
			await store.mutate((current) =>
				requiresIndexedApiMigration(current) ? normalizeIndexedApiMessages(current) : current,
			)
		}
		return new ApiConversation(store)
	}

	// ── Read ──
	getAll(): ReadonlyArray<IndexedApiMessage> {
		return this.store.getAll()
	}
	getByTs(ts: number): IndexedApiMessage | undefined {
		return this.store.getByTimestamp(ts)
	}
	getAt(index: number): IndexedApiMessage | undefined {
		return this.store.getAt(index)
	}
	findIndexByTs(ts: number): number {
		return this.store.findTimestampIndex(ts)
	}
	get count(): number {
		return this.store.count
	}

	/**
	 * Return the last (most recent) entry, or undefined if empty.
	 * Useful for retrieving modelInfo from the most recent message.
	 */
	getLast(): IndexedApiMessage | undefined {
		const all = this.store.getAll()
		return all.length > 0 ? all[all.length - 1] : undefined
	}

	// ── Write ──

	/**
	 * Append a message with automatic ts assignment.
	 * If the message lacks a ts, it is assigned Date.now().
	 */
	async addMessage(msg: ClineStorageMessage): Promise<void> {
		const ts = msg.ts === undefined || msg.ts === null ? Date.now() : msg.ts
		await this.store.append({ ...msg, ts } as IndexedApiMessage)
	}

	/**
	 * Truncate the store, keeping only entries with ts < beforeTs.
	 */
	async truncate(beforeTs: number): Promise<void> {
		await this.store.truncateBeforeTimestamp(beforeTs)
	}

	/**
	 * Truncate by virtual row count.  Keeps the first `count` rows.
	 */
	async truncateByLineNum(count: number): Promise<void> {
		await this.store.truncateAt(count)
	}

	/**
	 * Clear all entries.
	 */
	async clear(): Promise<void> {
		await this.store.clear()
	}

	/** Force flush any pending dirty data to disk (cross-process safe). */
	async flush(): Promise<void> {
		await this.store.flush()
	}

	/**
	 * ⚠️ DANGEROUS: Overwrite all messages via a cross-process transaction.
	 * Auto-assigns ts for entries that lack it.
	 * Prefer incremental operations (addMessage/truncate) when possible.
	 */
	async overwrite(messages: ClineStorageMessage[]): Promise<void> {
		await this.store.replaceAll(assignUniqueApiMessageTs(messages))
	}

	/**
	 * Insert a message at the given position.
	 */
	async insertAt(index: number, msg: ClineStorageMessage): Promise<void> {
		if (msg.ts === undefined || msg.ts === null) {
			;(msg as unknown as Record<string, unknown>).ts = Date.now()
		}
		await this.store.insertAt(index, msg as IndexedApiMessage)
	}

	/**
	 * Update a message at the given position.
	 */
	async updateAt(index: number, msg: ClineStorageMessage): Promise<void> {
		if (msg.ts === undefined || msg.ts === null) {
			;(msg as unknown as Record<string, unknown>).ts = Date.now()
		}
		await this.store.stageUpdateAt(index, msg as IndexedApiMessage)
	}

	/**
	 * Delete a message at the given position.
	 */
	async deleteAt(index: number): Promise<void> {
		await this.store.removeAt(index)
	}

	/** Stop accepting messages and wait until all pending data is durable. */
	async close(): Promise<void> {
		await this.store.close()
	}
}
