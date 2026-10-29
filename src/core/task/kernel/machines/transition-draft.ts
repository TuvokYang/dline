import type { DialogInteraction, RejectReason, TaskEvent, TaskState, TransitionDraftFact } from "../types"

type ValidationFailure = { readonly reason: RejectReason; readonly message: string }

/** The reply action a transition draft is delivered through. */
const REPLY_ACTION_ID = "reply"

function acceptsReply(interaction: DialogInteraction): boolean {
    return interaction.actionRules.some((rule) => rule.actionId === REPLY_ACTION_ID)
}

/**
 * The dialog a transition draft can answer right now, if any.
 *
 * Only the primary dialog, while it awaits a reply from a live receiver, can
 * take the draft a Mode or Profile switch carries. Recording and delivering a
 * draft both ask this one question, so a draft is never kept for a dialog it
 * could not be delivered to.
 */
export function replyableDialog(state: TaskState): DialogInteraction | undefined {
    const primary = state.dialog.primary
    if (!primary || primary.status !== "awaiting" || primary.receiverGeneration === undefined) return undefined
    return acceptsReply(primary) ? primary : undefined
}

/**
 * The transition draft that still has a dialog to answer, if any.
 *
 * A draft belongs to the dialog it was recorded for for as long as that dialog
 * is open. Restoring a task may move an awaiting dialog back to `planned` or
 * `prepared` so it is revealed again, and an interrupting dialog may set it
 * aside until it is answered; both leave the draft its owner. A committed
 * response (`resolving`) or the dialog's disappearance ends it.
 */
export function openTransitionDraft(state: TaskState): TransitionDraftFact | undefined {
    const draft = state.transitionDraft
    if (!draft) return undefined
    const owner = [state.dialog.primary, state.dialog.interrupted].find(
        (interaction) => interaction?.interactionId === draft.interactionId,
    )
    return owner && owner.status !== "resolving" ? draft : undefined
}

/** `state` without a transition draft whose dialog has closed. */
export function withoutClosedTransitionDraft(state: TaskState): TaskState {
    if (!state.transitionDraft || openTransitionDraft(state)) return state
    const { transitionDraft: _closed, ...withoutDraft } = state
    return withoutDraft
}

/** Refuses a draft recorded for a dialog that cannot take it: nobody could deliver it after a restore. */
export function validateTransitionDraftEvent(state: TaskState, event: TaskEvent): ValidationFailure | undefined {
    if (event.type !== "transition_draft.recorded") return undefined
    if (state.dialog.primary?.interactionId !== event.interactionId)
        return { reason: "identity_mismatch", message: `Interaction ${event.interactionId} is not the primary dialog` }
    if (replyableDialog(state)?.interactionId !== event.interactionId)
        return { reason: "phase_invalid", message: `Interaction ${event.interactionId} does not await a reply` }
    return undefined
}

/**
 * Records a transition draft and drops one whose dialog has closed.
 *
 * Applied after every other slice has reduced the event, so the draft follows
 * the dialog it answers whichever event closed it: the switch's own reply, a
 * reply the user sent meanwhile, a dismissal, a stop, or a handoff.
 *
 * A task keeps one draft: a later recording replaces an earlier one, since a
 * view has one composer and its latest capture is the user's latest intent.
 */
export function reduceTransitionDraft(next: TaskState, event: TaskEvent): TaskState {
    const recorded =
        event.type === "transition_draft.recorded"
            ? {
                  ...next,
                  transitionDraft: { draftId: event.draftId, payloadRef: event.payloadRef, interactionId: event.interactionId },
              }
            : next
    return withoutClosedTransitionDraft(recorded)
}
