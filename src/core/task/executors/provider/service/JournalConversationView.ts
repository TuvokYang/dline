import type { ClineStorageMessage } from "@shared/messages/content"
import type { ConversationHistoryReader } from "../../../conversation/ConversationHistoryReader"
import type { ConversationJournal, JournalEntry, JournalWatermark } from "../../../stores"
import type { MaterializedPayload, ProviderJournalMessageMaterializer } from "./ProviderJournalMessageMaterializer"
import { repairProviderPairing } from "./ProviderPairingRepair"

/** One visible journal entry together with what it contributes to the provider conversation. */
export interface ConversationViewEntry extends MaterializedPayload {
    readonly entry: JournalEntry & { readonly payloadRef: string }
}

type PayloadEntry = JournalEntry & { readonly payloadRef: string }

function hasPayload(entry: JournalEntry): entry is PayloadEntry {
    return entry.payloadRef !== undefined
}

/**
 * The provider conversation of one task, held in memory.
 *
 * A journal payload never changes once written: payloads are addressed by
 * content and the journal only appends. Each payload is therefore rendered
 * once and reused by every later round. Rendering again per round read the
 * whole history back from `journal.db` and re-read attached files, which cost
 * O(history) I/O per request and let an edited attachment silently rewrite a
 * prefix the provider had already cached.
 *
 * A position fixes the conversation: the projection through a watermark never
 * changes, so a draft that records only its position replays byte-identical
 * messages on retry or recovery.
 *
 * Messages are shared between rounds; callers must treat them as immutable.
 */
export class JournalConversationView implements ConversationHistoryReader {
    private readonly rendered = new Map<string, Promise<MaterializedPayload>>()
    private latestSize = 0
    /** Journal position `latestSize` was counted at; -1 before the first count. */
    private countedThrough = -1

    constructor(
        private readonly journal: ConversationJournal,
        private readonly materializer: ProviderJournalMessageMaterializer,
    ) {}

    /**
     * Visible entries through `through`, or through the latest committed entry.
     *
     * Reading the latest position also forgets renders that left the view, such
     * as a span a summary replaced; an older position renders them again on demand.
     */
    async entries(through?: JournalWatermark): Promise<ConversationViewEntry[]> {
        const projection = await this.journal.project(through)
        const visible = projection.visibleMessages.filter(hasPayload)
        const entries: ConversationViewEntry[] = []
        // Sequential on purpose: a first render of a long history may read many
        // attachments, and the order they are read in must not depend on timing.
        for (const entry of visible) entries.push({ entry, ...(await this.render(entry.payloadRef)) })
        const superseded = new Set(entries.flatMap((item) => [...(item.supersededPayloadRefs ?? [])]))
        const canonical = entries.filter((item) => !superseded.has(item.entry.payloadRef))
        if (this.isLatest(projection.through)) {
            this.retainOnly(canonical.map((item) => item.entry))
            this.latestSize = canonical.reduce((count, item) => count + item.messages.length, 0)
            this.countedThrough = projection.through.seq
        }
        return canonical
    }

    /**
     * The earliest journal position whose conversation holds at least `keep` messages.
     *
     * A chat row records how long the conversation was when it was written, so
     * the position it belongs to is the first one that had grown that long. The
     * search replays history rather than reading the current view: a summary
     * that landed later replaced earlier entries, and cutting the current view
     * would undo that compaction instead of returning to the row's moment.
     * Undefined when the conversation never grew that long.
     */
    async positionKeeping(keep: number): Promise<JournalWatermark | undefined> {
        const tail = this.journal.watermark().seq
        for (let seq = 1; seq <= tail; seq++) {
            const through = { seq }
            const count = (await this.entries(through)).reduce((total, item) => total + item.messages.length, 0)
            if (count >= keep) return through
        }
        return undefined
    }

    /** The provider messages through `through`, in journal order. */
    async messages(through?: JournalWatermark): Promise<ClineStorageMessage[]> {
        return (await this.entries(through)).flatMap((item) => [...item.messages])
    }

    /**
     * Messages ready for a provider request.
     *
     * Legacy JSONL imports can contain a tool_use whose terminal result was never
     * persisted. Keep the canonical journal immutable, but repair that projection
     * before sizing or sending it so both paths see the same valid conversation.
     */
    async providerMessages(through?: JournalWatermark): Promise<ClineStorageMessage[]> {
        return repairProviderPairing(await this.messages(through))
    }

    read(): Promise<ClineStorageMessage[]> {
        return this.messages()
    }

    async count(): Promise<number> {
        if (this.countedThrough !== this.journal.watermark().seq) await this.entries()
        return this.latestSize
    }

    size(): number {
        return this.latestSize
    }

    position(): number {
        return this.journal.watermark().seq
    }

    private render(payloadRef: string): Promise<MaterializedPayload> {
        const cached = this.rendered.get(payloadRef)
        if (cached) return cached
        const pending = this.materializer.materializeEntry(payloadRef)
        this.rendered.set(payloadRef, pending)
        // A failed render is not remembered, so a transient read error does not stick.
        pending.catch(() => {
            if (this.rendered.get(payloadRef) === pending) this.rendered.delete(payloadRef)
        })
        return pending
    }

    private isLatest(through: JournalWatermark): boolean {
        return through.seq >= this.journal.watermark().seq
    }

    private retainOnly(visible: readonly PayloadEntry[]): void {
        const kept = new Set(visible.map((entry) => entry.payloadRef))
        for (const payloadRef of this.rendered.keys()) {
            if (!kept.has(payloadRef)) this.rendered.delete(payloadRef)
        }
    }
}
