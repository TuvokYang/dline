/**
 * How one compaction run ended, as far as anyone waiting on it cares.
 *
 * `refused` means no run happened - the request was not scheduled - so nobody
 * was told anything failed. `timed_out` means the waiter stopped waiting while
 * the run may still be going.
 */
export type CompactionRunOutcome = "completed" | "failed" | "withdrawn" | "refused" | "timed_out"

/**
 * The way out a failed automatic compaction leaves the user.
 *
 * The round that compaction was clearing room for stopped, and retrying it
 * compacts again against the same provider. Truncating the history instead
 * makes the retried round fit without asking that provider anything, so it is
 * offered only while that stopped round is still waiting on the user.
 */
export interface CompactionRecoveryPort {
	/** Whether the last round stopped on a failed automatic compaction and has not been retried since. */
	truncationOffered(): boolean
	/** Resolves once the run has settled, including its landing. */
	settlement(compactionId: string): Promise<CompactionRunOutcome>
}
