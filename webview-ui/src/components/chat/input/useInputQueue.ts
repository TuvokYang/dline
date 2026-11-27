import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { MutateInputQueueRequest } from "@shared/proto/dline/task"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"
import type { InputQueuePanelEntry, InputQueuePanelMode } from "./InputQueuePanel"

export interface InputQueueDraft {
    text: string
    images: string[]
    files: string[]
    activeQuote?: string
    /** A held pasted candidate must stay held while the entry waits (WS-041 AC-09). */
    semanticInput?: SemanticInputDocument
}

/** The queue wire draft; the structured document travels in its own field. */
function toWireDraft(draft: InputQueueDraft) {
    const { semanticInput, ...plain } = draft
    return semanticInput === undefined ? plain : { ...plain, semanticInput: toProtoSemanticInputDocument(semanticInput) }
}

export interface InputQueueMutationOutcome {
    readonly accepted: boolean
    readonly result?: string
}

export interface InputQueueController {
    entries: readonly InputQueuePanelEntry[]
    /** Adds the draft in the mode it waits in. Resolves false when the task refused it or could not be reached. */
    enqueue: (draft: InputQueueDraft, mode: InputQueuePanelMode) => Promise<boolean>
    /** Adds the draft and preserves the backend refusal code so the composer can explain why a send did not land. */
    enqueueWithOutcome: (draft: InputQueueDraft, mode: InputQueuePanelMode) => Promise<InputQueueMutationOutcome>
    toggleMode: (id: string) => void
    beginEdit: (id: string) => void
    /** Resolves false when the task refused the edit or could not be reached. */
    commitEdit: (id: string, draft: InputQueueDraft) => Promise<boolean>
    /** Commits an edit and preserves the backend refusal code for composer feedback. */
    commitEditWithOutcome: (id: string, draft: InputQueueDraft) => Promise<InputQueueMutationOutcome>
    cancelEdit: (id: string) => void
    remove: (id: string) => void
    reorder: (id: string, targetIndex: number) => void
}

/**
 * Bind the composer to the backend-owned input queue.
 *
 * Every operation is sent to the task and the rendered list comes back through
 * ExtensionState. The Webview deliberately keeps no local copy: the queue is
 * persisted per task, so a second authority here could show entries that were
 * never stored, or hide entries that were.
 */
export function useInputQueue(taskId: string | undefined): InputQueueController {
    const { inputQueue } = useExtensionState()

    const mutateOutcome = useCallback(
        (operation: Partial<MutateInputQueueRequest>): Promise<InputQueueMutationOutcome> => {
            if (!taskId) {
                return Promise.resolve({ accepted: false, result: "missing_task" })
            }
            return TaskServiceClient.mutateInputQueue(MutateInputQueueRequest.create({ taskId, ...operation }))
                .then((response) => {
                    if (response.accepted) {
                        return { accepted: true, result: response.result }
                    }
                    // A refused change is not an error on the wire, so it would
                    // otherwise pass silently. The queue itself stays correct:
                    // the task rolls back and republishes, and this projection
                    // follows. What must not happen is the user believing a
                    // change landed when the reason is only visible here.
                    console.warn(`Input queue change refused: ${response.result || "unknown"}`)
                    return { accepted: false, result: response.result || "unknown" }
                })
                .catch((error) => {
                    console.error("Failed to update the input queue:", error)
                    return { accepted: false, result: "transport_error" }
                })
        },
        [taskId],
    )

    const entries = useMemo<readonly InputQueuePanelEntry[]>(
        () =>
            (inputQueue ?? []).map((entry) => ({
                id: entry.id,
                text: entry.text,
                images: entry.images,
                files: entry.files,
                activeQuote: entry.activeQuote,
                // Kept so an edited entry comes back with its held candidates (WS-041 AC-09).
                ...(entry.semanticInput === undefined ? {} : { semanticInput: entry.semanticInput }),
                mode: entry.mode,
                editing: entry.editing,
            })),
        [inputQueue],
    )

    const enqueueWithOutcome = useCallback(
        (draft: InputQueueDraft, mode: InputQueuePanelMode) =>
            mutateOutcome({ enqueue: { draft: toWireDraft(draft), steering: mode === "steering" } }),
        [mutateOutcome],
    )
    const commitEditWithOutcome = useCallback(
        (entryId: string, draft: InputQueueDraft) => mutateOutcome({ commitEdit: { entryId, draft: toWireDraft(draft) } }),
        [mutateOutcome],
    )

    return {
        entries,
        enqueue: useCallback(
            (draft: InputQueueDraft, mode: InputQueuePanelMode) =>
                enqueueWithOutcome(draft, mode).then((outcome) => outcome.accepted),
            [enqueueWithOutcome],
        ),
        enqueueWithOutcome,
        toggleMode: useCallback((entryId: string) => void mutateOutcome({ toggleMode: { entryId } }), [mutateOutcome]),
        beginEdit: useCallback((entryId: string) => void mutateOutcome({ beginEdit: { entryId } }), [mutateOutcome]),
        commitEdit: useCallback(
            (entryId: string, draft: InputQueueDraft) =>
                commitEditWithOutcome(entryId, draft).then((outcome) => outcome.accepted),
            [commitEditWithOutcome],
        ),
        commitEditWithOutcome,
        cancelEdit: useCallback((entryId: string) => void mutateOutcome({ cancelEdit: { entryId } }), [mutateOutcome]),
        remove: useCallback((entryId: string) => void mutateOutcome({ remove: { entryId } }), [mutateOutcome]),
        reorder: useCallback(
            (entryId: string, targetIndex: number) => void mutateOutcome({ reorder: { entryId, targetIndex } }),
            [mutateOutcome],
        ),
    }
}
