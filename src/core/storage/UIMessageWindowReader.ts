import fs, { type FileHandle } from "node:fs/promises"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { readJsonl } from "./backend/jsonl/jsonl-utils"

const READ_CHUNK_BYTES = 64 * 1024
const LEGACY_ARRAY_PROBE_BYTES = 4 * 1024

interface MessageRecordLocation {
	ts: number
	offset: number
	length: number
	ordinal: number
}

export interface UIMessageWindowPage {
	messages: ClineMessage[]
	totalCount: number
	startIndex: number
}

/**
 * Read-only index over one historical UI JSONL file.
 *
 * Canonical JSONL keeps only byte offsets and timestamps resident. Message bodies
 * are parsed only for the requested page. Legacy JSON arrays use an in-memory
 * compatibility fallback because they do not expose record boundaries.
 */
export class UIMessageWindowReader {
	private closed = false

	private constructor(
		private handle: FileHandle | undefined,
		private records: MessageRecordLocation[],
		private recordsByTimestamp: Map<number, MessageRecordLocation>,
		private legacyMessages: ClineMessage[] | undefined,
	) {}

	static async open(filePath: string): Promise<UIMessageWindowReader> {
		const handle = await openReadableFile(filePath)
		try {
			const { size } = await handle.stat()
			if (await isLegacyArray(handle, size)) {
				await handle.close()
				const messages = dedupeMessages((await readJsonl<ClineMessage>(filePath)).filter(isStoredMessage))
				return new UIMessageWindowReader(undefined, [], new Map(), messages)
			}

			const records = await buildRecordIndex(handle, size)
			return new UIMessageWindowReader(handle, records, new Map(records.map((record) => [record.ts, record])), undefined)
		} catch (error) {
			await handle.close().catch(() => undefined)
			throw error
		}
	}

	get count(): number {
		return this.legacyMessages?.length ?? this.records.length
	}

	async getLatest(limit: number): Promise<ClineMessage[]> {
		return (await this.getPage(-1, limit)).messages
	}

	async getPage(referenceIndex: number, count: number): Promise<UIMessageWindowPage> {
		this.assertOpen()
		const totalCount = this.count
		const pageSize = Math.max(0, Math.trunc(count))
		const startIndex =
			referenceIndex === -1
				? Math.max(0, totalCount - pageSize)
				: Math.max(0, Math.min(Math.trunc(referenceIndex), totalCount))
		const endIndex = Math.min(startIndex + pageSize, totalCount)

		if (this.legacyMessages) {
			return { messages: this.legacyMessages.slice(startIndex, endIndex), totalCount, startIndex }
		}

		const messages = (
			await Promise.all(this.records.slice(startIndex, endIndex).map((record) => this.readRecord(record)))
		).filter((message): message is ClineMessage => message !== undefined)
		return { messages, totalCount, startIndex }
	}

	async getByTimestamp(timestamp: number): Promise<ClineMessage | undefined> {
		this.assertOpen()
		if (this.legacyMessages) {
			for (let index = this.legacyMessages.length - 1; index >= 0; index--) {
				if (this.legacyMessages[index].ts === timestamp) return this.legacyMessages[index]
			}
			return undefined
		}
		const record = this.recordsByTimestamp.get(timestamp)
		return record ? await this.readRecord(record) : undefined
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		const handle = this.handle
		this.handle = undefined
		this.records = []
		this.recordsByTimestamp.clear()
		this.legacyMessages = undefined
		await handle?.close()
	}

	private async readRecord(record: MessageRecordLocation): Promise<ClineMessage | undefined> {
		const handle = this.handle
		if (!handle) return undefined
		const buffer = Buffer.allocUnsafe(record.length)
		const { bytesRead } = await handle.read(buffer, 0, record.length, record.offset)
		if (bytesRead !== record.length) return undefined
		return parseMessageLine(buffer.subarray(0, bytesRead))
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("UIMessageWindowReader is closed")
	}
}

async function openReadableFile(filePath: string): Promise<FileHandle> {
	try {
		return await fs.open(filePath, "r")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		return await fs.open(filePath, "w+")
	}
}

async function isLegacyArray(handle: FileHandle, size: number): Promise<boolean> {
	if (size === 0) return false
	const length = Math.min(size, LEGACY_ARRAY_PROBE_BYTES)
	const buffer = Buffer.allocUnsafe(length)
	const { bytesRead } = await handle.read(buffer, 0, length, 0)
	const prefix = buffer.subarray(0, bytesRead).toString("utf8")
	const withoutBom = prefix.charCodeAt(0) === 0xfeff ? prefix.slice(1) : prefix
	return withoutBom.trimStart().startsWith("[")
}

async function buildRecordIndex(handle: FileHandle, size: number): Promise<MessageRecordLocation[]> {
	const latestByTimestamp = new Map<number, MessageRecordLocation>()
	let filePosition = 0
	let pending = Buffer.alloc(0)
	let pendingOffset = 0
	let ordinal = 0

	const accept = (line: Buffer, offset: number): void => {
		const message = parseMessageLine(line)
		if (!message) return
		latestByTimestamp.set(message.ts, { ts: message.ts, offset, length: line.length, ordinal })
		ordinal += 1
	}

	while (filePosition < size) {
		const length = Math.min(READ_CHUNK_BYTES, size - filePosition)
		const chunk = Buffer.allocUnsafe(length)
		const { bytesRead } = await handle.read(chunk, 0, length, filePosition)
		if (bytesRead === 0) break
		const current = chunk.subarray(0, bytesRead)
		const dataOffset = pending.length > 0 ? pendingOffset : filePosition
		const data = pending.length > 0 ? Buffer.concat([pending, current]) : current
		let lineStart = 0
		for (let index = 0; index < data.length; index++) {
			if (data[index] !== 0x0a) continue
			accept(data.subarray(lineStart, index), dataOffset + lineStart)
			lineStart = index + 1
		}
		pending = Buffer.from(data.subarray(lineStart))
		pendingOffset = dataOffset + lineStart
		filePosition += bytesRead
	}
	if (pending.length > 0) accept(pending, pendingOffset)

	return [...latestByTimestamp.values()].sort((left, right) => left.ordinal - right.ordinal)
}

function parseMessageLine(line: Buffer): ClineMessage | undefined {
	const text = line.toString("utf8").trim()
	if (!text) return undefined
	try {
		const value = JSON.parse(text)
		return isStoredMessage(value) ? value : undefined
	} catch {
		return undefined
	}
}

function isStoredMessage(value: unknown): value is ClineMessage {
	if (!value || typeof value !== "object") return false
	const candidate = value as Partial<ClineMessage>
	return candidate.ts !== undefined && candidate.ts > 0 && (candidate.type === "ask" || candidate.type === "say")
}

function dedupeMessages(messages: ClineMessage[]): ClineMessage[] {
	const latestByTimestamp = new Map<number, { message: ClineMessage; ordinal: number }>()
	for (let ordinal = 0; ordinal < messages.length; ordinal++) {
		const message = messages[ordinal]
		latestByTimestamp.set(message.ts, { message, ordinal })
	}
	return [...latestByTimestamp.values()].sort((left, right) => left.ordinal - right.ordinal).map(({ message }) => message)
}
