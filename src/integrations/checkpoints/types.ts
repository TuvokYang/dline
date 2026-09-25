/**
 * Returns a task's provider conversation to an earlier journal position.
 *
 * A chat restore from a Task-runtime summary card has to undo the summary in
 * the conversation the provider is sent, which lives in the task journal
 * rather than in the chat or API history files the checkpoint manager owns.
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
}

/**
 * Common interface for checkpoint managers
 * Allows single-root and multi-root managers to be used interchangeably
 */
export interface ICheckpointManager {
	saveCheckpoint(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void>

	restoreCheckpoint(messageTs: number, restoreType: any, offset?: number, editedText?: string): Promise<any>

	doesLatestTaskCompletionHaveNewChanges(): Promise<boolean>

	commit(): Promise<string | undefined>

	presentMultifileDiff?(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void>

	// Optional method for multi-root specific initialization
	initialize?(): Promise<void>

	// Optional method for checking and initializing checkpoint tracker
	checkpointTrackerCheckAndInit?(): Promise<any>
}
