import type { TaskHandoffSource, TaskViewActionType, TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { matchesActiveInteractionAnchor } from "@shared/interaction-anchor"
import type { DispatchInteractionRequest, DispatchInteractionResponse } from "@shared/proto/dline/task"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"

/** Complete Webview draft snapshot owned by the chat composition root. */
export interface InteractionDraft {
    text: string
    images: string[]
    files: string[]
    activeQuote?: string | null
    ownerRevision?: number
    /**
     * The structured meaning of `text`, present only when it differs from what
     * Core's legacy adapter would read - today, a pasted candidate held back
     * until the user confirms it (WS-041 AC-09).
     */
    semanticInput?: SemanticInputDocument
}

/**
 * Whether a value read back from storage has the shape of a draft.
 *
 * Webview state survives extension updates, so what it hands back is checked
 * rather than trusted.
 */
export function isInteractionDraft(value: unknown): value is InteractionDraft {
    if (!value || typeof value !== "object") return false
    const draft = value as Partial<InteractionDraft>
    return typeof draft.text === "string" && Array.isArray(draft.images) && Array.isArray(draft.files)
}

/** Capture mutable draft values before dispatching an interaction. */
export function captureInteractionDraft(draft: InteractionDraft): InteractionDraft {
    return {
        text: draft.text,
        images: [...draft.images],
        files: [...draft.files],
        activeQuote: draft.activeQuote ?? null,
        ownerRevision: draft.ownerRevision,
        // Composed documents are immutable, so the reference is already a snapshot.
        ...(draft.semanticInput === undefined ? {} : { semanticInput: draft.semanticInput }),
    }
}

/** Compare complete draft ownership state before applying an accepted settlement. */
export function isSameInteractionDraft(current: InteractionDraft, captured: InteractionDraft): boolean {
    return (
        current.text === captured.text &&
        current.activeQuote === captured.activeQuote &&
        current.ownerRevision === captured.ownerRevision &&
        current.images.length === captured.images.length &&
        current.images.every((image, index) => image === captured.images[index]) &&
        current.files.length === captured.files.length &&
        current.files.every((file, index) => file === captured.files[index])
    )
}

/**
 * Unsent composer draft retained across an accepted New Task approval.
 *
 * It is put back into the successor's composer, never sent: the approval
 * itself carries nothing to the successor.
 */
export interface PendingSuccessorDraftTransfer {
    readonly sourceTaskId: string
    /** The approved new_task interaction; the successor's view names it as its handoff source. */
    readonly interactionId: string
    readonly draft: InteractionDraft
}

/** Whether a value read back from storage is a retained successor draft. */
export function isPendingSuccessorDraftTransfer(value: unknown): value is PendingSuccessorDraftTransfer {
    if (!value || typeof value !== "object") return false
    const transfer = value as Partial<PendingSuccessorDraftTransfer>
    return (
        typeof transfer.sourceTaskId === "string" &&
        typeof transfer.interactionId === "string" &&
        isInteractionDraft(transfer.draft)
    )
}

/** What the composition owner does with a retained successor draft on the current surface. */
export type SuccessorDraftDisposition = "wait" | "restore" | "drop"

/** Task surface facts the successor draft decision observes. */
export interface SuccessorDraftSurface {
    /** Task the view currently selects. */
    readonly taskId?: string
    /** Task the backend projection has settled on; differs from `taskId` while a switch is in flight. */
    readonly projectedTaskId?: string
    /** The handoff the projected opening was started by, if any. */
    readonly handoffSource?: TaskHandoffSource
}

/**
 * Decide the retained draft's fate once a task other than its source is shown.
 *
 * Only a settled surface decides. The successor is recognised by the handoff
 * the backend says opened it, never by its text, so another task that happens
 * to read the same cannot take the draft. Any other task means the user
 * navigated away, and the draft belongs to neither.
 */
export function resolveSuccessorDraft(
    transfer: PendingSuccessorDraftTransfer,
    surface: SuccessorDraftSurface,
): SuccessorDraftDisposition {
    const { taskId, projectedTaskId, handoffSource } = surface
    if (!taskId || taskId === transfer.sourceTaskId || projectedTaskId !== taskId) {
        return "wait"
    }
    const succeeds = handoffSource?.taskId === transfer.sourceTaskId && handoffSource.interactionId === transfer.interactionId
    return succeeds ? "restore" : "drop"
}

/** Accepted interaction identity and exact draft snapshot returned to the composition owner. */
export interface AcceptedInteractionSettlement {
    readonly taskId: string
    readonly turnId: string
    readonly interactionId: string
    readonly stateRevision: number
    readonly draft: InteractionDraft
}

/** Selection values owned by selection-aware presentation renderers. */
export interface InteractionSelection {
    values: string[]
}

/** Create an immutable accepted settlement from the exact dispatched request. */
export function createAcceptedInteractionSettlement(
    request: DispatchInteractionRequest,
    draft: InteractionDraft,
): AcceptedInteractionSettlement {
    return {
        taskId: request.taskId,
        turnId: request.turnId,
        interactionId: request.interactionId,
        stateRevision: request.stateRevision,
        draft: captureInteractionDraft(draft),
    }
}

/** Guard the composition owner against stale accepted responses. */
export function canApplyAcceptedInteractionSettlement(
    currentTaskId: string | undefined,
    currentDraft: InteractionDraft,
    settlement: AcceptedInteractionSettlement,
): boolean {
    return currentTaskId === settlement.taskId && isSameInteractionDraft(currentDraft, settlement.draft)
}

/** Whether a draft holds nothing the user would lose by overwriting it. */
function isEmptyInteractionDraft(draft: InteractionDraft): boolean {
    return draft.text === "" && draft.images.length === 0 && draft.files.length === 0
}

/** Local evidence used to fence a delayed rollback without guessing from feedback text. */
export interface DraftRollbackEvidence {
    currentEpoch: number
    submissionEpoch: number
    messages: readonly UiMessage[]
}

/**
 * Guard the rollback that follows a rejected dispatch.
 *
 * Every submit path clears optimistically, so a rejection has to put the
 * submitted draft back or the user silently loses it. The owner revision has
 * already moved on by then, which is why this cannot reuse the accepted-
 * settlement guard: restoring is safe exactly while the composer is still
 * empty. Anything typed during the round trip is newer and must win.
 */
export function canRestoreRejectedInteractionDraft(
    currentTaskId: string | undefined,
    currentDraft: InteractionDraft,
    settlement: AcceptedInteractionSettlement,
    evidence?: DraftRollbackEvidence,
): boolean {
    if (evidence?.currentEpoch !== evidence?.submissionEpoch) return false
    if (
        settlement.interactionId &&
        evidence?.messages.some(
            (message) =>
                message.type === "say" && message.say === "user_feedback" && message.interactionId === settlement.interactionId,
        )
    ) {
        return false
    }
    return currentTaskId === settlement.taskId && isEmptyInteractionDraft(currentDraft)
}

/** Injectable causal protocol boundary used by interaction components. */
export type DispatchInteraction = (request: DispatchInteractionRequest) => Promise<DispatchInteractionResponse>

/** Resolve the exact ask row owned by the projected active interaction. */
export function findActiveInteractionAnchor(messages: readonly UiMessage[], view: TaskViewState): UiMessage | undefined {
    const interaction = view.activeInteraction
    if (!interaction) {
        return undefined
    }
    const matches = messages.filter((message) => matchesActiveInteractionAnchor(message, interaction))
    return matches.length === 1 ? matches[0] : undefined
}

/**
 * Whether the Webview can act on the projected interaction.
 *
 * A view without an active interaction needs no ask anchor. When one is
 * active, the backend's `anchorVerified` is the stronger evidence: it is
 * written in durable order, while the local row may still be outside the
 * loaded message window or folded away by the presentation combiners. The
 * footer already dispatches on that flag, so requiring the local row here too
 * left the composer disabled beneath a footer the user could click.
 *
 * The local lookup remains the fallback for an older projection that does not
 * carry the flag; an active interaction still needs exactly one match.
 */
export function isActiveInteractionSynchronized(messages: readonly UiMessage[], view: TaskViewState): boolean {
    const interaction = view.activeInteraction
    if (!interaction) {
        return true
    }
    return interaction.anchorVerified === true || Boolean(findActiveInteractionAnchor(messages, view))
}

/** Build one causal request from the current backend projection. */
export function buildInteractionRequest(
    view: TaskViewState,
    actionId: TaskViewActionType,
    draft: InteractionDraft,
    selection?: InteractionSelection,
): DispatchInteractionRequest | undefined {
    const interaction = view.activeInteraction
    if (!interaction) {
        return undefined
    }
    const action = view.footer.actions.find(
        (candidate) => candidate.type === actionId && candidate.dispatchTarget === "interaction",
    )
    const carriesDraft = action
        ? action.payloadPolicy === "draft" || action.payloadPolicy === "draft_and_selection"
        : view.input.enterAction === actionId
    return {
        taskId: interaction.taskId,
        taskInstanceId: view.taskInstanceId ?? "",
        turnId: interaction.turnId,
        interactionId: interaction.interactionId,
        actionId,
        stateRevision: interaction.stateRevision,
        draft: carriesDraft
            ? {
                  text: draft.text,
                  images: [...draft.images],
                  files: [...draft.files],
                  ...(draft.semanticInput === undefined
                      ? {}
                      : { semanticInput: toProtoSemanticInputDocument(draft.semanticInput) }),
              }
            : undefined,
        selection: selection ? { values: [...selection.values] } : undefined,
    }
}
