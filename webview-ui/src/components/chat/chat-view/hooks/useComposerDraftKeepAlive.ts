import { useEffect, useMemo, useRef } from "react"
import { webviewState } from "@/config/platform.config"
import { type InteractionDraft, isInteractionDraft } from "@/task-interaction/types"

const KEPT_DRAFT_KEY = "composerDraft"

/** The unsent draft as last written, and the task it was written in. */
interface KeptDraft {
    readonly taskId?: string
    readonly draft: InteractionDraft
}

function isKeptDraft(value: unknown): value is KeptDraft {
    if (!value || typeof value !== "object") return false
    const { taskId, draft } = value as { taskId?: unknown; draft?: unknown }
    return (taskId === undefined || typeof taskId === "string") && isInteractionDraft(draft)
}

function isEmptyDraft(draft: Pick<InteractionDraft, "text" | "images" | "files" | "activeQuote">): boolean {
    return !draft.text && draft.images.length === 0 && draft.files.length === 0 && !draft.activeQuote
}

/**
 * Keep the unsent composer draft across a reload of this webview.
 *
 * Hiding the view keeps the document alive, but a reload starts a new one, so
 * the draft is written to the webview state VS Code hands back. It comes back
 * once, into a still-blank composer, and only on the task it was written in:
 * a draft never moves to another task.
 */
export function useComposerDraftKeepAlive({
    taskId,
    draft,
    composerBlank,
    restoreDraft,
}: {
    taskId?: string
    draft: InteractionDraft
    composerBlank: boolean
    restoreDraft: (draft: InteractionDraft) => void
}): void {
    // Read before the first write, which would otherwise replace it with the empty new composer.
    const pendingRef = useRef<KeptDraft | undefined>(undefined)
    const readRef = useRef(false)
    if (!readRef.current) {
        readRef.current = true
        const kept = webviewState.get()[KEPT_DRAFT_KEY]
        pendingRef.current = isKeptDraft(kept) ? kept : undefined
    }

    useEffect(() => {
        const pending = pendingRef.current
        // A reload shows the welcome view before the host projects the task again.
        if (!pending || pending.taskId !== taskId) return
        pendingRef.current = undefined
        if (composerBlank) restoreDraft(pending.draft)
    }, [composerBlank, restoreDraft, taskId])

    // Serialized only when a field changes, and written only when the content
    // does: a streaming task renders far more often than the user edits.
    const { text, images, files, activeQuote, semanticInput } = draft
    const serialized = useMemo(() => {
        if (isEmptyDraft({ text, images, files, activeQuote })) return ""
        const kept: KeptDraft = {
            taskId,
            draft: { text, images, files, activeQuote, ...(semanticInput ? { semanticInput } : {}) },
        }
        return JSON.stringify(kept)
    }, [activeQuote, files, images, semanticInput, taskId, text])
    const writtenRef = useRef<string | undefined>(undefined)
    useEffect(() => {
        if (serialized === writtenRef.current) return
        // Until the kept draft is back, an empty composer must not erase it.
        if (!serialized && pendingRef.current) return
        writtenRef.current = serialized
        webviewState.patch({ [KEPT_DRAFT_KEY]: serialized ? (JSON.parse(serialized) as KeptDraft) : undefined })
    }, [serialized])
}
