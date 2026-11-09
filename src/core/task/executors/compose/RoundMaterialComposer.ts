import { formatResponse } from "@core/prompts/responses"
import { type QueueJournalReceipt, type RoundMaterialPlan, roundInputId, roundMaterialReceipt } from "../../kernel"
import type { ConversationJournal, TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    ProviderDraftEnvelope,
    RoundMaterialInputEnvelope,
    RoundNoticeEnvelope,
    RoundPreparedEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import type { ComposeRoundResult } from "./ComposeCommandExecutor"

/** One journal adapter owns the plan's ordered bodies, notices, tail and prepared-draft receipt. */
export class RoundMaterialComposer {
    constructor(
        private readonly payloads: TaskPayloadStore,
        private readonly journal: ConversationJournal,
    ) {}

    async appendBody(plan: RoundMaterialPlan, signal: AbortSignal): Promise<void> {
        const materials = [
            ...plan.notices.map((notice) => ({
                revision: notice.revision,
                priority: 0,
                id: notice.id,
                payload: (): RoundNoticeEnvelope => ({
                    kind: "round_notice",
                    planId: plan.id,
                    text: formatResponse.awayExited(),
                }),
            })),
            ...plan.inputs.map((input) => ({
                revision: input.revision,
                priority: 1,
                id: roundInputId(input),
                payload: (): RoundMaterialInputEnvelope => ({
                    kind: "round_material_input",
                    planId: plan.id,
                    materialId: roundInputId(input),
                    inputRef: input.payloadRef,
                }),
            })),
        ].sort((left, right) => left.revision - right.revision || left.priority - right.priority)
        for (const material of materials) {
            signal.throwIfAborted()
            await this.appendOnce(`material:${plan.id}:${material.id}`, material.payload)
        }
    }

    async appendTail(
        plan: RoundMaterialPlan,
        environment: string | undefined,
        subagentsAvailable: boolean,
        signal: AbortSignal,
    ): Promise<void> {
        signal.throwIfAborted()
        if (environment)
            await this.appendOnce(`material:${plan.id}:environment`, () => ({ kind: "environment_details", text: environment }))
        if (plan.activeAway)
            await this.appendOnce(
                `material:${plan.id}:active`,
                (): RoundNoticeEnvelope => ({
                    kind: "round_active_away",
                    planId: plan.id,
                    text: formatResponse.awayActive(subagentsAvailable),
                }),
            )
    }

    /** Reuses the frozen text rather than rendering a different body under an existing operation id. */
    private async appendOnce(operationId: string, payload: () => unknown): Promise<void> {
        if (await this.journal.findByOperation(operationId)) return
        await this.journal.append({
            operationId,
            source: "system",
            payloadRef: await this.payloads.put(encodeTaskPayload(payload())),
        })
    }

    async prepare(
        commandId: string,
        draft: Omit<ProviderDraftEnvelope, "journalThrough">,
        queueJournalReceipt?: QueueJournalReceipt,
    ): Promise<Extract<ComposeRoundResult, { draftRef: string }>> {
        const envelope: RoundPreparedEnvelope = {
            kind: "round_prepared",
            composeCommandId: commandId,
            draft,
            ...(queueJournalReceipt ? { queueJournalReceipt } : {}),
        }
        const operationId = `compose.prepared:${commandId}`
        let checkpoint = await this.journal.findByOperation(operationId)
        if (!checkpoint) {
            await this.journal.append({
                operationId,
                source: "system",
                payloadRef: await this.payloads.put(encodeTaskPayload(envelope)),
            })
            checkpoint = await this.journal.findByOperation(operationId)
        }
        return this.readPrepared(checkpoint!)
    }

    async prepared(commandId: string): Promise<Extract<ComposeRoundResult, { draftRef: string }> | undefined> {
        const checkpoint = await this.inspect(commandId)
        return checkpoint ? this.restoreDraft(checkpoint.prepared, checkpoint.watermark) : undefined
    }

    /** Reads durable evidence without creating a draft, including during pre-hydrate settlement. */
    async inspect(commandId: string) {
        if (await this.journal.findByOperation(`compose.prepared.discard:${commandId}`)) return undefined
        const checkpoint = await this.journal.findByOperation(`compose.prepared:${commandId}`)
        if (!checkpoint) return undefined
        return { prepared: await this.decodePrepared(checkpoint), watermark: checkpoint.watermark }
    }

    private async decodePrepared(checkpoint: { readonly payloadRef?: string }): Promise<RoundPreparedEnvelope> {
        const prepared = decodeTaskPayload<RoundPreparedEnvelope>(await this.payloads.read(checkpoint.payloadRef!))
        if (prepared.kind !== "round_prepared" || !prepared.draft?.materialPlan) throw new Error("InvalidPreparedRound")
        return prepared
    }

    private async readPrepared(checkpoint: {
        readonly payloadRef?: string
        readonly watermark: { readonly seq: number }
    }): Promise<Extract<ComposeRoundResult, { draftRef: string }>> {
        return this.restoreDraft(await this.decodePrepared(checkpoint), checkpoint.watermark)
    }

    private async restoreDraft(
        prepared: RoundPreparedEnvelope,
        watermark: { readonly seq: number },
    ): Promise<Extract<ComposeRoundResult, { draftRef: string }>> {
        const draft: ProviderDraftEnvelope = { ...prepared.draft, journalThrough: watermark }
        return {
            draftRef: await this.payloads.put(encodeTaskPayload(draft)),
            materialReceipt: roundMaterialReceipt(prepared.draft.materialPlan!),
            ...(prepared.queueJournalReceipt ? { queueJournalReceipt: prepared.queueJournalReceipt } : {}),
        }
    }

    async discard(plan: RoundMaterialPlan): Promise<void> {
        await this.discardMaterial(plan.id)
    }

    /** A refused completion cannot retain a draft whose queue membership changed. */
    async discardAttempt(commandId: string): Promise<void> {
        await this.discardMaterial(`round-material:${commandId}`)
        const prepared = await this.journal.findByOperation(`compose.prepared:${commandId}`)
        if (prepared)
            await this.journal.tombstone({ operationId: `compose.prepared.discard:${commandId}`, target: prepared.watermark })
    }

    private async discardMaterial(planId: string): Promise<void> {
        for (const entry of await this.journal.read()) {
            if (!entry.operationId.startsWith(`material:${planId}:`) || entry.kind !== "message") continue
            await this.journal.tombstone({ operationId: `material.discard:${entry.operationId}`, target: entry.watermark })
        }
    }
}
