import type { TaskHandoffSource } from "@shared/ExtensionMessage"
import { useCallback, useEffect, useState } from "react"
import { webviewState } from "@/config/platform.config"
import {
    type InteractionDraft,
    isPendingSuccessorDraftTransfer,
    type PendingSuccessorDraftTransfer,
    resolveSuccessorDraft,
} from "@/task-interaction/types"

const SUCCESSOR_DRAFT_KEY = "successorDraft"

function readRetained(): PendingSuccessorDraftTransfer | undefined {
    const kept = webviewState.get()[SUCCESSOR_DRAFT_KEY]
    return isPendingSuccessorDraftTransfer(kept) ? kept : undefined
}

function writeRetained(transfer: PendingSuccessorDraftTransfer | undefined): void {
    webviewState.patch({ [SUCCESSOR_DRAFT_KEY]: transfer })
}

/**
 * Carry the unsent draft of an approved New Task over to its successor's composer.
 *
 * The draft is retained until a settled surface decides its fate (see
 * `resolveSuccessorDraft`). It is written to the webview state VS Code hands
 * back, because the source is torn down while the successor starts and a
 * reload in that window would otherwise lose it; the composer's own keep-alive
 * cannot hold it, since it only ever restores a draft to the task it was
 * written in. Like the composer's other restores, it comes back only into a
 * still-blank composer: whatever is already there wins.
 *
 * Only a reload of this webview is covered. The successor's `handoffSource`
 * is held in memory by the extension host, so after the host restarts the
 * successor settles without it and the draft is dropped (BUGFIX-165).
 *
 * @returns The callback that retains a transfer when a New Task approval is accepted.
 */
export function useSuccessorDraftTransfer({
    taskId,
    projectedTaskId,
    handoffSource,
    composerBlank,
    restoreDraft,
}: {
    taskId?: string
    projectedTaskId?: string
    handoffSource?: TaskHandoffSource
    composerBlank: boolean
    restoreDraft: (draft: InteractionDraft) => void
}): (transfer: PendingSuccessorDraftTransfer) => void {
    const [pending, setPending] = useState(readRetained)

    const retain = useCallback((transfer: PendingSuccessorDraftTransfer): void => {
        writeRetained(transfer)
        setPending(transfer)
    }, [])

    useEffect(() => {
        if (!pending) return
        const disposition = resolveSuccessorDraft(pending, { taskId, projectedTaskId, handoffSource })
        if (disposition === "wait") return
        if (disposition === "restore" && composerBlank) restoreDraft(pending.draft)
        writeRetained(undefined)
        setPending(undefined)
    }, [composerBlank, handoffSource, pending, projectedTaskId, restoreDraft, taskId])

    return retain
}
