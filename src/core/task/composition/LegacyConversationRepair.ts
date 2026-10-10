import {
    type CompletedCompactionCardProjection,
    readCompletedCompactionCards,
} from "@core/context/context-management/compaction-context-projection"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ConversationJournal, TaskPayloadStore } from "../stores"
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

/** Whether the imported conversation still needs its legacy range facts repaired. */
export async function legacyConversationRepairPending(journal: ConversationJournal): Promise<boolean> {
    if (!(await journal.findByOperation("api-history:0"))) return false
    return !(await journal.findByOperation(LEGACY_COMPACTION_MIGRATION_OPERATION))
}

/**
 * Read legacy range facts and apply them to the canonical journal projection.
 *
 * The source adapters stay outside the runtime repository: this repair reads
 * old UI/History shapes once, validates them fail-closed, and writes only
 * canonical journal records. Operation identities make a partially completed
 * repair safe to resume after a crash without maintaining a second runtime
 * authority.
 */
export async function repairLegacyConversation(input: LegacyConversationRepairInput): Promise<void> {
    if (!(await input.journal.findByOperation("api-history:0"))) return
    if (await input.journal.findByOperation(LEGACY_COMPACTION_MIGRATION_OPERATION)) return

    const cards = normalizeLegacyCards(input.uiMessages ?? [], input.canonicalLength)
    for (const card of cards) await applyCompactionCard(input, card)

    if (input.deletedRange) {
        validateLegacyRange(input.deletedRange, input.canonicalLength, "LegacyTruncationRangeInvalid")
        const cardRanges = cards.map((card) => card.range.apiConversationRange)
        for (const [start, end] of subtractRanges(input.deletedRange, cardRanges)) {
            const from = await input.journal.findByOperation(`api-history:${start}`)
            const to = await input.journal.findByOperation(`api-history:${end}`)
            if (!from || !to) throw new Error(`LegacyTruncationRangeMissing:${start}:${end}`)
            await input.journal.supersedeRange({
                operationId: `legacy.truncation.supersede:${start}:${end}`,
                from: from.watermark,
                to: to.watermark,
            })
        }
    }

    await input.journal.checkpointMarker({
        operationId: LEGACY_COMPACTION_MIGRATION_OPERATION,
        checkpointRef: LEGACY_COMPACTION_MIGRATION_REF,
    })
}

async function applyCompactionCard(input: LegacyConversationRepairInput, card: CompletedCompactionCardProjection): Promise<void> {
    const [start, end] = card.range.apiConversationRange
    const from = await input.journal.findByOperation(`api-history:${start}`)
    const to = await input.journal.findByOperation(`api-history:${end}`)
    if (!from || !to) throw new Error(`LegacyCompactionRangeMissing:${start}:${end}`)
    const operationId = `legacy.compaction.supersede:${start}:${end}`
    if (await input.journal.findByOperation(operationId)) return
    const replacementRef = await input.payloads.put(
        encodeTaskPayload<CompactionSummaryEnvelope>({
            kind: "compaction_summary",
            compactionId: operationId,
            text: card.summary,
        }),
    )
    await input.journal.supersedeRange({ operationId, from: from.watermark, to: to.watermark, replacementRef })
}

function normalizeLegacyCards(messages: readonly UiMessage[], canonicalLength: number): CompletedCompactionCardProjection[] {
    const surviving: CompletedCompactionCardProjection[] = []
    for (const card of readCompletedCompactionCards(messages)) {
        validateLegacyRange(card.range.apiConversationRange, canonicalLength, "LegacyCompactionRangeInvalid")
        for (let index = surviving.length - 1; index >= 0; index--) {
            if (rangesOverlap(surviving[index].range.apiConversationRange, card.range.apiConversationRange)) {
                surviving.splice(index, 1)
            }
        }
        surviving.push(card)
    }
    return surviving.sort((left, right) => left.range.apiConversationRange[0] - right.range.apiConversationRange[0])
}

function validateLegacyRange(
    range: readonly [number, number],
    canonicalLength: number,
    errorPrefix: "LegacyCompactionRangeInvalid" | "LegacyTruncationRangeInvalid",
): void {
    const [start, end] = range
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= canonicalLength) {
        throw new Error(`${errorPrefix}:${start}:${end}`)
    }
}

function rangesOverlap(left: readonly [number, number], right: readonly [number, number]): boolean {
    return left[0] <= right[1] && right[0] <= left[1]
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
