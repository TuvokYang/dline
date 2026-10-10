import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { MutateInputQueueRequest } from "@shared/proto/dline/task"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"
import type { InputQueuePanelEntry } from "./InputQueuePanel"

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

export interface InputQueueController {
    entries: readonly InputQueuePanelEntry[]
    /** Resolves false when the task refused the draft or could not be reached. */
    enqueue: (draft: InputQueueDraft) => Promise<boolean>
    toggleMode: (id: string) => void
    beginEdit: (id: string) => void
    /** Resolves false when the task refused the edit or could not be reached. */
    commitEdit: (id: string, draft: InputQueueDraft) => Promise<boolean>
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

    const mutate = useCallback(
        (operation: Partial<MutateInputQueueRequest>): Promise<boolean> => {
            if (!taskId) {
                return Promise.resolve(false)
            }
            return TaskServiceClient.mutateInputQueue(MutateInputQueueRequest.create({ taskId, ...operation }))
                .then((response) => {
                    if (response.accepted) {
                        return true
                    }
                    // A refused change is not an error on the wire, so it would
                    // otherwise pass silently. The queue itself stays correct:
                    // the task rolls back and republishes, and this projection
                    // follows. What must not happen is the user believing a
                    // change landed when the reason is only visible here.
                    console.warn(`Input queue change refused: ${response.result || "unknown"}`)
                    return false
                })
                .catch((error) => {
                    console.error("Failed to update the input queue:", error)
                    return false
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

    return {
        entries,
        enqueue: useCallback((draft: InputQueueDraft) => mutate({ enqueue: { draft: toWireDraft(draft) } }), [mutate]),
        toggleMode: useCallback((entryId: string) => void mutate({ toggleMode: { entryId } }), [mutate]),
        beginEdit: useCallback((entryId: string) => void mutate({ beginEdit: { entryId } }), [mutate]),
        commitEdit: useCallback(
            (entryId: string, draft: InputQueueDraft) => mutate({ commitEdit: { entryId, draft: toWireDraft(draft) } }),
            [mutate],
        ),
        cancelEdit: useCallback((entryId: string) => void mutate({ cancelEdit: { entryId } }), [mutate]),
        remove: useCallback((entryId: string) => void mutate({ remove: { entryId } }), [mutate]),
        reorder: useCallback(
            (entryId: string, targetIndex: number) => void mutate({ reorder: { entryId, targetIndex } }),
            [mutate],
        ),
    }
}
