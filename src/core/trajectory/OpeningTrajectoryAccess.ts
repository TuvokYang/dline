import { Logger } from "@/shared/services/Logger"
import type { TrajectoryAccess } from "./TrajectoryMaintainerRegistry"
import type { TrajectoryAdmission } from "./TrajectorySource"

/** How often an ownerless history display re-reads the task lock while something listens to its access. */
export const OWNERLESS_LOCK_POLL_MS = 2_000

export interface OpeningTrajectoryAccessOptions {
    readonly taskId: string
    /** Whether the opening this access was made for is still the controller's current one. */
    readonly isCurrent: () => boolean
    readonly admission: TrajectoryAdmission
    /**
     * Only for a history display: whether no instance holds the task lock. A
     * live opening writes only while it holds the lock itself.
     */
    readonly inspectOwnerless?: () => Promise<boolean>
    readonly pollMs?: number
}

/** The trajectory write access of one task opening. */
export interface OpeningTrajectoryAccess extends TrajectoryAccess {
    /** Re-read the lock state `writable()` answers from, so the next answer is current. */
    refresh(): Promise<void>
}

/**
 * Write access of one task opening: it must still be current, and either hold
 * the task lock (the admission) or, for a history display, find the task
 * ownerless.
 *
 * An ownerless answer is cached and re-read every `pollMs` while anything
 * listens, so a lock another window takes is noticed within one round. Every
 * round notifies listeners, including when nothing changed: another window
 * may have committed rows while it briefly held the lock, and a notification
 * makes the maintainer compare the commit head again.
 */
export function openingTrajectoryAccess(options: OpeningTrajectoryAccessOptions): OpeningTrajectoryAccess {
    return new OpeningAccess(options)
}

class OpeningAccess implements OpeningTrajectoryAccess {
    private ownerless = false
    private readonly listeners = new Set<() => void>()
    private stopAdmission: (() => void) | undefined
    private timer: ReturnType<typeof setInterval> | undefined
    private polling = false

    constructor(private readonly options: OpeningTrajectoryAccessOptions) {}

    writable(): boolean {
        if (!this.options.isCurrent()) return false
        return this.options.admission.admits(this.options.taskId) || this.ownerless
    }

    async refresh(): Promise<void> {
        const inspect = this.options.inspectOwnerless
        if (!inspect) return
        // A lock that cannot be read grants nothing.
        this.ownerless = await inspect().catch(() => false)
    }

    onDidChange(listener: () => void): () => void {
        this.listeners.add(listener)
        if (this.listeners.size === 1) this.start()
        return () => {
            if (!this.listeners.delete(listener)) return
            if (this.listeners.size === 0) this.stop()
        }
    }

    private start(): void {
        this.stopAdmission = this.options.admission.onDidChange(() => this.emit())
        if (!this.options.inspectOwnerless) return
        this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? OWNERLESS_LOCK_POLL_MS)
    }

    private stop(): void {
        this.stopAdmission?.()
        this.stopAdmission = undefined
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
    }

    private async poll(): Promise<void> {
        if (this.polling) return
        this.polling = true
        try {
            await this.refresh()
        } finally {
            this.polling = false
        }
        if (this.timer) this.emit()
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch (error) {
                Logger.warn(
                    `[trajectory] TrajectoryAccessListenerFailed: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
        }
    }
}
