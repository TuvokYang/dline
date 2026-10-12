import type { TaskViewAction, TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { useState } from "react"
import { FooterActions } from "./FooterActions"
import { isPresentationKind, renderPresentation } from "./renderer-registry"
import { dispatchTaskAction } from "./task-actions"
import {
    type AcceptedInteractionSettlement,
    type DispatchInteraction,
    findActiveInteractionAnchor,
    type InteractionDraft,
    type PendingSuccessorDraftTransfer,
} from "./types"

/** Presentation-only props for a say timeline row. */
export interface SayViewProps {
    message: UiMessage
}

/** Presentation-only say row with no action or dispatch capability. */
export function SayView({ message }: SayViewProps) {
    return <div>{message.text}</div>
}

/** Presentation-only props for an ask timeline row. */
export interface AskViewProps {
    message: UiMessage
}

/** Read-only ask presentation; actions are rendered only by the host footer. */
export function AskView({ message }: AskViewProps) {
    return <div>{message.text}</div>
}

/** Props for the task interaction synchronization boundary. */
export interface InteractionHostProps {
    messages: UiMessage[]
    view: TaskViewState
    dispatch: DispatchInteraction
    draft?: InteractionDraft
    showTimeline?: boolean
    onDraftAccepted?: (settlement: AcceptedInteractionSettlement) => void
    onDraftRejected?: (settlement: AcceptedInteractionSettlement) => void
    onSuccessorAccepted?: (transfer: PendingSuccessorDraftTransfer) => void
}

const EMPTY_DRAFT: InteractionDraft = { text: "", images: [], files: [], activeQuote: null }

const FOOTER_APPROVAL_PRESENTATIONS = new Set([
    "tool_approval",
    "command_approval",
    "browser_approval",
    "mcp_approval",
    "subagent_approval",
    "spawn_task_approval",
    "focus_chain_change",
])

/** Bind one backend interaction projection to its exact ask presentation anchor. */
export function InteractionHost({
    messages,
    view,
    dispatch,
    draft = EMPTY_DRAFT,
    showTimeline = true,
    onDraftAccepted,
    onDraftRejected,
    onSuccessorAccepted,
}: InteractionHostProps) {
    const [selection, setSelection] = useState<string[]>([])
    const interaction = view.activeInteraction
    const anchor = findActiveInteractionAnchor(messages, view)
    const presentationKind = interaction?.presentationKind
    const supported = presentationKind ? isPresentationKind(presentationKind) : false
    const showAnchorPresentation = showTimeline || (presentationKind && FOOTER_APPROVAL_PRESENTATIONS.has(presentationKind))
    const canRenderVerifiedFooter = Boolean(
        interaction && !anchor && supported && interaction.anchorVerified && interaction.kind !== "new_task",
    )
    const taskActionDispatcher = (action: TaskViewAction) => dispatchTaskAction(view, action)
    const taskOnlyView: TaskViewState = {
        ...view,
        activeInteraction: undefined,
        input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
        footer: { actions: view.footer.actions.filter((action) => action.dispatchTarget === "task") },
    }

    return (
        <section>
            {showTimeline &&
                messages.map((message, index) => {
                    if (message === anchor && supported) {
                        return null
                    }
                    return message.type === "say" ? (
                        <SayView key={`${message.ts}:${message.interactionId ?? ""}:${index}`} message={message} />
                    ) : (
                        <AskView key={`${message.ts}:${message.interactionId ?? ""}:${index}`} message={message} />
                    )
                })}
            {interaction && (!anchor || !supported) && !canRenderVerifiedFooter ? (
                // An unmatched anchor is a transient window gap: the backend re-reveals a
                // dialog whose row was lost, so only task-level actions stay meanwhile.
                <FooterActions
                    dispatch={dispatch}
                    dispatchTaskAction={taskActionDispatcher}
                    draft={draft}
                    onDraftAccepted={onDraftAccepted}
                    onDraftRejected={onDraftRejected}
                    onSuccessorAccepted={onSuccessorAccepted}
                    view={taskOnlyView}
                />
            ) : canRenderVerifiedFooter ? (
                <FooterActions
                    dispatch={dispatch}
                    dispatchTaskAction={taskActionDispatcher}
                    draft={draft}
                    onDraftAccepted={onDraftAccepted}
                    onDraftRejected={onDraftRejected}
                    onSuccessorAccepted={onSuccessorAccepted}
                    view={view}
                />
            ) : anchor && presentationKind && isPresentationKind(presentationKind) ? (
                <>
                    {showAnchorPresentation
                        ? renderPresentation(presentationKind, { message: anchor, selection, onSelectionChange: setSelection })
                        : null}
                    <FooterActions
                        dispatch={dispatch}
                        dispatchTaskAction={taskActionDispatcher}
                        draft={draft}
                        onDraftAccepted={onDraftAccepted}
                        onDraftRejected={onDraftRejected}
                        onSuccessorAccepted={onSuccessorAccepted}
                        selection={{ values: selection }}
                        view={view}
                    />
                </>
            ) : (
                <FooterActions
                    dispatch={dispatch}
                    dispatchTaskAction={taskActionDispatcher}
                    draft={draft}
                    onDraftAccepted={onDraftAccepted}
                    onDraftRejected={onDraftRejected}
                    onSuccessorAccepted={onSuccessorAccepted}
                    view={view}
                />
            )}
        </section>
    )
}
