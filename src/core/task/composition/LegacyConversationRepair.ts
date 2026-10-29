import {
    type CompletedCompactionCardProjection,
    normalizeCanonicalMessageRanges,
    normalizeCompletedCompactionCards,
    readCompletedCompactionCards,
} from "@core/context/context-management/compaction-context-projection"
import { formatPreviousCompactionSummary } from "@core/context/context-management/compaction-summary-message"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ConversationJournal, JournalEntry, TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { CompactionSummaryEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

const LEGACY_COMPACTION_MIGRATION_OPERATION = "legacy.compaction.migration:v1"
const LEGACY_COMPACTION_MIGRATION_REF = "legacy-compaction-migration:v1"

export interface LegacyConversationRepairInput {
    readonly journal: ConversationJournal
    readonly payloads: TaskPayloadStore
    readonly canonicalLength: number
    /** Durable chat rows are a legacy source for completed compaction summaries and ranges. */
    readonly uiMessages?: readonly UiMessage[]
    /** ContextManager's legacy hidden range in API-history index space. */
    readonly deletedRange?: readonly [number, number]
}

const LEGACY_REPAIR_OPERATION_PREFIXES = ["api-history:", "legacy.compaction.supersede:", "legacy.truncation.supersede:"]

interface LegacyRepairGeneration {
    readonly operationSuffix: string
    readonly markerOperationId: string
    readonly markerRef: string
}

interface LegacyRepairPlan extends LegacyRepairGeneration {
    readonly cards: readonly CompletedCompactionCardProjection[]
    readonly deletedRanges: readonly (readonly [number, number])[]
}

function canRepairInitialImport(recorded: readonly JournalEntry[]): boolean {
    return (
        recorded.length > 0 &&
        recorded.every((entry) => LEGACY_REPAIR_OPERATION_PREFIXES.some((prefix) => entry.operationId.startsWith(prefix)))
    )
}

function isRepairMarker(entry: JournalEntry): boolean {
    return (
        entry.operationId === LEGACY_COMPACTION_MIGRATION_OPERATION ||
        entry.operationId.startsWith(`${LEGACY_COMPACTION_MIGRATION_OPERATION}@rewind:`)
    )
}

function lastMatching(entries: readonly JournalEntry[], predicate: (entry: JournalEntry) => boolean): JournalEntry | undefined {
    for (let index = entries.length - 1; index >= 0; index--) {
        if (predicate(entries[index])) return entries[index]
    }
    return undefined
}

function importedLengthAt(entries: readonly JournalEntry[], targetSeq: number, canonicalLength: number): number {
    let length = 0
    for (const entry of entries) {
        if (entry.watermark.seq > targetSeq) continue
        const match = /^api-history:(\d+)$/.exec(entry.operationId)
        if (match) length = Math.max(length, Number(match[1]) + 1)
    }
    return Math.min(length, canonicalLength)
}

function factsAt(input: LegacyConversationRepairInput, canonicalLength: number) {
    return {
        cards: normalizeCompletedCompactionCards(readCompletedCompactionCards(input.uiMessages ?? []), canonicalLength),
        deletedRanges: normalizeCanonicalMessageRanges(input.deletedRange ? [input.deletedRange] : [], canonicalLength),
    }
}

async function pendingRepairPlan(input: LegacyConversationRepairInput): Promise<LegacyRepairPlan | undefined> {
    if (!(await input.journal.findByOperation("api-history:0"))) return undefined
    const recorded = await input.journal.read()
    const repairMarkers = recorded.filter(isRepairMarker)
    if (repairMarkers.length === 0) {
        // A task already advanced by an intermediate runtime cannot be repaired
        // automatically: its later requests and compactions were based on the
        // un-repaired view. Keep that journal usable and leave the general repair
        // decision to WS-099 instead of guessing an ordering here.
        if (!canRepairInitialImport(recorded)) return undefined
        return {
            operationSuffix: "",
            markerOperationId: LEGACY_COMPACTION_MIGRATION_OPERATION,
            markerRef: LEGACY_COMPACTION_MIGRATION_REF,
            ...factsAt(input, input.canonicalLength),
        }
    }

    const latestMarker = repairMarkers[repairMarkers.length - 1]
    const latestRewind = lastMatching(
        recorded,
        (entry) => entry.kind === "rewind" && entry.watermark.seq > latestMarker.watermark.seq,
    )
    if (!latestRewind?.target) return undefined
    // A rewind whose target includes any completed repair generation retains
    // that generation in the projected prefix. Replaying it would hide later
    // runtime summaries that already supersede the legacy span.
    if (repairMarkers.some((marker) => marker.watermark.seq <= latestRewind.target!.seq)) return undefined

    const operationSuffix = `@rewind:${latestRewind.watermark.seq}`
    const markerOperationId = `${LEGACY_COMPACTION_MIGRATION_OPERATION}${operationSuffix}`
    if (await input.journal.findByOperation(markerOperationId)) return undefined
    const facts = factsAt(input, importedLengthAt(recorded, latestRewind.target.seq, input.canonicalLength))
    // Restoring before every surviving legacy fact needs no durable generation.
    if (facts.cards.length === 0 && facts.deletedRanges.length === 0) return undefined
    return {
        operationSuffix,
        markerOperationId,
        markerRef: `${LEGACY_COMPACTION_MIGRATION_REF}${operationSuffix}`,
        ...facts,
    }
}

/** Whether the imported conversation still needs its legacy range facts repaired. */
export async function legacyConversationRepairPending(input: LegacyConversationRepairInput): Promise<boolean> {
    return (await pendingRepairPlan(input)) !== undefined
}

/**
 * Read legacy range facts and apply them to the canonical journal projection.
 *
 * The source adapters stay outside the runtime repository: this repair reads
 * old UI/History shapes once, normalizes them with the same rules as the legacy
 * provider projection, and writes only canonical journal records. Missing
 * imported endpoints still fail closed. Operation identities make a partially completed
 * repair safe to resume after a crash without maintaining a second runtime
 * authority.
 */
export async function repairLegacyConversation(input: LegacyConversationRepairInput): Promise<void> {
    const plan = await pendingRepairPlan(input)
    if (!plan) return

    for (const card of plan.cards) await applyCompactionCard(input, card, plan)

    const cardRanges = plan.cards.map((card) => card.range.apiConversationRange)
    for (const deletedRange of plan.deletedRanges) {
        for (const [start, end] of subtractRanges(deletedRange, cardRanges)) {
            const from = await input.journal.findByOperation(`api-history:${start}`)
            const to = await input.journal.findByOperation(`api-history:${end}`)
            if (!from || !to) throw new Error(`LegacyTruncationRangeMissing:${start}:${end}`)
            await input.journal.supersedeRange({
                operationId: `legacy.truncation.supersede:${start}:${end}${plan.operationSuffix}`,
                from: from.watermark,
                to: to.watermark,
            })
        }
    }

    await input.journal.checkpointMarker({
        operationId: plan.markerOperationId,
        checkpointRef: plan.markerRef,
    })
}

async function applyCompactionCard(
    input: LegacyConversationRepairInput,
    card: CompletedCompactionCardProjection,
    generation: LegacyRepairGeneration,
): Promise<void> {
    const [start, end] = card.range.apiConversationRange
    const from = await input.journal.findByOperation(`api-history:${start}`)
    const to = await input.journal.findByOperation(`api-history:${end}`)
    if (!from || !to) throw new Error(`LegacyCompactionRangeMissing:${start}:${end}`)
    const operationId = `legacy.compaction.supersede:${start}:${end}${generation.operationSuffix}`
    if (await input.journal.findByOperation(operationId)) return
    const replacementRef = await input.payloads.put(
        encodeTaskPayload<CompactionSummaryEnvelope>({
            kind: "compaction_summary",
            compactionId: operationId,
            text: formatPreviousCompactionSummary(card.summary),
        }),
    )
    await input.journal.supersedeRange({ operationId, from: from.watermark, to: to.watermark, replacementRef })
}

function subtractRanges(
    range: readonly [number, number],
    covered: readonly (readonly [number, number])[],
): Array<readonly [number, number]> {
    let remaining: Array<readonly [number, number]> = [range]
    for (const [coveredStart, coveredEnd] of covered) {
        remaining = remaining.flatMap(([start, end]) => {
            if (coveredEnd < start || coveredStart > end) return [[start, end] as const]
            const pieces: Array<readonly [number, number]> = []
            if (coveredStart > start) pieces.push([start, coveredStart - 1])
            if (coveredEnd < end) pieces.push([coveredEnd + 1, end])
            return pieces
        })
    }
    return remaining
}
