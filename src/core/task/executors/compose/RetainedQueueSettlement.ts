import type { QueuePayloadIdentity, TaskState } from "../../kernel"
import type { ConversationJournal, JournalWatermark, TaskPayloadStore } from "../../stores"
import { RetainedInputJournalBatch } from "./RetainedInputJournalBatch"
import { RoundMaterialComposer } from "./RoundMaterialComposer"

export interface RetainedQueueSettlementDecision {
    readonly deliveryId: string
    readonly outcome: "released" | "consumed"
    readonly journalWatermark?: JournalWatermark
}

export interface RetainedQueueSettlementFailure {
    readonly deliveryId: string
    readonly message: string
}

export interface RetainedQueueSettlementResult {
    readonly decisions: readonly RetainedQueueSettlementDecision[]
    readonly failures: readonly RetainedQueueSettlementFailure[]
}

interface PendingDelivery {
    readonly deliveryId: string
    readonly ownerId: string
    readonly entries: readonly QueuePayloadIdentity[]
}

function sameEntries(left: readonly QueuePayloadIdentity[], right: readonly QueuePayloadIdentity[]): boolean {
    return (
        left.length === right.length &&
        left.every((entry, index) => entry.entryId === right[index]?.entryId && entry.payloadRef === right[index]?.payloadRef)
    )
}

function pendingDeliveries(state: Readonly<TaskState>): readonly PendingDelivery[] {
    const grouped = new Map<string, { ownerId: string; entries: Array<QueuePayloadIdentity & { readonly sequence: number }> }>()
    for (const entry of state.intake.queued) {
        const delivery = entry.queue?.delivery
        if (!delivery || delivery.point !== "tool_round" || !["reserved", "included", "uncertain"].includes(entry.state)) continue
        const group = grouped.get(delivery.deliveryId) ?? { ownerId: delivery.ownerId, entries: [] }
        if (group.ownerId !== delivery.ownerId) throw new Error(`RetainedDeliveryOwnerConflict:${delivery.deliveryId}`)
        group.entries.push({ entryId: entry.entryId, payloadRef: entry.payloadRef, sequence: entry.sequence })
        grouped.set(delivery.deliveryId, group)
    }
    return [...grouped.entries()].map(([deliveryId, group]) => ({
        deliveryId,
        ownerId: group.ownerId,
        entries: group.entries
            .sort((left, right) => left.sequence - right.sequence)
            .map(({ entryId, payloadRef }) => ({ entryId, payloadRef })),
    }))
}

/**
 * Resolves journal facts only after the compose/provider writers have drained.
 *
 * A prepared round or a legacy provider terminal proves durable inclusion.
 * Otherwise the staged batch is retracted atomically and may be released.
 * Lookup or retraction failure produces no guessed decision.
 */
export async function settleRetainedQueueDeliveries(
    state: Readonly<TaskState>,
    payloads: TaskPayloadStore,
    journal: ConversationJournal,
): Promise<RetainedQueueSettlementResult> {
    const batches = new RetainedInputJournalBatch(payloads, journal)
    const decisions: RetainedQueueSettlementDecision[] = []
    const failures: RetainedQueueSettlementFailure[] = []
    for (const delivery of pendingDeliveries(state)) {
        try {
            const evidence = await batches.inspect(delivery.deliveryId)
            if (evidence.kind === "absent" || evidence.kind === "retracted") {
                decisions.push({ deliveryId: delivery.deliveryId, outcome: "released" })
                continue
            }
            if (!sameEntries(evidence.receipt.entries, delivery.entries)) throw new Error("RetainedDeliveryIdentityConflict")
            const compose = state.flow.compose?.commandId === delivery.ownerId ? state.flow.compose : undefined
            if (compose?.materialPlan) {
                const checkpoint = await new RoundMaterialComposer(payloads, journal).inspect(compose.commandId)
                if (checkpoint) {
                    const receipt = checkpoint.prepared.queueJournalReceipt
                    if (
                        checkpoint.prepared.draft.materialPlan?.id !== compose.materialPlan.id ||
                        !receipt ||
                        receipt.deliveryId !== delivery.deliveryId ||
                        receipt.journalWatermark.seq !== evidence.receipt.watermark.seq ||
                        !sameEntries(receipt.entries, delivery.entries)
                    )
                        throw new Error("RetainedPreparedCausationUnproven")
                    decisions.push({
                        deliveryId: delivery.deliveryId,
                        outcome: "consumed",
                        journalWatermark: checkpoint.watermark,
                    })
                    continue
                }
            }
            const provider = compose ? state.flow.provider : undefined
            const settled = provider
                ? ((await journal.findByOperation(`provider.final:${provider.commandId}`)) ??
                  (await journal.findByOperation(`provider.interrupted:${provider.commandId}`)))
                : undefined
            if (settled) {
                const receipt = compose?.queueJournalReceipt
                if (
                    !receipt ||
                    receipt.deliveryId !== delivery.deliveryId ||
                    receipt.journalWatermark.seq !== evidence.receipt.watermark.seq ||
                    !sameEntries(receipt.entries, delivery.entries)
                )
                    throw new Error("RetainedProviderCausationUnproven")
                decisions.push({ deliveryId: delivery.deliveryId, outcome: "consumed", journalWatermark: settled.watermark })
                continue
            }
            await batches.retract({ deliveryId: delivery.deliveryId, entries: delivery.entries })
            decisions.push({ deliveryId: delivery.deliveryId, outcome: "released" })
        } catch (error) {
            failures.push({ deliveryId: delivery.deliveryId, message: error instanceof Error ? error.message : String(error) })
        }
    }
    return { decisions, failures }
}
