import type { QueuedInputEntry } from "@shared/InputQueue"
import type { AdmittedInputPart } from "@shared/input-semantics/admitted-parts"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { InteractionKind } from "../interaction/Interaction"
import type { QueuePayloadIdentity } from "../kernel"

export interface CanonicalInputQueueDraft {
    readonly text: string
    readonly images: readonly string[]
    readonly files: readonly string[]
    readonly activeQuote?: string
    readonly semanticInput?: SemanticInputDocument
    /** Each entry's resources by reference, in entry order; resolved only when a receiver consumes the draft. */
    readonly admittedParts?: readonly AdmittedInputPart[]
}

export type CanonicalInputQueueMutation =
    /** `mode` is the entry's mode from the moment it is admitted, `queued` when omitted; a steering entry never waits as queued. */
    | { readonly kind: "enqueue"; readonly draft: CanonicalInputQueueDraft; readonly mode?: "queued" | "steering" }
    | { readonly kind: "toggle_mode"; readonly entryId: string }
    | { readonly kind: "reorder"; readonly entryId: string; readonly targetIndex: number }
    | { readonly kind: "begin_edit"; readonly entryId: string }
    | { readonly kind: "commit_edit"; readonly entryId: string; readonly draft: CanonicalInputQueueDraft }
    | { readonly kind: "cancel_edit"; readonly entryId: string }
    | { readonly kind: "remove"; readonly entryId: string }

export interface CanonicalInputQueueMutationResult {
    readonly accepted: boolean
    readonly result: string
}

export interface CanonicalQueueAwaitingInteraction {
    readonly turnId: string
    readonly interactionId: string
    readonly kind: InteractionKind
}

export interface CanonicalQueueTurnEndDelivery {
    readonly deliveryId: string
    readonly generation: number
    readonly entries: readonly QueuePayloadIdentity[]
    readonly interaction: CanonicalQueueAwaitingInteraction
    readonly mode: "queued" | "steering"
    readonly modelDraft: CanonicalInputQueueDraft
    readonly presentationDraft: CanonicalInputQueueDraft
}

export type CanonicalQueueTurnEndResult = "accepted" | "stale" | "changed" | "failed" | "uncertain"

/** Submits one retained batch through the canonical dialog response protocol. */
export interface CanonicalQueueTurnEndPort {
    deliverTurnEnd(delivery: CanonicalQueueTurnEndDelivery): Promise<CanonicalQueueTurnEndResult>
}

export interface InputQueueApplicationPort {
    mutate(mutation: CanonicalInputQueueMutation): Promise<CanonicalInputQueueMutationResult>
    project(): Promise<readonly QueuedInputEntry[]>
    /** Called only after the dialog reveal is durable and answerable. */
    onTurnEndAwaiting(interaction: CanonicalQueueAwaitingInteraction): void
}
