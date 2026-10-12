import type { TransitionDraftProjection } from "@shared/TransitionDraft"
import { useEffect, useRef } from "react"
import type { InteractionDraft } from "../../../../task-interaction/types"

interface TransitionDraftRestoreOptions {
    /** The task this view shows. */
    readonly taskId: string | undefined
    /** The draft the task keeps for a switch whose dialog has not taken it yet. */
    readonly transitionDraft: TransitionDraftProjection | undefined
    /** Whether a Mode or Profile switch is still running; its draft is not the composer's to take back. */
    readonly transitionRunning: boolean
    readonly composerBlank: boolean
    readonly restoreDraft: (draft: InteractionDraft) => void
}

/** Whether a Mode or Profile switch in `phase` is still carrying its draft. */
export function isTransitionRunning(phase: string | undefined): boolean {
    return phase !== undefined && phase !== "idle" && phase !== "failed"
}

/** The kept draft of `taskId`, if the task keeps one. */
function keptDraftOf(taskId: string, draft: TransitionDraftProjection | undefined): TransitionDraftProjection | undefined {
    return draft?.taskId === taskId ? draft : undefined
}

/**
 * Gives the composer back the draft a switch carried when the composer that sent it was lost.
 *
 * Each kept draft is considered once, at the first moment no switch is
 * carrying it: a blank composer gets it back, and a composer holding anything
 * keeps what it holds. The composer that sent the draft still holds it at that
 * moment, so only a composer lost with an earlier view, or one this view opened
 * before the task's state arrived, is given a draft. Nothing is restored once
 * the task dropped the draft because its dialog took a reply.
 */
export function useTransitionDraftRestore(options: TransitionDraftRestoreOptions): void {
    const { taskId, transitionDraft, transitionRunning, composerBlank, restoreDraft } = options
    // Draft ids are unique per recording, so a considered id never needs forgetting.
    const consideredRef = useRef(new Set<string>())

    useEffect(() => {
        const kept = taskId ? keptDraftOf(taskId, transitionDraft) : undefined
        if (!kept || transitionRunning || consideredRef.current.has(kept.draftId)) return
        consideredRef.current.add(kept.draftId)
        if (!composerBlank) return
        restoreDraft({
            text: kept.text,
            images: [...kept.images],
            files: [...kept.files],
            ...(kept.semanticInput ? { semanticInput: kept.semanticInput } : {}),
        })
    }, [composerBlank, restoreDraft, taskId, transitionDraft, transitionRunning])
}
