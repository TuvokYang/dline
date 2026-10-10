/**
 * Per-task running counts used to emit "so far in this task" histograms.
 *
 * These counts are shared: turns and errors are observed by the task recorder
 * while tool calls are observed by the tool recorder, yet all three reset
 * together when a task starts, restarts, or ends. Giving them one owner is what
 * keeps a reset from being applied by one recorder and missed by another.
 *
 * Entries are cleared at task boundaries, but a task can be abandoned without
 * ever reaching one — the user closes the window mid-run, or starts a new task
 * without completing the old one. A capacity bound turns that from an unbounded
 * leak into a fixed cost, at the price of under-counting a task that has been
 * dormant for longer than `MAX_TRACKED_TASKS` other tasks.
 */

/**
 * How many tasks keep running counts.
 *
 * Large enough that a normal session never evicts a task the user is still
 * working on, small enough that the worst case stays negligible.
 */
const MAX_TRACKED_TASKS = 128

export class TaskAggregates {
    private readonly turns = new Map<string, number>()
    private readonly toolCalls = new Map<string, number>()
    private readonly errors = new Map<string, number>()

    nextTurn(ulid: string): number {
        return this.increment(this.turns, ulid)
    }

    nextToolCall(ulid: string): number {
        return this.increment(this.toolCalls, ulid)
    }

    nextError(ulid: string): number {
        return this.increment(this.errors, ulid)
    }

    /** Forget every count for one task. Called at task boundaries. */
    reset(ulid: string): void {
        this.turns.delete(ulid)
        this.toolCalls.delete(ulid)
        this.errors.delete(ulid)
    }

    /** Forget every task. Called when the session ends. */
    clear(): void {
        this.turns.clear()
        this.toolCalls.clear()
        this.errors.clear()
    }

    /** How many tasks currently hold counts, across all three dimensions. */
    get trackedTasks(): number {
        return new Set([...this.turns.keys(), ...this.toolCalls.keys(), ...this.errors.keys()]).size
    }

    private increment(store: Map<string, number>, ulid: string): number {
        const nextValue = (store.get(ulid) ?? 0) + 1
        store.set(ulid, nextValue)

        if (store.size > MAX_TRACKED_TASKS) {
            // Map preserves insertion order, so the first key is the task that
            // has gone longest without activity in this dimension.
            const oldest = store.keys().next()
            if (!oldest.done && oldest.value !== ulid) {
                store.delete(oldest.value)
            }
        }

        return nextValue
    }
}
