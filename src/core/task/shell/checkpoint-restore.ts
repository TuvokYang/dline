import { hydrate } from "../kernel/hydrate"
import type { Diagnostic } from "../kernel/types"
import type { DurableTaskSnapshot, JournalWatermark } from "../stores/contracts"

export type CheckpointRestoreMode = "combined" | "chat_only" | "workspace_only"

export interface ResolvedCheckpoint {
    readonly snapshot: DurableTaskSnapshot
    readonly boundary: JournalWatermark
    readonly workspaceRef?: string
}

export type WorkspaceRestoreResult = { readonly ok: true } | { readonly ok: false; readonly diagnostic: Diagnostic }

/**
 * Where the restored chat row says the conversation stood.
 *
 * A checkpoint stores the position its row was written at, which is not always
 * the position the row's chat returns to: the row's own input and the tool
 * results answering calls made before it are recorded after that position.
 * Resolving this before anything is mutated keeps the conversation, the journal
 * rewind and the saved snapshot on one boundary.
 */
export interface CheckpointRestoreRow {
    /** The conversation length at the row; the fallback for rows written before rows recorded a position. */
    readonly keep: number
    /** The journal position the row recorded. */
    readonly seq?: number
    /** Whether the input the row shows stays: an edit replaces it, an ordinary restore keeps it. */
    readonly keepInput: boolean
}

export interface CheckpointRestorePorts {
    stopAndFence(): Promise<void>
    resolve(checkpointRef: string): Promise<ResolvedCheckpoint>
    restoreWorkspace(workspaceRef: string): Promise<WorkspaceRestoreResult>
    /**
     * The position the row's chat returns to, given the position its checkpoint
     * stored. Called before anything is touched, so a position that cannot be
     * rewound to refuses the restore with no side effect.
     */
    resolveRowBoundary?(boundary: JournalWatermark, row: CheckpointRestoreRow): Promise<JournalWatermark>
    applyConversationBoundary(boundary: JournalWatermark): Promise<JournalWatermark>
    save(snapshot: DurableTaskSnapshot): Promise<void>
}

export interface CheckpointRestoreInput {
    readonly taskId: string
    readonly checkpointRef: string
    readonly mode: CheckpointRestoreMode
    /** Where the restored row says the conversation stood; absent, the checkpoint's own boundary is used. */
    readonly row?: CheckpointRestoreRow
}

export type CheckpointRestoreResult =
    | {
          readonly kind: "restored"
          readonly snapshot?: DurableTaskSnapshot
          readonly diagnostics: readonly Diagnostic[]
      }
    | { readonly kind: "rejected"; readonly diagnostics: readonly Diagnostic[] }

function rejected(code: string, message: string): CheckpointRestoreResult {
    return { kind: "rejected", diagnostics: [{ code, message }] }
}

export async function restoreCheckpoint(
    input: CheckpointRestoreInput,
    ports: CheckpointRestorePorts,
): Promise<CheckpointRestoreResult> {
    const checkpoint = await ports.resolve(input.checkpointRef)
    if (input.mode === "workspace_only") {
        if (!checkpoint.workspaceRef) return rejected("workspace_checkpoint_missing", "Checkpoint has no workspace reference")
        const workspace = await ports.restoreWorkspace(checkpoint.workspaceRef)
        return workspace.ok ? { kind: "restored", diagnostics: [] } : { kind: "rejected", diagnostics: [workspace.diagnostic] }
    }
    // One boundary does the whole restore: where the row's chat returns to is
    // resolved first, then used to hydrate, to rewind the conversation and to
    // save. Rewinding to the checkpoint's stored position instead would leave the
    // row's own input duplicated beside the text an edit submits again.
    let boundary = checkpoint.boundary
    if (input.row !== undefined) {
        if (!ports.resolveRowBoundary) {
            return rejected("checkpoint_row_boundary_unavailable", "Checkpoint row boundary resolver is unavailable")
        }
        boundary = await ports.resolveRowBoundary(checkpoint.boundary, input.row)
    }
    const hydrated = hydrate({
        taskId: input.taskId,
        snapshot: checkpoint.snapshot.state,
        // The snapshot has to describe the conversation the restore leaves, which
        // is the effective boundary, not the position its bundle was stored at.
        journalTail: boundary,
        openReason: "checkpoint_restore",
    })
    // Restoring must not replace the task's state with one rebuilt from nothing:
    // a checkpoint whose snapshot cannot be continued is refused before anything
    // is touched, and the task keeps what it had.
    if (hydrated.rebuilt) return { kind: "rejected", diagnostics: hydrated.diagnostics }
    if (input.mode === "combined" && !checkpoint.workspaceRef) {
        return rejected("workspace_checkpoint_missing", "Checkpoint has no workspace reference")
    }

    await ports.stopAndFence()
    const diagnostics: Diagnostic[] = [...hydrated.diagnostics]
    if (input.mode === "combined") {
        const workspace = await ports.restoreWorkspace(checkpoint.workspaceRef!)
        if (!workspace.ok) diagnostics.push(workspace.diagnostic)
    }

    await ports.applyConversationBoundary(boundary)
    const snapshot: DurableTaskSnapshot = {
        // The row's own input and the tool results answering calls made before it
        // extend the stored position, so the state has observed the effective
        // boundary rather than the one the bundle was captured at.
        state: { ...hydrated.state, journalWatermark: boundary },
        // The stored outbox belongs to the state at capture time. Rewind deliberately
        // removes that turn and its blocks, so replaying those commands (for example
        // its tool.run) can only target discarded work and starve the restored Resume.
        // The restored state's planned dialog is enough: reopen hydrate derives its
        // command exactly once, whereas persisting it here duplicates dialog.prepare.
        outbox: [],
    }
    await ports.save(snapshot)
    return { kind: "restored", snapshot, diagnostics }
}
