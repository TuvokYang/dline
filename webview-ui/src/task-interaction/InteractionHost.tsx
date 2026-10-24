import type { TaskViewAction, TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { parseReportBugDraft, reportBugDraftSelection } from "@shared/report-bug"
import { type ReactNode, useState } from "react"
import { isCardHostedApproval } from "./approval-card"
import { FooterActions } from "./FooterActions"
import {
    APPROVAL_PRESENTATION_KINDS,
    isPresentationKind,
    PresentationFrame,
    type PresentationKind,
    renderPresentation,
} from "./renderer-registry"
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
    /**
     * Draws the pending call of a card-hosted approval as the card the chat draws once
     * the approval is answered. Without it the footer draws its compact summary.
     */
    renderApprovalCard?: (message: UiMessage) => ReactNode
}

const EMPTY_DRAFT: InteractionDraft = { text: "", images: [], files: [], activeQuote: null }

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
    renderApprovalCard,
}: InteractionHostProps) {
    const interaction = view.activeInteraction
    const anchor = findActiveInteractionAnchor(messages, view)
    const presentationKind = interaction?.presentationKind
    const initialSelection = (() => {
        if (presentationKind !== "report_bug") return []
        const report = parseReportBugDraft(anchor?.text ?? interaction?.presentationText)
        return report ? reportBugDraftSelection(report) : []
    })()
    const [selectionState, setSelectionState] = useState<{ interactionId?: string; values: string[] }>({ values: [] })
    const selection = selectionState.interactionId === interaction?.interactionId ? selectionState.values : initialSelection
    const setSelection = (values: string[]) => setSelectionState({ interactionId: interaction?.interactionId, values })
    const supported = presentationKind ? isPresentationKind(presentationKind) : false
    const renderAnchorPresentation = (kind: PresentationKind, message: UiMessage) =>
        renderApprovalCard && isCardHostedApproval(kind) ? (
            <PresentationFrame kind={kind}>{renderApprovalCard(message)}</PresentationFrame>
        ) : (
            renderPresentation(kind, { message, selection, onSelectionChange: setSelection })
        )
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
                    {showTimeline || APPROVAL_PRESENTATION_KINDS.has(presentationKind)
                        ? renderAnchorPresentation(presentationKind, anchor)
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
