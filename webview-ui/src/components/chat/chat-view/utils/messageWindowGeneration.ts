/**
 * Arbitrates which asynchronous work may still change the loaded message window.
 *
 * Paging extends the window it was launched for: it captures the generation and
 * applies only while the generation is unchanged, so a leading and a trailing
 * page launched for the same window both land. Navigation (an edge jump, a jump
 * to a message, a task change) advances the generation, which invalidates every
 * page and every older navigation still in flight. A navigation that replaces
 * the window keeps paging out until it lands, because a page cut from the old
 * window would be discarded or merged into the wrong one.
 */
export interface MessageWindowGeneration {
    /** The generation a page extending the current window applies under. */
    capture(): number
    /** Invalidate pending work for a navigation that keeps the loaded window. */
    advance(): number
    /** Invalidate pending work for a navigation that will replace the window; paging waits for `settle`. */
    replace(): number
    /** The replacement launched as `generation` landed or gave up; paging may resume if it is still current. */
    settle(generation: number): void
    isCurrent(generation: number): boolean
    /** Whether a replacement is in flight, during which new pages are not admitted. */
    readonly replacementPending: boolean
}

export function createMessageWindowGeneration(): MessageWindowGeneration {
    let generation = 0
    let replacementPending = false
    return {
        capture: () => generation,
        advance: () => {
            replacementPending = false
            return ++generation
        },
        replace: () => {
            replacementPending = true
            return ++generation
        },
        settle: (settled) => {
            if (settled === generation) replacementPending = false
        },
        isCurrent: (candidate) => candidate === generation,
        get replacementPending() {
            return replacementPending
        },
    }
}
