export interface CompletionCommitPorts {
    publishResult(): Promise<number | undefined>
    saveCheckpoint(completionMessageTs: number | undefined): Promise<void>
    /** Record the workspace-change verdict on the published completion row. */
    markWorkspaceChanges(completionMessageTs: number | undefined): Promise<void>
    captureTelemetry(): void
    /** Observation-only work that follows a finished task, such as its hooks. */
    announce(): Promise<void>
}

export interface CompletionCommit {
    /** The row the result was published to, which the completion dialog takes over. */
    readonly completionMessageTs: number | undefined
    /**
     * Everything the finished task settles after its result is shown.
     *
     * Separate from publishing so the dialog opens at once: a checkpoint waits
     * behind the round's own and a diff walks the workspace, and input queued
     * for the dialog would otherwise sit behind both. Whatever comes after the
     * dialog's answer must still wait for this, so the next round never starts
     * before the checkpoint it diffs against exists.
     */
    readonly settled: Promise<void>
}

/** Publish the completion's result, then settle its side effects without holding the dialog back. */
export async function commitCompletion(ports: CompletionCommitPorts): Promise<CompletionCommit> {
    const completionMessageTs = await ports.publishResult()
    const settled = (async () => {
        await ports.saveCheckpoint(completionMessageTs)
        await ports.markWorkspaceChanges(completionMessageTs)
        ports.captureTelemetry()
        await ports.announce()
    })()
    // Observed now, because the dialog may still be open when it fails; the
    // caller awaits `settled` afterwards and receives the failure there.
    settled.catch(() => undefined)
    return { completionMessageTs, settled }
}
