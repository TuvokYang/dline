import type { JournalWatermark } from "../stores"
import type { CompactionContinuation } from "../stores/payload/TaskPayloadEnvelopes"

/**
 * The part of the conversation one summary stands for.
 *
 * Fixed when the request is built and carried to landing, because the journal
 * can grow while the summary is produced and the summary only describes what
 * its request contained.
 */
export interface CompactionSpan {
    readonly from: JournalWatermark
    readonly to: JournalWatermark
}

/** The summary a completed compaction produced, and the prose that carried it. */
export interface CompactionSummary {
    readonly summary: string
    readonly assistantText?: string
    /** Span the request summarized; a journal landing without one is refused, never re-derived. */
    readonly span?: CompactionSpan
    /**
     * Journal seq of the last message the summary stands for, when it covers
     * only the oldest part of the span; absent means the whole span.
     */
    readonly coveredThrough?: number
}

/**
 * Lands a finished summary so the conversation actually shrinks.
 *
 * The kernel only records that a compaction completed; it holds a payload ref
 * and nothing more. Without a landing the summary is produced, paid for, and
 * then discarded: the context stays full, so the next settled request reports
 * the same pressure and schedules the same compaction again.
 *
 * Declaring the landing as a port keeps the compaction domain independent of
 * where a conversation lives and how a chat row is drawn, so a headless task
 * can compact with no presentation at all.
 */
export interface CompactionLandingPort {
    land(input: CompactionLandingInput): Promise<void>
}

export type CompactionLandingInput = {
    readonly compactionId: string
    readonly attempt: string
    /**
     * The run's signal. The canonical landing checks it at its commit point, so
     * a run stopped while the landing was preparing never condenses anything.
     */
    readonly signal?: AbortSignal
    /** The user's reply the span ends on; the summary carries it so it is not condensed away. */
    readonly continuation?: CompactionContinuation
} & CompactionSummary

/**
 * Applies one summary to every place that has to shrink.
 *
 * A summary has two distinct consequences - the conversation the provider
 * sends, and the card the user restores from - owned by different stores. They
 * are sequenced rather than raced so the conversation is condensed before the
 * chat claims it was.
 */
export class CompositeCompactionLanding implements CompactionLandingPort {
    constructor(private readonly landings: readonly CompactionLandingPort[]) {}

    async land(input: CompactionLandingInput): Promise<void> {
        for (const landing of this.landings) await landing.land(input)
    }
}

/** Refreshes prompt-derived state only after a usable summary has landed. */
export class PromptStateCompactionLanding implements CompactionLandingPort {
    constructor(
        private readonly prompt: { requestRefresh(reason: "post_compaction"): void },
        private readonly promptCache: { recordCompactionResult(success: boolean): void },
    ) {}

    async land(_input: CompactionLandingInput): Promise<void> {
        this.prompt.requestRefresh("post_compaction")
        this.promptCache.recordCompactionResult(true)
    }
}

function readText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/**
 * Read the summary out of whatever the host compaction service returned.
 *
 * The result crosses the port as `unknown` because the compaction service is
 * host-supplied, so the shape is validated here rather than trusted. Anything
 * without a usable summary lands nothing: a compaction that produced no text
 * must not replace the conversation with an empty one.
 */
export function readCompactionSummary(result: unknown): CompactionSummary | undefined {
    if (!result || typeof result !== "object") return undefined
    const summary = readText((result as { summary?: unknown }).summary)
    if (!summary) return undefined
    const assistantText = readText((result as { assistantText?: unknown }).assistantText)
    const coveredThrough = (result as { coveredThrough?: unknown }).coveredThrough
    return {
        summary,
        ...(assistantText === undefined ? {} : { assistantText }),
        ...(typeof coveredThrough === "number" && Number.isSafeInteger(coveredThrough) ? { coveredThrough } : {}),
    }
}
