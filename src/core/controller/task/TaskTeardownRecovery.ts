/** One detached Task drain that may be retried after a transient storage failure. */
interface PendingTaskTeardown {
    readonly attempt: () => Promise<void>
    inFlight?: Promise<void>
}

/**
 * Serializes detached Task cleanup without turning one failed write into a permanent error replay.
 *
 * A scheduled drain remains the admission barrier until it succeeds. A later lifecycle request
 * retries the same drain, so stores and locks still close before a replacement writer is admitted.
 */
export class TaskTeardownRecovery {
    private pending: PendingTaskTeardown | undefined

    schedule(attempt: () => Promise<void>): Promise<void> {
        const previous = this.pending
        const entry: PendingTaskTeardown = {
            attempt: async () => {
                if (previous) await this.run(previous)
                await attempt()
            },
        }
        this.pending = entry
        return this.run(entry)
    }

    async recover(): Promise<void> {
        const entry = this.pending
        if (!entry) return
        const currentAttempt = entry.inFlight
        if (currentAttempt) {
            try {
                await currentAttempt
                return
            } catch {
                // This lifecycle request is a new recovery attempt. Retry after
                // the background drain settles instead of replaying its error.
            }
            if (this.pending !== entry) return
        }
        await this.run(entry)
    }

    get hasPending(): boolean {
        return this.pending !== undefined
    }

    private run(entry: PendingTaskTeardown): Promise<void> {
        if (entry.inFlight) return entry.inFlight
        const inFlight = entry
            .attempt()
            .then(() => {
                if (this.pending === entry) this.pending = undefined
            })
            .finally(() => {
                if (entry.inFlight === inFlight) entry.inFlight = undefined
            })
        entry.inFlight = inFlight
        return inFlight
    }
}
