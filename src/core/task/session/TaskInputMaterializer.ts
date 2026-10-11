import { type AdmittedInputPart, type AdmittedResourcePart, hasResourceParts } from "@shared/input-semantics/admitted-parts"
import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import { isResourceNode, type SemanticInputDocument } from "@shared/input-semantics/document"
import { documentKeptByTurn } from "@shared/input-semantics/document-slice"
import type { TaskInput } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import {
    type AdmittedLifecycleBarrier,
    type AdmittedTaskInput,
    type LegacyResourceCarrierPort,
    type LegacyResourceCarriers,
    type LifecycleBarrierPort,
    type ReviewedReply,
    SemanticInputRejectedError,
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
        /** Carries verified resources to dialog receivers; absent means replies refuse attachments. */
        private readonly carriers?: LegacyResourceCarrierPort,
    ) {}

    async materialize(envelope: Omit<UserInputEnvelope, "kind">, mode: TaskInput["mode"] = "queued"): Promise<TaskInput> {
        return {
            entryId: this.identity.nextEntryId(),
            sequence: this.identity.nextSequence(),
            mode,
            payloadRef: await this.materializePayload(envelope),
        }
    }

    async materializePayload(envelope: Omit<UserInputEnvelope, "kind">): Promise<string> {
        const admitted = await this.review(envelope)
        return this.payloads.put(encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", ...envelope, ...admitted }))
    }

    /** Refusing here keeps a rejected submission out of the journal entirely. */
    private async review(envelope: Omit<UserInputEnvelope, "kind">): Promise<Partial<UserInputEnvelope>> {
        const result = await this.admission.admit(envelope)
        if (!result.ok) throw new SemanticInputRejectedError(result.diagnostics)

        const owned = this.ownedBarrier(result.admitted)
        if (!owned) {
            // A caller that supplies its own projection owns the whole of it, so it
            // can only replace text: resources it would silently drop are refused.
            if (envelope.admittedText !== undefined && hasResourceParts(result.admitted.parts)) {
                throw new SemanticInputRejectedError([unrenderedResources(result.admitted.document)])
            }
            const parts = envelope.admittedText === undefined ? result.admitted.parts : []
            return {
                semanticInput: result.admitted.document,
                admittedText: envelope.admittedText ?? result.admitted.admittedText,
                ...partsField(parts),
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
     * degrading it, and so does a resource that fails verification or that no
     * carrier can hand to the receiver.
     *
     * A reply with resources is always reviewed, even without a command: its
     * resources are verified by the same admission as a submission and handed
     * on as {@link ReviewedReply.images} and {@link ReviewedReply.files}.
     */
    async reviewReply(reply: Omit<UserInputEnvelope, "kind">): Promise<ReviewedReply | undefined> {
        const structured = reply.semanticInput
        const resourceDocument = structured?.nodes.some(isResourceNode) ? structured : undefined
        if (resourceDocument && !this.carriers) throw new SemanticInputRejectedError([unrenderedResources(resourceDocument)])
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
            const carried = await this.carry(resourceDocument, result.admitted.parts)
            return { text: reply.text ?? "", document: resourceDocument, ...carried, commit: () => {} }
        }
        const document = documentKeptByTurn(result.admitted.document, owned.entityId)
        // Admission named this barrier from this document, so it must be found;
        // forwarding the whole document instead would let the command act twice.
        if (!document) throw new Error(`InconsistentReplyBarrier:${owned.entityId}`)
        const carried = await this.carry(document, owned.turnParts)
        const command = { commandId: owned.commandId, premessage: owned.premessage }
        return { text: document.rawText, document, ...carried, commit: () => this.barriers?.request(command) }
    }

    /**
     * The flat carriers of the resources a retained input holds, for a receiver
     * that reads no parts, such as a dialog answered by queued input.
     */
    async carry(document: SemanticInputDocument, parts: readonly AdmittedInputPart[]): Promise<LegacyResourceCarriers> {
        const resources = parts.filter((part): part is AdmittedResourcePart => part.kind === "resource")
        if (resources.length === 0) return { images: [], files: [] }
        if (!this.carriers) throw new SemanticInputRejectedError([unrenderedResources(document)])
        return this.carriers.project(document.documentId, resources)
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

/** Parts are persisted only when text alone cannot carry the submission, which keeps text-only payloads unchanged. */
function partsField(parts: readonly AdmittedInputPart[]): Pick<UserInputEnvelope, "admittedParts"> {
    return hasResourceParts(parts) ? { admittedParts: parts } : {}
}
