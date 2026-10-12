import { randomUUID } from "node:crypto"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import { openTransitionDraft } from "../kernel"
import type { RuntimeFacade } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { TransitionDraftEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

/** The composer draft a Mode or Profile switch carries, as the composer sent it. */
export interface TransitionDraftContent {
    readonly text: string
    readonly images: readonly string[]
    readonly files: readonly string[]
    readonly semanticInput?: SemanticInputDocument
}

/** A recorded transition draft whose dialog is still open. */
export interface RecordedTransitionDraft extends TransitionDraftContent {
    readonly draftId: string
}

/** Why a transition draft was not recorded. */
export type TransitionDraftRecordResult = "recorded" | "read_only" | "refused" | "persist_failed"

/**
 * Keeps the draft a Mode or Profile switch carries to an awaiting dialog.
 *
 * The switch delivers the draft only after its target handler is in place,
 * which may take a compaction; until then the draft exists nowhere else the
 * task can see. Recording it in the task makes a reload in between give the
 * user their draft back instead of losing it. The kernel drops the record as
 * soon as the dialog it answers closes, whoever closed it.
 */
export class TransitionDraftApplication {
    /**
     * The last fact read, with what reading it gave. An unreadable payload is
     * remembered too: every state post projects the draft, and retrying a read
     * that already failed would repeat the failure and its warning each time.
     */
    private cached:
        | { readonly draftId: string; readonly payloadRef: string; readonly draft: RecordedTransitionDraft | undefined }
        | undefined

    constructor(
        private readonly runtime: RuntimeFacade,
        private readonly payloads: TaskPayloadStore,
    ) {}

    /**
     * Records `draft` for the awaiting dialog `interactionId`.
     *
     * Nothing is written for a task this window may not write, so a refused
     * request leaves no payload behind.
     */
    async record(interactionId: string, draft: TransitionDraftContent): Promise<TransitionDraftRecordResult> {
        if (!this.runtime.isWritable()) return "read_only"
        const envelope: TransitionDraftEnvelope = {
            kind: "transition_draft",
            text: draft.text,
            images: [...draft.images],
            files: [...draft.files],
            ...(draft.semanticInput ? { semanticInput: draft.semanticInput } : {}),
        }
        const payloadRef = await this.payloads.put(encodeTaskPayload(envelope))
        const submitted = await this.runtime.submit({
            type: "transition_draft.recorded",
            generation: this.runtime.getState().generation,
            draftId: randomUUID(),
            payloadRef,
            interactionId,
        })
        if (submitted.kind === "rejected") return submitted.reason === "read_only" ? "read_only" : "refused"
        try {
            await submitted.receipt.durable
        } catch {
            return "persist_failed"
        }
        return "recorded"
    }

    /**
     * The recorded draft whose dialog is still open, if any.
     *
     * A payload that cannot be read reads as no draft: the draft is a courtesy
     * to the user, and its loss must not stop the task from opening.
     */
    async project(): Promise<RecordedTransitionDraft | undefined> {
        const fact = openTransitionDraft(this.runtime.getState())
        if (!fact) return undefined
        if (this.cached?.payloadRef === fact.payloadRef && this.cached.draftId === fact.draftId) return this.cached.draft
        const draft = await this.read(fact.draftId, fact.payloadRef)
        this.cached = { draftId: fact.draftId, payloadRef: fact.payloadRef, draft }
        return draft
    }

    private async read(draftId: string, payloadRef: string): Promise<RecordedTransitionDraft | undefined> {
        try {
            const envelope = decodeTaskPayload<TransitionDraftEnvelope>(await this.payloads.read(payloadRef))
            if (envelope.kind !== "transition_draft") throw new Error(`Unexpected payload kind ${String(envelope.kind)}`)
            return {
                draftId,
                text: envelope.text,
                images: envelope.images,
                files: envelope.files,
                ...(envelope.semanticInput ? { semanticInput: envelope.semanticInput } : {}),
            }
        } catch (error) {
            Logger.warn(`[transitionDraft] Could not read transition draft ${draftId}`, error)
            return undefined
        }
    }
}
