export interface SessionResourceReleasePort {
    release(): Promise<void>
}

/** Holds acquired resources until composition transfers ownership to the session. */
export class SessionResourceScope implements SessionResourceReleasePort {
    private readonly resources: Array<{ readonly resource: SessionResourceReleasePort; released: boolean }>
    private releasePromise: Promise<void> | undefined
    private closing = false

    constructor(resources: readonly SessionResourceReleasePort[] = []) {
        this.resources = resources.map((resource) => ({ resource, released: false }))
    }

    add(resource: SessionResourceReleasePort): void {
        if (this.closing) throw new Error("Task session resource scope is already closing")
        this.resources.push({ resource, released: false })
    }

    /** Retry only owners whose earlier release failed; successful owners stay released. */
    release(): Promise<void> {
        if (this.releasePromise) return this.releasePromise
        this.closing = true
        const attempt = this.releasePending()
        this.releasePromise = attempt
        void attempt.catch(() => {
            if (this.releasePromise === attempt) this.releasePromise = undefined
        })
        return attempt
    }

    private async releasePending(): Promise<void> {
        const failures: unknown[] = []
        for (const entry of [...this.resources].reverse()) {
            if (entry.released) continue
            try {
                await entry.resource.release()
                entry.released = true
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Failed to release task session resources")
    }
}
