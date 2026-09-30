import fs, { type FileHandle } from "node:fs/promises"
import { ClineStorageMessage } from "@shared/messages/content"
import { normalizeLegacyConversation, requiresLegacyConversationMigration } from "@shared/messages/legacy-identity-migration"
import { fileExistsAtPath } from "@utils/fs"
import path from "path"
import type { BufferedUnifyStore } from "./backend/api/UnifyStore"
import { openBufferedJsonlStore } from "./backend/jsonl/JsonlUnifyStore"
import { readJsonl } from "./backend/jsonl/jsonl-utils"
import { ensureTaskDirectoryExists, GlobalFileNames, getDlineDocumentsPath } from "./disk"

export interface ApiConversationWindowOptions {
	readonly tailStartIndex: number
	readonly requiredIndices?: readonly number[]
	readonly signal?: AbortSignal
}

export interface ApiConversationReadWindow {
	readonly historyLength: number
	readonly tailStartIndex: number
	readonly tail: readonly ClineStorageMessage[]
	/** Exact retained records; no sparse array or invented history rows. */
	getAt(index: number): ClineStorageMessage | undefined
	/** Legacy compatibility only; canonical JSONL keeps just the requested suffix. */
	readonly completeHistory?: readonly ClineStorageMessage[]
}

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

interface InspectedApiWindow {
	historyLength: number
	tail: ClineStorageMessage[]
	selected: Map<number, ClineStorageMessage>
	requiresMigration: boolean
}

/** Scan once without retaining already-checkpointed request bodies. */
async function inspectApiWindow(filePath: string, options: ApiConversationWindowOptions): Promise<InspectedApiWindow> {
	const result: InspectedApiWindow = { historyLength: 0, tail: [], selected: new Map(), requiresMigration: false }
	let handle: FileHandle
	try {
		handle = await fs.open(filePath, "r")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result
		throw error
	}
	try {
		const { size } = await handle.stat()
		const prefix = Buffer.alloc(Math.min(size, 4_096))
		await handle.read(prefix, 0, prefix.length, 0)
		if (prefix.toString("utf8").trimStart().startsWith("[")) {
			result.requiresMigration = true
			return result
		}
		const required = new Set(options.requiredIndices ?? [])
		const timestamps = new Set<number>()
		for await (const value of readApiJsonlRows(handle, size, options.signal)) {
			const message = value as ClineStorageMessage | undefined
			if (
				!message ||
				typeof message.ts !== "number" ||
				!Number.isFinite(message.ts) ||
				message.ts <= 0 ||
				timestamps.has(message.ts) ||
				requiresLegacyConversationMigration([message])
			) {
				result.requiresMigration = true
				return result
			}
			timestamps.add(message.ts)
			const index = result.historyLength++
			if (index >= options.tailStartIndex) result.tail.push(message)
			if (required.has(index)) result.selected.set(index, message)
		}
		return result
	} finally {
		await handle.close()
	}
}

async function* readApiJsonlRows(handle: FileHandle, size: number, signal?: AbortSignal): AsyncGenerator<unknown> {
	let position = 0
	let pending = Buffer.alloc(0)
	const parse = (line: Buffer): { value: unknown } | undefined => {
		const text = line.toString("utf8").trim()
		if (!text) return undefined
		try {
			return { value: JSON.parse(text) }
		} catch {
			return undefined
		}
	}
	while (position < size) {
		signal?.throwIfAborted()
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position))
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
		if (bytesRead === 0) break
		const current = chunk.subarray(0, bytesRead)
		const data = pending.length ? Buffer.concat([pending, current]) : current
		let start = 0
		for (let index = 0; index < data.length; index++) {
			if (data[index] !== 0x0a) continue
			const parsed = parse(data.subarray(start, index))
			if (parsed) yield parsed.value
			start = index + 1
		}
		pending = Buffer.from(data.subarray(start))
		position += bytesRead
	}
	signal?.throwIfAborted()
	const parsed = parse(pending)
	if (parsed) yield parsed.value
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
		const targetNeedsMigration =
			targetExists && (await inspectApiWindow(filePath, { tailStartIndex: Number.MAX_SAFE_INTEGER })).requiresMigration
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

	/** Read stopped recovery facts without opening a writer or a full buffered cache. */
	static async readWindow(taskId: string, options: ApiConversationWindowOptions): Promise<ApiConversationReadWindow> {
		if (!Number.isInteger(options.tailStartIndex) || options.tailStartIndex < 0) {
			throw new Error("API conversation window requires a non-negative integer tail boundary")
		}
		options.signal?.throwIfAborted()
		const directory = path.join(await getDlineDocumentsPath(), "tasks", taskId)
		const canonicalPath = path.join(directory, GlobalFileNames.apiConversationHistory)
		const filePath = (await fileExistsAtPath(canonicalPath))
			? canonicalPath
			: path.join(directory, "api_conversation_history.json")
		const inspected = await inspectApiWindow(filePath, options)
		if (inspected.requiresMigration) {
			const history = normalizeIndexedApiMessages(await readJsonl<unknown>(filePath))
			options.signal?.throwIfAborted()
			return {
				historyLength: history.length,
				tailStartIndex: options.tailStartIndex,
				tail: history.slice(options.tailStartIndex),
				getAt: (index) => history[index],
				completeHistory: history,
			}
		}
		return {
			historyLength: inspected.historyLength,
			tailStartIndex: options.tailStartIndex,
			tail: inspected.tail,
			getAt: (index) =>
				index >= options.tailStartIndex ? inspected.tail[index - options.tailStartIndex] : inspected.selected.get(index),
		}
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
