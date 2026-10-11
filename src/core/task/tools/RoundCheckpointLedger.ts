import type { TaskConfig } from "./types/TaskConfig"

type TaskCallbacks = TaskConfig["callbacks"]

/**
 * Coalesces the restore points a round owes into one.
 *
 * A file edit names what it changed, so it commits its own restore point and a
 * user can step back over each edit. A command, an MCP call, or any other tool
 * whose effects are not tied to named files only records that the round owes a
 * restore point; the round boundary then commits a single one covering all of
 * them, instead of one per call.
 *
 * Every commit, including a file edit's or `attempt_completion`'s own, captures
 * everything already on disk, so it settles whatever the round owed up to that
 * point. Commits run one at a time in call order so a settled debt can never be
 * overtaken by an older snapshot.
 */
export class RoundCheckpointLedger {
    private owed = false
    private tail: Promise<void> = Promise.resolve()

    constructor(private readonly commitCheckpoint: () => Promise<void>) {}

    /** Record that the current round changed the workspace without committing yet. */
    markOwed(): void {
        this.owed = true
    }

    /** Whether a restore point is still owed. */
    get hasOwed(): boolean {
        return this.owed
    }

    /**
     * Commit a restore point now.
     *
     * The debt is cleared before the snapshot is taken: effects recorded after
     * that moment may be missing from it, so they stay owed.
     */
    commit(run: () => Promise<void>): Promise<void> {
        this.owed = false
        return this.enqueue(run)
    }

    /**
     * Commit the restore point the round owes, if any, and wait for every
     * commit already queued.
     */
    settle(): Promise<void> {
        if (!this.owed) return this.tail
        this.owed = false
        return this.enqueue(this.commitCheckpoint)
    }

    /**
     * Route a task's checkpoint callbacks through this ledger.
     *
     * Returns the callbacks unchanged when the surface has no workspace
     * history, so a task without one keeps running the same tools.
     */
    bind(callbacks: TaskCallbacks): TaskCallbacks {
        const save = callbacks.saveCheckpoint
        if (save === undefined) return callbacks
        return {
            ...callbacks,
            saveCheckpoint: (isAttemptCompletionMessage, completionMessageTs) =>
                this.commit(() => save(isAttemptCompletionMessage, completionMessageTs)),
            deferCheckpoint: () => this.markOwed(),
        }
    }

    private enqueue(run: () => Promise<void>): Promise<void> {
        const next = this.tail.then(run, run)
        this.tail = next.catch(() => undefined)
        return next
    }
}
