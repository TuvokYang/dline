import type { TaskState } from "@core/task/kernel"
import type { DispatchInteractionRequest } from "@shared/proto/dline/task"

/**
 * Name a refused dispatch by its causal identity.
 *
 * Identity is the whole reason a dispatch is refused, so a refusal that reports
 * none of it cannot be told apart from a request that never arrived. The draft
 * and selection payloads are deliberately omitted: they carry user content and
 * contribute nothing to deciding why the identity failed to match.
 */
export function describeDispatch(request: DispatchInteractionRequest): string {
    return [
        `taskId=${request.taskId}`,
        `turnId=${request.turnId}`,
        `interactionId=${request.interactionId}`,
        `stateRevision=${request.stateRevision}`,
        `actionId=${request.actionId}`,
    ].join(" ")
}

/**
 * Summarize why no dialog could accept a response.
 *
 * A promoted task that owns no dispatchable dialog looks identical to one that
 * simply stopped, so the slots and their statuses are what separate "the
 * recovery dialog never reached awaiting" from "no recovery dialog was planned".
 */
export function describeDialogState(state: TaskState): string {
    const slot = (name: string, interaction: TaskState["dialog"]["primary"]) =>
        interaction
            ? `${name}=${interaction.kind}:${interaction.status}:receiverGeneration=${interaction.receiverGeneration ?? "none"}`
            : `${name}=none`
    return [
        `revision=${state.revision}`,
        `generation=${state.generation}`,
        `flow=${state.flow.phase}`,
        `halt=${state.halt.status}`,
        slot("primary", state.dialog.primary),
        slot("interrupted", state.dialog.interrupted),
        `approvals=${Object.keys(state.dialog.approvalsByBlock).length}`,
    ].join(" ")
}
