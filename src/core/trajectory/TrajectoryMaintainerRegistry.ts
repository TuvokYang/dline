import type { CommittedUiMessages } from "./CommittedUiMessages"
import type { TrajectoryMaintainer, TrajectoryWriteAccess } from "./TrajectoryMaintainer"

/** Write access whose answer can change, for example when the task lock is lost or regained. */
export interface TrajectoryAccess extends TrajectoryWriteAccess {
    onDidChange(listener: () => void): () => void
}

export interface MaintainedTask {
    readonly maintainer: TrajectoryMaintainer
    readonly messages: CommittedUiMessages
}

/** One subscription's hold on a task's maintainer. */
export interface TrajectoryMaintainerLease {
    readonly maintainer: TrajectoryMaintainer
    release(): Promise<void>
}

/** A commit burst is folded once it pauses, but never later than the cap. */
const DEBOUNCE_TRAILING_MS = 100
const DEBOUNCE_MAX_MS = 1_000

interface Entry {
    readonly task: Promise<MaintainedTask>
    readonly accesses: Map<symbol, TrajectoryAccess>
    readonly cleanups: (() => void)[]
    timer: ReturnType<typeof setTimeout> | undefined
    firstPendingAt: number | undefined
    closed: boolean
}

/**
 * One maintainer per task instance per process, held while at least one
 * trajectory subscription needs it.
 *
 * It folds after every committed row transaction and after every change of
 * write access, debounced; the last release stops the maintainer after its
 * current slice and closes both databases.
 */
export class TrajectoryMaintainerRegistry {
    private readonly entries = new Map<string, Entry>()
    /**
     * Closes still in flight, by key. The retiring maintainer still owns the
     * trajectory.db writer claim until its close settles, so a new maintainer
     * for the same key must not open the database before then.
     */
    private readonly retiring = new Map<string, Promise<void>>()

    async acquire(
        key: string,
        access: TrajectoryAccess,
        create: () => Promise<MaintainedTask>,
    ): Promise<TrajectoryMaintainerLease> {
        let entry = this.entries.get(key)
        while (!entry) {
            const retirement = this.retiring.get(key)
            if (!retirement) break
            await retirement.catch(() => undefined)
            entry = this.entries.get(key)
        }
        if (!entry) {
            const created: Entry = {
                task: create(),
                accesses: new Map(),
                cleanups: [],
                timer: undefined,
                firstPendingAt: undefined,
                closed: false,
            }
            entry = created
            this.entries.set(key, created)
            try {
                const task = await created.task
                created.cleanups.push(task.messages.signals.subscribe(() => this.schedule(created)))
            } catch (error) {
                this.entries.delete(key)
                throw error
            }
        }
        const current = entry
        const { maintainer } = await current.task
        // The last other lease may have been released while this one waited for
        // the shared maintainer; a closed entry is never handed out.
        if (current.closed) return this.acquire(key, access, create)
        const id = Symbol("trajectory-lease")
        current.accesses.set(id, access)
        const stopWatching = access.onDidChange(() => this.schedule(current))
        void this.run(current)
        let released = false
        return {
            maintainer,
            release: async () => {
                if (released) return
                released = true
                stopWatching()
                current.accesses.delete(id)
                if (current.accesses.size === 0) await this.close(key, current)
            },
        }
    }

    private writeAccess(entry: Entry): TrajectoryWriteAccess {
        return { writable: () => !entry.closed && [...entry.accesses.values()].some((access) => access.writable()) }
    }

    private schedule(entry: Entry): void {
        if (entry.closed) return
        const now = Date.now()
        entry.firstPendingAt ??= now
        if (entry.timer) clearTimeout(entry.timer)
        const delay = Math.max(0, Math.min(DEBOUNCE_TRAILING_MS, entry.firstPendingAt + DEBOUNCE_MAX_MS - now))
        entry.timer = setTimeout(() => {
            entry.timer = undefined
            entry.firstPendingAt = undefined
            void this.run(entry)
        }, delay)
    }

    private async run(entry: Entry): Promise<void> {
        if (entry.closed) return
        const { maintainer } = await entry.task
        await maintainer.catchUp(this.writeAccess(entry))
    }

    private close(key: string, entry: Entry): Promise<void> {
        entry.closed = true
        if (this.entries.get(key) === entry) this.entries.delete(key)
        if (entry.timer) clearTimeout(entry.timer)
        for (const cleanup of entry.cleanups.splice(0)) cleanup()
        const retirement = (async () => {
            const task = await entry.task
            await task.maintainer.close()
            await task.messages.close().catch(() => undefined)
        })()
        this.retiring.set(key, retirement)
        const forget = () => {
            if (this.retiring.get(key) === retirement) this.retiring.delete(key)
        }
        retirement.then(forget, forget)
        return retirement
    }
}
