export type ContextTransitionKind = "mode" | "profile"

/** Stable identity for one task-local context transition. */
export interface ContextTransitionOwner {
    kind: ContextTransitionKind
    operationId: string
    taskId: string
}

/**
 * Serialize Profile and Mode transitions across preflight, confirmation,
 * compaction, and final adoption without coupling their coordinators.
 */
export class ContextTransitionLease {
    private active: ContextTransitionOwner | undefined

    /** Acquire the lease only when no transition currently owns it. */
    acquire(owner: ContextTransitionOwner): boolean {
        if (this.active) return false
        this.active = { ...owner }
        return true
    }

    /** Return a detached snapshot of the current owner. */
    getActive(): ContextTransitionOwner | undefined {
        return this.active ? { ...this.active } : undefined
    }

    /** Return whether an operation still owns the lease. */
    owns(operationId: string): boolean {
        return this.active?.operationId === operationId
    }

    /** Release only the matching operation so stale cleanup cannot clear a newer owner. */
    release(operationId: string): void {
        if (this.active?.operationId === operationId) {
            this.active = undefined
        }
    }
}
