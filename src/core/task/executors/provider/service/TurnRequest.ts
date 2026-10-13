import type { JournalWatermark } from "../../../stores"
import type { ProviderDraftEnvelope } from "../../../stores/payload/TaskPayloadEnvelopes"
import type { PreparedProviderRequest } from "./ProviderRequest"

/**
 * The request one turn sends, kept frozen across its retries.
 *
 * It is replaced only when the task replaced the handler it was prepared for:
 * the frozen prompt and tools are one provider's projection, so replaying them
 * through another provider's handler loses every tool that provider cannot
 * read. The replacement is prepared from the same draft and turn, so the
 * conversation it carries is unchanged.
 *
 * The one exception is a conversation truncated to fit the context window:
 * the turn is then projected through the truncation record, and stays so.
 *
 * Preparing it again is the provider service's, so a failed preparation is
 * retried like a failed send.
 */
export class TurnRequest {
    private through: JournalWatermark | undefined
    /** Trace id of each deferred hosted call this turn resumes, by provider call id. */
    carriedServerToolTraceIds: ReadonlyMap<string, string> = new Map()

    constructor(
        private current: PreparedProviderRequest,
        private readonly draft: ProviderDraftEnvelope,
    ) {}

    get request(): PreparedProviderRequest {
        return this.current
    }

    /** Whether the task replaced the handler this request was prepared for. */
    get stale(): boolean {
        return this.current.isCurrent?.() === false
    }

    /** Whether resending through `through` removes more than the turn's last truncation did. */
    advancesTo(through: JournalWatermark): boolean {
        return this.through === undefined || JSON.stringify(through) !== JSON.stringify(this.through)
    }

    /** The draft that prepares this same turn again, through `through` or else its last truncation. */
    draftThrough(through: JournalWatermark | undefined = this.through): ProviderDraftEnvelope {
        return through ? { ...this.draft, journalThrough: through } : this.draft
    }

    /** Send the turn as prepared again, projected through `through` when a truncation moved it. */
    adopt(prepared: PreparedProviderRequest, through?: JournalWatermark): void {
        this.current = prepared
        if (through) this.through = through
    }

    /** Abandoning the stream also withdraws the turn's one-shot authority. */
    abandon(): void {
        this.current.api.abort?.()
        this.current.authority?.cancel()
    }
}
