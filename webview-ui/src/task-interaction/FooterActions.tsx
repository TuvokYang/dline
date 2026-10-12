import type { TaskViewAction, TaskViewState } from "@shared/ExtensionMessage"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import {
    type AcceptedInteractionSettlement,
    buildInteractionRequest,
    captureInteractionDraft,
    createAcceptedInteractionSettlement,
    type DispatchInteraction,
    type InteractionDraft,
    type InteractionSelection,
    type PendingSuccessorDraftTransfer,
} from "./types"

/** Props for the backend-projected task footer. */
export interface FooterActionsProps {
    view: TaskViewState
    draft: InteractionDraft
    selection?: InteractionSelection
    dispatch: DispatchInteraction
    dispatchTaskAction?: (action: TaskViewAction) => Promise<void>
    onDraftAccepted?: (settlement: AcceptedInteractionSettlement) => void
    onDraftRejected?: (settlement: AcceptedInteractionSettlement) => void
    onSuccessorAccepted?: (transfer: PendingSuccessorDraftTransfer) => void
    /** Task the pending New Task would open its successor with. */
    successorTask?: string
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "The action could not be completed."
}

/** Render and dispatch footer actions without inspecting message history. */
export function FooterActions({
    view,
    draft,
    selection,
    dispatch,
    dispatchTaskAction,
    onDraftAccepted,
    onDraftRejected,
    onSuccessorAccepted,
    successorTask,
}: FooterActionsProps) {
    // A dispatch is pending for the task and interaction that issued it, but not
    // for a single `stateRevision`. Cancelling makes the backend publish further
    // projections of the same task while the RPC is still in flight; keying the
    // latch on the revision let each of those releases re-enable the button
    // mid-cancellation, so the user could fire duplicate cancels against a task
    // that was already winding down. Switching task or interaction still starts
    // a fresh scope, because that is genuinely different work.
    const dispatchScope = `${view.taskId}:${view.activeInteraction?.interactionId ?? ""}`
    const [pendingState, setPendingState] = useState<string>()
    const pending = pendingState === dispatchScope
    const beginPending = () => setPendingState(dispatchScope)
    // Clear only the scope this call owns; a late settle must not release the
    // pending state of a newer projection that has already started its own work.
    const endPending = (scope: string) => setPendingState((current) => (current === scope ? undefined : current))
    // Errors stay bound to the exact projection that produced them: a newer
    // backend state supersedes the failure the user was shown.
    const errorScope = `${dispatchScope}:${view.stateRevision}`
    const [errorState, setErrorState] = useState<{ scope: string; message: string }>()
    const error = errorState?.scope === errorScope ? errorState.message : undefined
    const setError = (message?: string) => setErrorState(message ? { scope: errorScope, message } : undefined)
    const actions = view.footer.actions.filter((action) => action.type !== "reply" || view.input.enterAction !== "reply")
    if (actions.length === 0) {
        return null
    }

    return (
        <div className="mx-3.5">
            {error ? (
                <div className="mb-1 text-xs text-(--vscode-errorForeground)" role="alert">
                    {error}
                </div>
            ) : null}
            <div className="flex gap-1.5">
                {actions.map((action) => {
                    const targetsTask = action.dispatchTarget === "task"
                    const carriesDraft = action.payloadPolicy === "draft" || action.payloadPolicy === "draft_and_selection"
                    const dispatcherAvailable = targetsTask ? Boolean(dispatchTaskAction) : Boolean(view.activeInteraction)
                    const startsSuccessor = view.activeInteraction?.kind === "new_task" && action.type === "approve"
                    const buttonDisabled = !action.enabled || pending || !dispatcherAvailable
                    return (
                        <VSCodeButton
                            appearance={action.appearance === "primary" ? "primary" : "secondary"}
                            aria-disabled={buttonDisabled}
                            aria-label={action.label}
                            className="flex-1 border border-(--vscode-panel-border) rounded focus:ring-2 focus:ring-[--vscode-focusBorder]"
                            disabled={buttonDisabled}
                            key={action.type}
                            onClick={() => {
                                if (pending) {
                                    return
                                }
                                if (targetsTask) {
                                    const supportedTaskAction =
                                        action.type === "cancel" ||
                                        action.type === "retry" ||
                                        (action.type === "continue_in_background" && Boolean(action.activityId))
                                    if (!dispatchTaskAction || !supportedTaskAction) {
                                        return
                                    }
                                    const taskScope = dispatchScope
                                    setError(undefined)
                                    beginPending()
                                    void dispatchTaskAction(action)
                                        .catch((cause: unknown) => setError(errorMessage(cause)))
                                        .finally(() => endPending(taskScope))
                                    return
                                }
                                const capturedDraft = captureInteractionDraft(draft)
                                const request = buildInteractionRequest(view, action.type, capturedDraft, selection)
                                if (!request) {
                                    return
                                }
                                const interactionScope = dispatchScope
                                setError(undefined)
                                beginPending()
                                // Clear before dispatching so every submit path answers "when does
                                // the composer empty?" the same way. The rollback below is what
                                // makes that safe: a refused or failed dispatch puts the draft back.
                                const settlement = createAcceptedInteractionSettlement(request, capturedDraft)
                                if (carriesDraft) {
                                    onDraftAccepted?.(settlement)
                                }
                                void dispatch(request)
                                    .then((response) => {
                                        if (!response.accepted) {
                                            setError(`Interaction was not accepted: ${response.result || "unknown error"}`)
                                            if (carriesDraft) {
                                                onDraftRejected?.(settlement)
                                            }
                                            return
                                        }
                                        if (startsSuccessor && successorTask) {
                                            onSuccessorAccepted?.({
                                                sourceTaskId: request.taskId,
                                                task: successorTask,
                                                draft: capturedDraft,
                                            })
                                        }
                                    })
                                    .catch((cause: unknown) => {
                                        setError(errorMessage(cause))
                                        if (carriesDraft) {
                                            onDraftRejected?.(settlement)
                                        }
                                    })
                                    .finally(() => endPending(interactionScope))
                            }}
                            role="button">
                            {action.label}
                        </VSCodeButton>
                    )
                })}
            </div>
        </div>
    )
}
