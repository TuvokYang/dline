import type { CheckpointRoundReason } from "@core/task/checkpoints/CheckpointGate"
import type { CheckpointRestoreMode, CheckpointRestoreResult, WorkspaceRestoreResult } from "@core/task/shell/checkpoint-restore"
import type { CheckpointReferenceSet } from "@shared/checkpoints"
import type { CheckpointSource } from "@shared/ExtensionMessage"
import type { CheckpointChangedFile } from "./CheckpointTracker"

/**
 * Canonical task-state checkpoint boundary consumed by the legacy presentation/file adapter.
 */
export interface CanonicalCheckpointPort {
    /**
     * Store the chat side of a checkpoint row.
     *
     * `boundary` is the conversation position the row recorded; the task state
     * stored with it is the one current at capture, not a lagging snapshot.
     * `anchorTs` names the round row a pre-edit row restores its chat to: that
     * row's captured state and boundary are reused with this row's files.
     */
    capture(input: {
        readonly messageTs: number
        readonly workspaceRef?: string
        readonly boundary?: { readonly seq: number }
        readonly anchorTs?: number
    }): Promise<void>
    /** Whether anything other than a checkpoint marker was journaled after `seq`. */
    advancedSince?(seq: number): Promise<boolean>
    restore(input: {
        readonly messageTs: number
        readonly mode: CheckpointRestoreMode
        /**
         * Where the conversation stood before the row, when the row recorded it
         * instead of capturing a checkpoint (a compaction card).
         */
        readonly journalTarget?: { readonly seq: number }
        /**
         * Used when no checkpoint was captured for `messageTs`: the row's own
         * conversation position and files. A checkpoint row stays restorable when
         * its capture failed.
         */
        readonly fallback?: { readonly journalTarget: { readonly seq: number }; readonly workspaceRef?: string }
        readonly restoreWorkspace: (workspaceRef: string) => Promise<WorkspaceRestoreResult>
    }): Promise<CheckpointRestoreResult>
}

/**
 * Returns a task's provider conversation to an earlier journal position.
 *
 * A chat restore has to undo what was said after the restored row in the
 * conversation the provider is sent, which lives in the task journal rather
 * than in the chat or API history files the checkpoint manager owns.
 * Declared here, by the consumer, so the manager stays independent of how a
 * task stores its conversation; an assembly without a journal leaves it out.
 */
export interface ConversationRewindPort {
    /**
     * Rewind to `target`. Idempotent per `operationId`, so a restore retried
     * after a crash replays the same record instead of adding a second one.
     * Rejects without writing when `target` cannot be rewound to.
     */
    rewindTo(input: { readonly operationId: string; readonly target: { readonly seq: number } }): Promise<void>
    /** Whether the journal holds the conversation; a task that predates it keeps its legacy history. */
    holdsConversation(): boolean
    /**
     * Return the conversation to where it stood when a chat row was written,
     * keeping the tool results that answer calls made before it.
     *
     * `seq` is the position the row recorded; `keep`, its conversation length,
     * is the fallback for rows written before rows recorded a position.
     * `keepInput` keeps the user input the row itself shows.
     */
    rewindToRow(input: {
        readonly operationId: string
        readonly row: { readonly keep: number; readonly seq?: number; readonly keepInput?: boolean }
    }): Promise<void>
}

/**
 * Task checkpoint owner contract. One implementation serves single- and
 * multi-root workspaces; multi-root file operations go through its root coordinator.
 */
export interface ICheckpointManager {
    saveCheckpoint(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void>

    restoreCheckpoint(messageTs: number, restoreType: any, offset?: number, editedText?: string): Promise<any>

    doesLatestTaskCompletionHaveNewChanges(): Promise<boolean>

    getTaskChangesForCheckpoint(messageTs: number): Promise<CheckpointChangedFile[]>

    commit(): Promise<CheckpointReferenceSet | undefined>

    /**
     * Before a provider request or compaction: add a checkpoint row unless the
     * latest one still covers the conversation and the files. Never rejects;
     * a part that fails is logged and left out.
     */
    ensureRoundCheckpoint?(
        reason: CheckpointRoundReason,
        sourceOrSignal?: CheckpointSource | AbortSignal,
        signal?: AbortSignal,
    ): Promise<void>

    /** Enter a bounded mutation ordered between the preceding and following round checkpoints. */
    beginWorkspaceMutation?(): Promise<() => void>

    /** Start recursive workspace observation after the first provider request has reached the wire. */
    startWorkspaceWatcher?(): void

    /** Stop creating checkpoints and wait for the one in progress; called before the task's stores close. */
    dispose?(): Promise<void>

    presentMultifileDiff?(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void>

    // Optional method for checking and initializing checkpoint tracker
    checkpointTrackerCheckAndInit?(): Promise<any>
}
