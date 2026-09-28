import type { CheckpointReferenceSet } from "@shared/checkpoints"
import type { CheckpointChangedFile } from "./CheckpointTracker"

/**
 * Common interface for checkpoint managers
 * Allows single-root and multi-root managers to be used interchangeably
 */
export interface ICheckpointManager {
	saveCheckpoint(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void>

	restoreCheckpoint(messageTs: number, restoreType: any, offset?: number, editedText?: string): Promise<any>

	doesLatestTaskCompletionHaveNewChanges(): Promise<boolean>

	getTaskChangesForCheckpoint(messageTs: number): Promise<CheckpointChangedFile[]>

	commit(): Promise<CheckpointReferenceSet | undefined>

	presentMultifileDiff?(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void>

	// Optional method for multi-root specific initialization
	initialize?(): Promise<void>

	// Optional method for checking and initializing checkpoint tracker
	checkpointTrackerCheckAndInit?(): Promise<any>
}
