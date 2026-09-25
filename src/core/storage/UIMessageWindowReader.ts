import type { ClineMessage } from "@/shared/ExtensionMessage"
import { readLegacyUiMessages } from "./messages/importLegacyUiMessages"
import { openUiMessageRows, UI_MESSAGE_READER } from "./messages/openUiMessageRows"
import type { UiMessageRowStore } from "./messages/UiMessageRowStore"

export interface UIMessageWindowPage {
	messages: ClineMessage[]
	totalCount: number
	startIndex: number
}

/** Where a window reads its messages from. */
interface WindowSource {
	readonly count: number
	read(start: number, end: number): Promise<ClineMessage[]>
	findByTimestamp(timestamp: number): Promise<ClineMessage | undefined>
	close(): Promise<void>
}

/** Rows of `messages.db`, read one page at a time. */
class RowSource implements WindowSource {
	constructor(
		private readonly rows: UiMessageRowStore,
		readonly count: number,
	) {}

	async read(start: number, end: number): Promise<ClineMessage[]> {
		return (await this.rows.readRange(start, end)).map((record) => record.message)
	}

	async findByTimestamp(timestamp: number): Promise<ClineMessage | undefined> {
		return (await this.rows.findLastByTimestamp(timestamp))?.message
	}

	close(): Promise<void> {
		return this.rows.close()
	}
}

/** A legacy history that has not been imported yet because the task was not opened since the upgrade. */
class LegacySource implements WindowSource {
	constructor(private readonly messages: readonly ClineMessage[]) {}

	get count(): number {
		return this.messages.length
	}

	async read(start: number, end: number): Promise<ClineMessage[]> {
		return this.messages.slice(start, end)
	}

	async findByTimestamp(timestamp: number): Promise<ClineMessage | undefined> {
		return this.messages.find((message) => message.ts === timestamp)
	}

	async close(): Promise<void> {}
}

/**
 * Read-only window over the chat history of one instance.
 *
 * Rows come from `messages.db` one page at a time, so a long history is never held
 * whole. The reader never writes: a task that still only has a legacy file is read
 * from that file and imported later by the task's own writer. The message count is
 * fixed when the reader opens.
 */
export class UIMessageWindowReader {
	private closed = false

	private constructor(private readonly source: WindowSource) {}

	static async open(instanceRoot: string): Promise<UIMessageWindowReader> {
		const rows = await openUiMessageRows(instanceRoot, UI_MESSAGE_READER)
		try {
			const count = await rows.count()
			if (count > 0) return new UIMessageWindowReader(new RowSource(rows, count))
			const legacy = await readLegacyUiMessages(instanceRoot)
			if (!legacy) return new UIMessageWindowReader(new RowSource(rows, 0))
			await rows.close()
			return new UIMessageWindowReader(new LegacySource(legacy.messages))
		} catch (error) {
			await rows.close().catch(() => undefined)
			throw error
		}
	}

	get count(): number {
		return this.source.count
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
		const messages = endIndex > startIndex ? await this.source.read(startIndex, endIndex) : []
		return { messages, totalCount, startIndex }
	}

	async getByTimestamp(timestamp: number): Promise<ClineMessage | undefined> {
		this.assertOpen()
		return await this.source.findByTimestamp(timestamp)
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		await this.source.close()
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("UIMessageWindowReader is closed")
	}
}
