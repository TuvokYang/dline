import type { UiAsk } from "@shared/ExtensionMessage"
import type { ClineContent } from "@shared/messages"
import type { InteractionKind } from "./Interaction"
import type { InteractionDraft, InteractionResponse, InteractionSelection } from "./InteractionResponse"

export interface OpenInteractionRequest {
    turnId: string
    interactionId: string
    kind: InteractionKind
    presentation: string
    existingTs?: number
}

export interface CompleteInteractionRequest {
    turnId: string
    interactionId: string
    completionId: string
    presentation: string
    existingTs?: number
}

export interface RetryInteractionRequest {
    turnId: string
    interactionId: string
    apiIndex: number
    presentation: string
    persistedRequest?: boolean
    retryContent?: ClineContent[]
}

export interface MistakeLimitInteractionRequest {
    turnId: string
    interactionId: string
    apiIndex: number
    presentation: string
}

export interface InteractionOutcome {
    actionId: InteractionResponse["actionId"]
    draft?: InteractionDraft
    selection?: InteractionSelection
    /** A causal presentation owner already handled the pure user-authored row. */
    feedbackPresented?: boolean
}

export interface InteractionAnchor {
    messageTs: number
    messageType: "ask" | "say"
    taskAsk?: UiAsk
}

export interface ActiveInteraction {
    taskId: string
    turnId: string
    interactionId: string
    kind: InteractionKind
    status: "opening" | "awaiting" | "resolving"
    createdRevision: number
    persistedRequest?: boolean
    retryContent?: ClineContent[]
    anchor?: InteractionAnchor
    acceptedResponse?: InteractionResponse
}

export interface AwaitingUserDurableBoundary {
    readonly turnId: string
    readonly interactionId: string
    readonly kind: InteractionKind
}

export interface DetachedInteractionContinuationContext {
    interaction: Readonly<ActiveInteraction>
    outcome: InteractionOutcome
    isCurrent(): boolean
    resolve(): Promise<void>
}

export type DetachedInteractionContinuation = (context: DetachedInteractionContinuationContext) => Promise<void>
