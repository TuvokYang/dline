import { randomUUID } from "node:crypto"
import { submittedInputRow } from "@shared/input-semantics/submitted-input"
import { Logger } from "@shared/services/Logger"
import { hasTransitionDraftContent } from "@shared/TransitionDraft"
import { renderRetainedInputs } from "../continuation/RetainedInputContent"
import { retainedInputPartsOf } from "../continuation/RetainedInputParts"
import { retainedQueueDeliveryEntries } from "../kernel/machines/intake"
import type { RejectReason } from "../kernel/types"
import type { RuntimeFacade, RuntimeRejection } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { materializeCanonicalInputQueue } from "../view/materializeCanonicalInputQueue"
import type { ConsumedInputRowPort } from "./ConsumedInputRow"
import type {
    CanonicalInputQueueDraft,
    CanonicalInputQueueMutation,
    CanonicalInputQueueMutationResult,
    CanonicalQueueAwaitingInteraction,
    CanonicalQueueTurnEndDelivery,
    CanonicalQueueTurnEndPort,
    InputQueueApplicationPort,
} from "./InputQueueApplicationPort"
import type { TaskInputMaterializer } from "./TaskInputMaterializer"

/**
 * Why the kernel refused a queue change, as the diagnostic the Webview logs.
 *
 * Only a new entry can be held back by the task's phase: a compaction in
 * progress keeps the send with the user until its summary has landed.
 */
/** Result of an enqueue that carried out a bare lifecycle command instead of queueing it. */
export const QUEUE_COMMAND_PERFORMED = "command_performed"

/**
 * Whether a draft could be nothing but a lifecycle command and its premessage.
 *
 * Text before a command is kept as a message, so a bare command always starts
 * the draft; this keeps every ordinary message off the admission it would
 * otherwise run twice.
 */
function mayBeBareCommand(draft: CanonicalInputQueueDraft): boolean {
    return (draft.text ?? "").trimStart().startsWith("/")
}

function refusalOf(mutation: CanonicalInputQueueMutation, reason: RejectReason | RuntimeRejection["reason"]): string {
    if (reason === "read_only") return "task_read_only"
    if (reason === "capacity_exceeded") return "queue_full"
    if (mutation.kind === "enqueue" && reason === "phase_invalid") return "input_held"
    return "missing_entry"
}

export class CanonicalInputQueueApplication implements InputQueueApplicationPort {
    private readonly payloadCache = new Map<string, UserInputEnvelope>()
    private awaitingTurnEnd: CanonicalQueueAwaitingInteraction | undefined
    private drainPromise: Promise<void> | undefined
    private drainRequested = false

    constructor(
        private readonly runtime: RuntimeFacade,
        private readonly inputs: TaskInputMaterializer,
        private readonly payloads: TaskPayloadStore,
        private readonly turnEnd: CanonicalQueueTurnEndPort,
        /** Shows a command carried out instead of queued; absent means the command acts unseen. */
        private readonly consumedRows?: ConsumedInputRowPort,
    ) {}

    async mutate(mutation: CanonicalInputQueueMutation): Promise<CanonicalInputQueueMutationResult> {
        let event
        let success = "ok"

        switch (mutation.kind) {
            case "enqueue": {
                if (!hasTransitionDraftContent(mutation.draft)) return { accepted: false, result: "empty_input" }
                const performed = await this.performBareCommand(mutation.draft)
                if (performed !== undefined) {
                    return performed
                        ? { accepted: true, result: QUEUE_COMMAND_PERFORMED }
                        : { accepted: false, result: "command_refused" }
                }
                const mode = mutation.mode ?? "queued"
                const input = await this.inputs.materialize(mutation.draft, mode)
                event = {
                    type: "input_queue.enqueued" as const,
                    generation: this.runtime.getState().generation,
                    entryId: input.entryId,
                    payloadRef: input.payloadRef,
                    mode,
                }
                success = input.entryId
                break
            }
            case "toggle_mode":
                event = {
                    type: "input_queue.mode_toggled" as const,
                    generation: this.runtime.getState().generation,
                    entryId: mutation.entryId,
                }
                break
            case "reorder":
                event = {
                    type: "input_queue.reordered" as const,
                    generation: this.runtime.getState().generation,
                    entryId: mutation.entryId,
                    targetIndex: mutation.targetIndex,
                }
                break
            case "begin_edit":
                event = {
                    type: "input_queue.edit_started" as const,
                    generation: this.runtime.getState().generation,
                    entryId: mutation.entryId,
                }
                break
            case "commit_edit": {
                if (!hasTransitionDraftContent(mutation.draft)) return { accepted: false, result: "empty_input" }
                const payloadRef = await this.inputs.materializePayload(mutation.draft)
                event = {
                    type: "input_queue.edit_committed" as const,
                    generation: this.runtime.getState().generation,
                    entryId: mutation.entryId,
                    payloadRef,
                }
                break
            }
            case "cancel_edit":
                event = {
                    type: "input_queue.edit_cancelled" as const,
                    generation: this.runtime.getState().generation,
                    entryId: mutation.entryId,
                }
                break
            case "remove":
                event = {
                    type: "input_queue.removed" as const,
                    generation: this.runtime.getState().generation,
                    entryId: mutation.entryId,
                }
                break
        }

        const submitted = await this.runtime.submit(event)
        if (submitted.kind === "rejected") {
            return { accepted: false, result: refusalOf(mutation, submitted.reason) }
        }
        try {
            await submitted.receipt.durable
        } catch {
            return { accepted: false, result: "persist_failed" }
        }
        if (mutation.kind === "toggle_mode") {
            const entry = submitted.state.intake.queued.find((candidate) => candidate.entryId === mutation.entryId)
            success = entry?.mode ?? "missing_entry"
        }
        this.requestTurnEndDrain()
        return { accepted: true, result: success }
    }

    project() {
        return materializeCanonicalInputQueue(this.runtime.getState(), this.payloads, this.payloadCache)
    }

    /**
     * Carry out a draft that holds only a lifecycle command, such as a bare `/compact`.
     *
     * Queued, such a draft would later answer whatever dialog the turn ends on,
     * or reach the model as an empty message at a tool round. It is an action,
     * so it runs now, beside the work in progress, and the next round waits for
     * it. Returns undefined for any draft that is a message and must be queued.
     *
     * Never an intake entry, the command's draft is shown here as the user's own
     * row, just as a reply a command consumed is.
     */
    private async performBareCommand(draft: CanonicalInputQueueDraft): Promise<boolean | undefined> {
        if (!mayBeBareCommand(draft)) return undefined
        let reviewed: Awaited<ReturnType<TaskInputMaterializer["reviewReply"]>>
        try {
            reviewed = await this.inputs.reviewReply(draft)
        } catch {
            // Materializing the entry reports the same refusal with its own diagnostics.
            return undefined
        }
        if (!reviewed?.performAlone) return undefined
        if (!(await reviewed.performAlone())) return false
        const shown = submittedInputRow(
            [{ text: draft.text, ...(draft.semanticInput === undefined ? {} : { semanticInput: draft.semanticInput }) }],
            {
                admitted: false,
                ...(reviewed.claimedBarrier === undefined ? {} : { claimedBarrier: reviewed.claimedBarrier }),
            },
        )
        await this.consumedRows?.show(shown, `command:${randomUUID()}`).catch((error: unknown) => {
            Logger.warn(
                `[inputQueue] Could not show a performed command: ${error instanceof Error ? error.message : String(error)}`,
            )
        })
        return true
    }

    onTurnEndAwaiting(interaction: CanonicalQueueAwaitingInteraction): void {
        this.awaitingTurnEnd = interaction
        this.requestTurnEndDrain()
    }

    awaitsTurnEnd(interactionId: string): boolean {
        return this.awaitingTurnEnd?.interactionId === interactionId
    }

    private requestTurnEndDrain(): void {
        this.drainRequested = true
        if (this.drainPromise) return
        this.drainPromise = this.drainTurnEndRequests()
            .catch((error) => Logger.error("[inputQueue] Canonical turn-end delivery failed", error))
            .finally(() => {
                this.drainPromise = undefined
                if (this.drainRequested) this.requestTurnEndDrain()
            })
    }

    private async drainTurnEndRequests(): Promise<void> {
        while (this.drainRequested) {
            this.drainRequested = false
            await this.tryTurnEndDelivery()
        }
    }

    private async tryTurnEndDelivery(): Promise<void> {
        const interaction = this.awaitingTurnEnd
        if (!interaction) return
        const deliveryId = `queue:turn_end:${interaction.interactionId}`
        const reserved = await this.runtime.submit({
            type: "input_queue.delivery_reserved",
            generation: this.runtime.getState().generation,
            deliveryId,
            point: "turn_end",
            ownerId: interaction.interactionId,
        })
        if (reserved.kind === "rejected") return
        try {
            await reserved.receipt.durable
        } catch (error) {
            Logger.error(`[inputQueue] Could not persist turn-end reservation ${deliveryId}`, error)
            return
        }

        try {
            const entries = retainedQueueDeliveryEntries(this.runtime.getState().intake, deliveryId)
            if (entries.length === 0) return
            const delivery = await this.materializeTurnEndDelivery(deliveryId, interaction, entries, reserved.state.generation)
            const result = await this.turnEnd.deliverTurnEnd(delivery)
            if (result === "accepted" || result === "uncertain") {
                if (this.awaitingTurnEnd?.interactionId === interaction.interactionId) this.awaitingTurnEnd = undefined
                return
            }
            await this.releaseDelivery(deliveryId, reserved.state.generation)
            if (result === "changed") this.drainRequested = true
            if (result === "stale" && this.awaitingTurnEnd?.interactionId === interaction.interactionId) {
                this.awaitingTurnEnd = undefined
            }
        } catch (error) {
            // Only pre-response failures throw. A response whose durability is unknown
            // reports `uncertain` and must never be retried as unsent input.
            await this.releaseDelivery(deliveryId, reserved.state.generation)
            Logger.error(`[inputQueue] Could not materialize retained delivery ${deliveryId}`, error)
        }
    }

    private async materializeTurnEndDelivery(
        deliveryId: string,
        interaction: CanonicalQueueAwaitingInteraction,
        entries: ReturnType<typeof retainedQueueDeliveryEntries>,
        generation: number,
    ): Promise<CanonicalQueueTurnEndDelivery> {
        const payloads = await Promise.all(entries.map((entry) => this.readPayload(entry.payloadRef)))
        const modelText = renderRetainedInputs(payloads.map((payload) => payload.admittedText ?? payload.text ?? ""))
        const presentationText = payloads.map((payload) => payload.text ?? "").join("\n\n")
        // Legacy entries keep their flat lists; an entry with resources contributes
        // its admitted parts, so the batch persists each resource by reference in
        // entry order and a receiver resolves them only when it consumes the draft.
        const images = payloads.flatMap((payload) => [...(payload.images ?? [])])
        const files = payloads.flatMap((payload) => [...(payload.files ?? [])])
        const admittedParts = retainedInputPartsOf(payloads)
        const singleDocument = payloads.length === 1 ? payloads[0]?.semanticInput : undefined
        const draft = (text: string): CanonicalInputQueueDraft => ({
            text,
            images,
            files,
            ...(singleDocument === undefined ? {} : { semanticInput: singleDocument }),
            ...(admittedParts === undefined ? {} : { admittedParts }),
        })
        return {
            deliveryId,
            generation,
            entries: entries.map(({ entryId, payloadRef }) => ({ entryId, payloadRef })),
            interaction,
            mode: entries[0]?.mode ?? "queued",
            modelDraft: draft(modelText),
            presentationDraft: draft(presentationText),
        }
    }

    private async readPayload(payloadRef: string): Promise<UserInputEnvelope> {
        const cached = this.payloadCache.get(payloadRef)
        if (cached) return cached
        const payload = decodeTaskPayload<UserInputEnvelope>(await this.payloads.read(payloadRef))
        if (payload.kind !== "user_input") throw new Error(`Payload ${payloadRef} is not user input`)
        this.payloadCache.set(payloadRef, payload)
        return payload
    }

    private async releaseDelivery(deliveryId: string, generation: number): Promise<void> {
        const released = await this.runtime.submit({
            type: "input_queue.delivery_released",
            generation,
            deliveryId,
        })
        if (released.kind === "accepted") {
            try {
                await released.receipt.durable
            } catch (error) {
                Logger.error(`[inputQueue] Could not persist release for ${deliveryId}`, error)
            }
        }
    }
}
