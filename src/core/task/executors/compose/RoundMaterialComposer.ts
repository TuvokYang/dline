import { formatResponse } from "@core/prompts/responses"
import {
    type IntakeEntry,
    type QueueJournalReceipt,
    type RoundMaterialPlan,
    roundInputId,
    roundMaterialReceipt,
} from "../../kernel"
import type { ConversationJournal, TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    ProviderDraftEnvelope,
    RoundMaterialInputEnvelope,
    RoundNoticeEnvelope,
    RoundPreparedEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import type { ComposeRoundResult } from "./ComposeCommandExecutor"
import { projectRetainedMaterialInput, type RetainedBatchReceipt } from "./RetainedInputJournalBatch"

/** One journal adapter owns the plan's ordered bodies, notices, tail and prepared-draft receipt. */
export class RoundMaterialComposer {
    constructor(
        private readonly payloads: TaskPayloadStore,
        private readonly journal: ConversationJournal,
    ) {}

    async appendBody(
        plan: RoundMaterialPlan,
        signal: AbortSignal,
        retainedBatches: readonly RetainedBatchReceipt[] = [],
        ordinaryEntries: readonly Pick<IntakeEntry, "entryId" | "source">[] = [],
    ): Promise<void> {
        const intakeSources = new Map(ordinaryEntries.map((entry) => [entry.entryId, entry.source]))
        const materials = [
            ...plan.notices.map((notice) => ({
                revision: notice.revision,
                priority: 0,
                id: notice.id,
                operationId: `material:${plan.id}:${notice.id}`,
                payload: (): RoundNoticeEnvelope => ({
                    kind: "round_notice",
                    planId: plan.id,
                    text: formatResponse.awayExited(),
                }),
            })),
            ...plan.inputs.map((input) => {
                const source = input.source === "intake" && input.entryId ? intakeSources.get(input.entryId) : undefined
                return {
                    revision: input.revision,
                    priority: 1,
                    id: roundInputId(input),
                    // Direct input is already accepted and will not be selected again
                    // after this attempt fails. Its journal lifetime belongs to intake.
                    operationId: source ? `intake:${source}:${input.entryId}` : `material:${plan.id}:${roundInputId(input)}`,
                    payload: (): RoundMaterialInputEnvelope => ({
                        kind: "round_material_input",
                        planId: plan.id,
                        materialId: roundInputId(input),
                        inputRef: input.payloadRef,
                    }),
                }
            }),
        ].sort((left, right) => left.revision - right.revision || left.priority - right.priority)
        const replacements = new Map<string, () => RoundMaterialInputEnvelope | Promise<RoundMaterialInputEnvelope>>()
        const batched = new Set<string>()
        const claimed = new Set<string>()
        for (const batch of retainedBatches) {
            if (!batch.roundMaterialRef) throw new Error("RetainedMaterialProjectionMissing")
            if (batch.entries.length === 0) throw new Error("RetainedMaterialIdentityConflict")
            const members = batch.entries.map((entry) => {
                const matches = plan.inputs.filter((input) => input.source === "intake" && input.entryId === entry.entryId)
                if (matches.length !== 1 || matches[0].payloadRef !== entry.payloadRef)
                    throw new Error("RetainedMaterialIdentityConflict")
                const id = roundInputId(matches[0])
                if (claimed.has(id)) throw new Error("RetainedMaterialIdentityConflict")
                claimed.add(id)
                return { id, inputRef: entry.payloadRef }
            })
            const envelope = (materialId: string, inputRef: string): RoundMaterialInputEnvelope => ({
                kind: "round_material_input",
                planId: plan.id,
                materialId,
                inputRef,
            })
            const start = materials.findIndex((material) => material.id === members[0].id)
            if (members.every((member, index) => materials[start + index]?.id === member.id)) {
                for (const member of members) batched.add(member.id)
                replacements.set(members[0].id, () => envelope(members[0].id, batch.roundMaterialRef!))
            } else {
                // Released entries keep their earlier acceptance revision. Do not
                // pull a later body across a notice or another accepted input.
                const ordered = [...members].sort(
                    (left, right) =>
                        materials.findIndex((material) => material.id === left.id) -
                        materials.findIndex((material) => material.id === right.id),
                )
                ordered.forEach((member, index) =>
                    replacements.set(member.id, async () =>
                        envelope(member.id, await projectRetainedMaterialInput(this.payloads, member.inputRef, index === 0)),
                    ),
                )
            }
        }
        for (const material of materials) {
            signal.throwIfAborted()
            const replacement = replacements.get(material.id)
            if (batched.has(material.id) && !replacement) continue
            await this.appendOnce(material.operationId, replacement ?? material.payload, signal)
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
            await this.appendOnce(
                `material:${plan.id}:environment`,
                () => ({ kind: "environment_details", text: environment }),
                signal,
            )
        if (plan.activeAway)
            await this.appendOnce(
                `material:${plan.id}:active`,
                (): RoundNoticeEnvelope => ({
                    kind: "round_active_away",
                    planId: plan.id,
                    text: formatResponse.awayActive(subagentsAvailable),
                }),
                signal,
            )
    }

    /** Reuses the frozen text rather than rendering a different body under an existing operation id. */
    private async appendOnce(operationId: string, payload: () => unknown | Promise<unknown>, signal: AbortSignal): Promise<void> {
        if (await this.journal.findByOperation(operationId)) return
        signal.throwIfAborted()
        const envelope = await payload()
        signal.throwIfAborted()
        const payloadRef = await this.payloads.put(encodeTaskPayload(envelope))
        signal.throwIfAborted()
        await this.journal.append({ operationId, source: "system", payloadRef })
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
