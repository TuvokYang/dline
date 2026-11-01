import type { TaskState } from "../../kernel"
import type { TaskRuntime } from "../../runtime"
import type { ConversationJournal, TaskPayloadStore } from "../../stores"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { RoundMaterialComposer } from "./RoundMaterialComposer"

/** Called only inside the task writer's drained restore barrier. */
export async function reconcilePreparedRound(
    runtime: TaskRuntime,
    baseline: Readonly<TaskState>,
    payloads: TaskPayloadStore,
    journal: ConversationJournal,
): Promise<void> {
    const owner = baseline.flow.compose
    if (!owner?.materialPlan || !runtime.isWritable()) return
    const hasProviderResult = (await journal.read()).some(
        (entry) =>
            entry.source === "provider" &&
            entry.causation?.turnId === owner.turnId &&
            (entry.operationId.startsWith("provider.final:") || entry.operationId.startsWith("provider.interrupted:")),
    )
    if (hasProviderResult) {
        const retired = await runtime.submit({
            type: "compose.prepared_retired",
            generation: runtime.getState().generation,
            commandId: owner.commandId,
            originRevision: owner.originRevision,
        })
        if (retired.kind === "rejected") throw new Error(`Prepared round retirement refused: ${retired.diagnostic.code}`)
        await retired.receipt.durable
        return
    }
    const materials = new RoundMaterialComposer(payloads, journal)
    const prepared = await materials.prepared(owner.commandId)
    if (!prepared) {
        await materials.discardAttempt(owner.commandId)
        const retired = await runtime.submit({
            type: "compose.prepared_retired",
            generation: runtime.getState().generation,
            commandId: owner.commandId,
            originRevision: owner.originRevision,
        })
        if (retired.kind === "rejected") throw new Error(`Prepared round retirement refused: ${retired.diagnostic.code}`)
        await retired.receipt.durable
        return
    }
    const draft = decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(prepared.draftRef))
    if (draft.kind !== "provider_draft" || draft.materialPlan?.id !== owner.materialPlan.id || !draft.journalThrough) {
        throw new Error("InvalidRecoveredRoundDraft")
    }
    const accepted = await runtime.submit({
        type: "compose.prepared_restored",
        generation: runtime.getState().generation,
        commandId: owner.commandId,
        originRevision: owner.originRevision,
        draftRef: prepared.draftRef,
        plan: draft.materialPlan,
        journalThrough: draft.journalThrough,
        queueJournalReceipt: prepared.queueJournalReceipt,
    })
    if (accepted.kind === "rejected") throw new Error(`Prepared round recovery refused: ${accepted.diagnostic.code}`)
    await accepted.receipt.durable
}
