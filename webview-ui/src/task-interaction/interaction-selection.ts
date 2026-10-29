import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { parseReportBugDraft, reportBugDraftSelection } from "@shared/report-bug"
import { createContext, useContext, useState } from "react"

/**
 * The values the active interaction submits with a selection action.
 *
 * One owner holds them so the row that edits them in the chat and the footer
 * action that submits them read and write the same state.
 */
export interface InteractionSelection {
    /** The ask row that edits these values, when the message window holds it. */
    readonly anchor?: UiMessage
    readonly values: string[]
    readonly onChange: (values: string[]) => void
}

/** The values an interaction starts from before the user edits anything. */
function initialValues(view: TaskViewState | undefined, anchor: UiMessage | undefined): string[] {
    const interaction = view?.activeInteraction
    if (interaction?.presentationKind !== "report_bug") return []
    const report = parseReportBugDraft(anchor?.text ?? interaction.presentationText)
    return report ? reportBugDraftSelection(report) : []
}

/** Hold the active interaction's selection; a new interaction starts again from its own initial values. */
export function useInteractionSelection(view: TaskViewState | undefined, anchor: UiMessage | undefined): InteractionSelection {
    const interactionId = view?.activeInteraction?.interactionId
    const [edited, setEdited] = useState<{ interactionId?: string; values: string[] }>({ values: [] })
    const values =
        edited.interactionId !== undefined && edited.interactionId === interactionId ? edited.values : initialValues(view, anchor)
    return { anchor, values, onChange: (next) => setEdited({ interactionId, values: next }) }
}

const InteractionSelectionContext = createContext<InteractionSelection | undefined>(undefined)

/** Shares the active interaction's selection with the chat rows that edit it. */
export const InteractionSelectionProvider = InteractionSelectionContext.Provider

/** The shared selection when `message` is the row the active interaction edits; otherwise undefined. */
export function useAnchorSelection(message: UiMessage): InteractionSelection | undefined {
    const selection = useContext(InteractionSelectionContext)
    const anchor = selection?.anchor
    return anchor && anchor.ts === message.ts && anchor.interactionId === message.interactionId ? selection : undefined
}
