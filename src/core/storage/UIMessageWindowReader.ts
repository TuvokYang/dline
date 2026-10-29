import { normalizeStoredCheckpointMessage } from "@shared/checkpoints"
import type { UiMessage } from "@/shared/ExtensionMessage"
import type { InstanceLayout } from "./instance"
import { readLegacyUiMessages, readLegacyUiMessageWindow } from "./messages/importLegacyUiMessages"
import { openStoredUiMessageRows } from "./messages/openUiMessageRows"
import type { UiMessageRowStore } from "./messages/UiMessageRowStore"

export interface UIMessageWindowPage {
    messages: UiMessage[]
    totalCount: number
    startIndex: number
}

/** First index of a page of `pageSize` items centred on `anchor` in a sequence of `total`, clamped to the sequence. */
export function centredPageStart(anchor: number, pageSize: number, total: number): number {
    return Math.max(0, Math.min(anchor - Math.floor(pageSize / 2), total - pageSize))
}

/** Index of the last message carrying `timestamp`, which is the one a ts-deduplicating reader keeps. */
export function lastIndexOfTimestamp(messages: readonly UiMessage[], timestamp: number): number | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].ts === timestamp) return index
    }
    return undefined
}

/**
 * The page of `messages` centred on the message with `anchorTs`, located in
 * the very sequence the page is cut from; an absent anchor yields an empty page.
 */
export function anchoredPage(
    messages: readonly UiMessage[],
    anchorTs: number,
    count: number,
): UIMessageWindowPage & { anchorFound: boolean } {
    const pageSize = Math.max(0, Math.trunc(count))
    const totalCount = messages.length
    const anchor = lastIndexOfTimestamp(messages, anchorTs)
    if (anchor === undefined) return { messages: [], totalCount, startIndex: 0, anchorFound: false }
    const startIndex = centredPageStart(anchor, pageSize, totalCount)
    return { messages: messages.slice(startIndex, startIndex + pageSize), totalCount, startIndex, anchorFound: true }
}

/** Where a window reads its messages from. */
interface WindowSource {
    readonly count: number
    /** Whether row positions are the ones the task's `messages.db` gives them. */
    readonly canonicalIndexes: boolean
    read(start: number, end: number): Promise<UiMessage[]>
    findByTimestamp(timestamp: number): Promise<UiMessage | undefined>
    /** Position of the last row stored with `timestamp`, the one the chat shows for it. */
    ordinalOfTimestamp(timestamp: number): Promise<number | undefined>
    findLastAsk(interactionId: string): Promise<UiMessage | undefined>
    close(): Promise<void>
}

/** Rows of `messages.db`, read one page at a time. */
class RowSource implements WindowSource {
    readonly canonicalIndexes = true

    constructor(
        private readonly rows: UiMessageRowStore,
        readonly count: number,
    ) {}

    async read(start: number, end: number): Promise<UiMessage[]> {
        return (await this.rows.readRange(start, end)).map((record) => normalizeStoredCheckpointMessage(record.message))
    }

    async ordinalOfTimestamp(timestamp: number): Promise<number | undefined> {
        return (await this.rows.findLastByTimestamp(timestamp))?.ordinal
    }

    async findByTimestamp(timestamp: number): Promise<UiMessage | undefined> {
        return normalizeRow((await this.rows.findLastByTimestamp(timestamp))?.message)
    }

    async findLastAsk(interactionId: string): Promise<UiMessage | undefined> {
        return normalizeRow((await this.rows.findLastAskByInteractionId(interactionId))?.message)
    }

    close(): Promise<void> {
        return this.rows.close()
    }
}

/** A legacy history that has not been imported yet because the task was not opened since the upgrade. */
class LegacySource implements WindowSource {
    /** The import renumbers the rows, and a first-surface window holds only the latest of them. */
    readonly canonicalIndexes = false

    constructor(private readonly messages: readonly UiMessage[]) {}

    get count(): number {
        return this.messages.length
    }

    async read(start: number, end: number): Promise<UiMessage[]> {
        return this.messages.slice(start, end)
    }

    async ordinalOfTimestamp(timestamp: number): Promise<number | undefined> {
        return lastIndexOfTimestamp(this.messages, timestamp)
    }

    async findByTimestamp(timestamp: number): Promise<UiMessage | undefined> {
        return this.messages.find((message) => message.ts === timestamp)
    }

    async findLastAsk(interactionId: string): Promise<UiMessage | undefined> {
        for (let index = this.messages.length - 1; index >= 0; index--) {
            const message = this.messages[index]
            if (message.type === "ask" && message.interactionId === interactionId) return message
        }
        return undefined
    }

    async close(): Promise<void> {}
}

const LEGACY_FIRST_SURFACE_MESSAGE_COUNT = 400

async function openLegacySource(instanceRoot: string): Promise<LegacySource> {
    const window = await readLegacyUiMessageWindow(instanceRoot, LEGACY_FIRST_SURFACE_MESSAGE_COUNT)
    if (window) return new LegacySource(window.messages)
    const legacy = await readLegacyUiMessages(instanceRoot)
    return new LegacySource(legacy?.messages ?? [])
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

    /** Opening never creates the instance directory or `messages.db`; absent storage reads as empty. */
    static async open(layout: InstanceLayout): Promise<UIMessageWindowReader> {
        const rows = await openStoredUiMessageRows(layout.root)
        if (!rows) return new UIMessageWindowReader(await openLegacySource(layout.root))
        try {
            const count = await rows.count()
            if (count > 0) return new UIMessageWindowReader(new RowSource(rows, count))
            const legacyWindow = await readLegacyUiMessageWindow(layout.root, LEGACY_FIRST_SURFACE_MESSAGE_COUNT)
            if (legacyWindow) {
                await rows.close()
                return new UIMessageWindowReader(new LegacySource(legacyWindow.messages))
            }
            const legacy = await readLegacyUiMessages(layout.root)
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

    /**
     * Whether page positions stay valid once the task's writer opens it. A
     * legacy history is renumbered by its import, so positions read here then
     * address other rows.
     */
    get canonicalIndexes(): boolean {
        return this.source.canonicalIndexes
    }

    async getLatest(limit: number): Promise<UiMessage[]> {
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

    async getByTimestamp(timestamp: number): Promise<UiMessage | undefined> {
        this.assertOpen()
        return await this.source.findByTimestamp(timestamp)
    }

    /** Position of the durable row with `timestamp` in the window's sequence, or undefined when none has it. */
    async ordinalOfTimestamp(timestamp: number): Promise<number | undefined> {
        this.assertOpen()
        return await this.source.ordinalOfTimestamp(timestamp)
    }

    /**
     * The last ask row revealed for `interactionId`, wherever it sits in the history.
     *
     * An interaction stays answerable after later rows push its anchor out of the
     * latest window, so the anchor is looked up by identity rather than by page.
     */
    async getLastAsk(interactionId: string): Promise<UiMessage | undefined> {
        this.assertOpen()
        return await this.source.findLastAsk(interactionId)
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

function normalizeRow(message: UiMessage | undefined): UiMessage | undefined {
    return message ? normalizeStoredCheckpointMessage(message) : undefined
}
