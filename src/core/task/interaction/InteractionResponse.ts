import type { AdmittedInputPart } from "@shared/input-semantics/admitted-parts"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { InteractionActionType } from "./Interaction"

/** Draft content submitted with an interaction action. */
export interface InteractionDraft {
    text: string
    images: string[]
    files: string[]
    /**
     * The structure this draft was composed as, when the client submitted one.
     *
     * Carried so admission validates the submitted structure instead of
     * rediscovering commands and mentions in `text`.
     */
    semanticInput?: SemanticInputDocument
    /**
     * The draft with each verified resource where the user placed it.
     *
     * The authority for a structured draft's attachments: such a draft keeps
     * `images` and `files` empty when it is persisted, and a receiver that reads
     * flat attachments resolves these parts when it consumes the draft.
     */
    admittedParts?: readonly AdmittedInputPart[]
}

/** Selection values submitted by selection-aware interactions. */
export interface InteractionSelection {
    values: string[]
}

/** Causally identified interaction response from the Webview. */
export interface InteractionResponse {
    taskId: string
    turnId: string
    interactionId: string
    actionId: InteractionActionType
    stateRevision: number
    draft?: InteractionDraft
    /** Optional presentation-only draft when model input contains internal guidance. */
    presentationDraft?: InteractionDraft
    /** Stable UI semantics for user-authored input. */
    userInputKind?: "direct" | "queued"
    /** Delivery pool for a queued input presentation. */
    queuedInputMode?: "queued" | "steering"
    selection?: InteractionSelection
}

/** Expected validation failures that do not throw. */
export type InteractionResponseErrorCode =
    | "stale_interaction"
    | "invalid_action"
    | "invalid_interaction_payload"
    | "duplicate_response"
