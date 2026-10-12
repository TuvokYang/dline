import {
    type AdmittedInputPart,
    type AdmittedResourcePart,
    appendAdmittedPart,
    hasResourceParts,
} from "@shared/input-semantics/admitted-parts"
import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import { isResourceNode, type SemanticInputDocument } from "@shared/input-semantics/document"
import { documentKeptByTurn } from "@shared/input-semantics/document-slice"
import { presentationTextOfNode } from "@shared/input-semantics/presentation"
import type { TaskInput } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import {
    type AdmittedLifecycleBarrier,
    type AdmittedTaskInput,
    type LifecycleBarrierPort,
    type ReviewedReply,
    SemanticInputRejectedError,
    type TaskInputAdmissionOptions,
    type TaskInputAdmissionPort,
} from "./TaskInputAdmission"

export interface TaskInputIdentityPort {
    nextEntryId(): string
    nextSequence(): number
}

/**
 * The single place a submission becomes a durable task input.
 *
 * Admission runs here, at submit time, so a mention is captured when the user
 * agreed to it rather than whenever the queue happens to deliver the entry.
 */
export class TaskInputMaterializer {
    constructor(
        private readonly payloads: TaskPayloadStore,
        private readonly identity: TaskInputIdentityPort,
        private readonly admission: TaskInputAdmissionPort,
        /** Takes over lifecycle commands such as `/compact`; absent means they stay prose. */
        private readonly barriers?: LifecycleBarrierPort,
    ) {}

    async materialize(envelope: Omit<UserInputEnvelope, "kind">, mode: TaskInput["mode"] = "queued"): Promise<TaskInput> {
        return this.entry(mode, await this.materializePayload(envelope))
    }

    /**
     * Materialize the answer to a dialog.
     *
     * The answer was durable before anyone acted on it and may have been stored
     * by an earlier process, so its document keeps the catalog revision it was
     * accepted under: a newer catalog must not refuse or re-read what the user
     * already sent. This is the only entry that pins, so no other submission
     * can claim that standing.
     */
    async materializeAnswer(envelope: Omit<UserInputEnvelope, "kind">, mode: TaskInput["mode"] = "queued"): Promise<TaskInput> {
        return this.entry(mode, await this.persist(envelope, { pinnedRevision: true }))
    }

    async materializePayload(envelope: Omit<UserInputEnvelope, "kind">): Promise<string> {
        return this.persist(envelope)
    }

    private entry(mode: TaskInput["mode"], payloadRef: string): TaskInput {
        return { entryId: this.identity.nextEntryId(), sequence: this.identity.nextSequence(), mode, payloadRef }
    }

    private async persist(envelope: Omit<UserInputEnvelope, "kind">, options?: TaskInputAdmissionOptions): Promise<string> {
        const admitted = await this.review(envelope, options)
        return this.payloads.put(encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", ...envelope, ...admitted }))
    }

    /** Refusing here keeps a rejected submission out of the journal entirely. */
    private async review(
        envelope: Omit<UserInputEnvelope, "kind">,
        options?: TaskInputAdmissionOptions,
    ): Promise<Partial<UserInputEnvelope>> {
        const result = await this.admission.admit(envelope, options)
        if (!result.ok) throw new SemanticInputRejectedError(result.diagnostics)

        const owned = this.ownedBarrier(result.admitted)
        if (!owned) {
            // Admission is the only author of the projection: the text the model
            // reads and the authority the turn holds come from the same review.
            return {
                semanticInput: result.admitted.document,
                admittedText: result.admitted.admittedText,
                ...partsField(result.admitted.parts),
                authorizedTools: result.admitted.authorizedTools,
                explicitInstructions: result.admitted.explicitInstructions,
            }
        }
        // An owned barrier leaves the turn entirely - its text, its authority and
        // its tools - and travels with the input instead, so it only acts once
        // the kernel accepted the input and a round admitted it.
        return {
            semanticInput: result.admitted.document,
            admittedText: owned.turnText,
            ...partsField(owned.turnParts),
            authorizedTools: owned.toolsBefore,
            explicitInstructions: owned.instructionsBefore,
            lifecycle: { commandId: owned.commandId, premessage: owned.premessage },
        }
    }

    /**
     * Review a reply typed into an open dialog.
     *
     * A reply is the same user input as a submission, so a lifecycle command in
     * it must act rather than reach the model as literal feedback. Returns the
     * text the reply keeps once an owned command and its premessage are taken
     * out, or undefined when nothing was owned and the reply stands as typed.
     *
     * The kept text is what the user typed, not its expansion: a reply grants no
     * command authority, so expanded instructions would arrive without the tools
     * they name. A refused legacy reply stays literal too - the user answered a
     * question, and dropping that answer would be worse than sending it as is.
     * A structured reply is different: it was composed to be read exactly as
     * sent, so a refusal throws {@link SemanticInputRejectedError} instead of
     * degrading it, and so does a resource that fails verification.
     *
     * A reply with resources is always reviewed, even without a command: its
     * resources are verified by the same admission as a submission and handed
     * on in place as {@link ReviewedReply.parts}.
     */
    async reviewReply(reply: Omit<UserInputEnvelope, "kind">): Promise<ReviewedReply | undefined> {
        const structured = reply.semanticInput
        const resourceDocument = structured?.nodes.some(isResourceNode) ? structured : undefined
        if (!resourceDocument && (!this.barriers || !reply.text)) return undefined
        const result = await this.admission.admit(reply)
        if (!result.ok) {
            if (structured) throw new SemanticInputRejectedError(result.diagnostics)
            return undefined
        }
        const owned = this.ownedBarrier(result.admitted)
        if (!owned) {
            if (!resourceDocument) return undefined
            // Nothing was taken out, so the reply and its structure stand as sent.
            const parts = replyPartsOf(resourceDocument, result.admitted.parts)
            return { text: reply.text ?? "", document: resourceDocument, parts, commit: () => {} }
        }
        const document = documentKeptByTurn(result.admitted.document, owned.entityId)
        // Admission named this barrier from this document, so it must be found;
        // forwarding the whole document instead would let the command act twice.
        if (!document) throw new Error(`InconsistentReplyBarrier:${owned.entityId}`)
        const parts = replyPartsOf(document, owned.turnParts)
        const command = { commandId: owned.commandId, premessage: owned.premessage }
        return {
            text: document.rawText,
            document,
            parts,
            claimedBarrier: owned.entityId,
            commit: () => this.barriers?.request(command),
        }
    }

    private ownedBarrier(admitted: AdmittedTaskInput): AdmittedLifecycleBarrier | undefined {
        const barrier = admitted.barrier
        return barrier && this.barriers?.owns(barrier.commandId) ? barrier : undefined
    }
}

/**
 * A resource reached a carrier that renders text only.
 *
 * Refused rather than dropped: the user attached it, and a turn that silently
 * lacks it would answer a different question than the one asked.
 */
function unrenderedResources(document: SemanticInputDocument) {
    return semanticInputDiagnostic("semantic_input_resource_invalid", "this input cannot carry attachments yet", {
        documentId: document.documentId,
    })
}

/**
 * The reply as the user typed it, with each verified resource in its place.
 *
 * A reply grants no command authority, so its text stays the typed source
 * rather than the admitted expansion; only its resources come from admission,
 * matched by entity so the verified reference is the one persisted. Empty when
 * the reply holds no resource, because text alone represents it then.
 */
function replyPartsOf(document: SemanticInputDocument, admitted: readonly AdmittedInputPart[]): readonly AdmittedInputPart[] {
    // Decided by the document, not by what admission returned: a resource the
    // user placed but admission did not verify must refuse, never vanish.
    if (!document.nodes.some(isResourceNode)) return []
    const verified = new Map(
        admitted.filter((part): part is AdmittedResourcePart => part.kind === "resource").map((part) => [part.entityId, part]),
    )
    const parts: AdmittedInputPart[] = []
    for (const node of document.nodes) {
        if (!isResourceNode(node)) {
            appendAdmittedPart(parts, { kind: "text", text: presentationTextOfNode(node) })
            continue
        }
        const part = verified.get(node.entityId)
        // Admission verified every resource of this document, so one it did not is an inconsistency, not a choice.
        if (!part) throw new SemanticInputRejectedError([unrenderedResources(document)])
        appendAdmittedPart(parts, part)
    }
    return parts
}

/** Parts are persisted only when text alone cannot carry the submission, which keeps text-only payloads unchanged. */
function partsField(parts: readonly AdmittedInputPart[]): Pick<UserInputEnvelope, "admittedParts"> {
    return hasResourceParts(parts) ? { admittedParts: parts } : {}
}
