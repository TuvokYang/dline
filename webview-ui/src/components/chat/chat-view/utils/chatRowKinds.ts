import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * Tagged row kinds of the chat list.
 *
 * A chat row is a message or an array of messages. Arrays carry a tag so every
 * consumer (renderer, virtual-list identity, scroll policy) recognises the same
 * kind without re-deriving it, and so a group still exposes its members to
 * lookups that search rows by message timestamp.
 */

/** The low-stakes tool calls of one request round. */
export type ToolMessageGroup = UiMessage[] & { _isToolGroup: true; _toolGroupId: string }

/** Check if a message group is a logical low-stakes tool round. */
export function isToolGroup(item: UiMessage | UiMessage[]): item is ToolMessageGroup {
    if (!Array.isArray(item)) return false
    const group = item as UiMessage[] & { _isToolGroup?: boolean; _toolGroupId?: string }
    return group._isToolGroup === true && typeof group._toolGroupId === "string"
}

/** One request round inside an exploration run, in the order its rows were written. */
export interface ExplorationRound {
    /** The restore point written before this round's request, when one was written. */
    readonly checkpoint?: UiMessage
    /** Reasoning rows and the round's tool group, in transcript order. */
    readonly entries: readonly (UiMessage | ToolMessageGroup)[]
}

/**
 * Consecutive read-only rounds folded into one row.
 *
 * The array holds every member message in transcript order, so a lookup by
 * timestamp still finds a reasoning row or checkpoint inside the run. The
 * rounds keep each checkpoint reachable: folding changes where a restore point
 * is drawn, never whether it can be restored.
 */
export type ExplorationRun = UiMessage[] & {
    _isExplorationRun: true
    /** Stable identity: the first member, which later rounds never replace. */
    _explorationRunId: string
    _rounds: readonly ExplorationRound[]
}

export function isExplorationRun(item: UiMessage | UiMessage[]): item is ExplorationRun {
    if (!Array.isArray(item)) return false
    const run = item as UiMessage[] & { _isExplorationRun?: boolean }
    return run._isExplorationRun === true
}

/**
 * How a browser session group stopped taking messages.
 *
 * - `closed`: the model closed the browser;
 * - `failed`: an error row ended it;
 * - `interrupted`: the request it was waiting on was cancelled;
 * - `ended`: other work, or a new browser launch, followed without a close;
 * - `open`: the loaded transcript ends inside the session.
 */
export type BrowserSessionEnd = "closed" | "failed" | "interrupted" | "ended" | "open"

/**
 * The rounds of one browser session folded into one row.
 *
 * Browser rounds change no workspace files, so their restore points and
 * thinking fold into the session card the way read-only rounds fold into an
 * exploration run, instead of stacking up under the screenshot frame.
 */
export type BrowserSessionGroup = UiMessage[] & {
    _isBrowserSession: true
    /** Stable identity: the first member, which later rounds never replace. */
    _browserSessionId: string
    _end: BrowserSessionEnd
}

export function isBrowserSession(item: UiMessage | UiMessage[]): item is BrowserSessionGroup {
    if (!Array.isArray(item)) return false
    const group = item as UiMessage[] & { _isBrowserSession?: boolean }
    return group._isBrowserSession === true
}

/** Rows that draw low-stakes tool activity: the scroll and waiting policies treat both alike. */
export function isToolActivityRow(item: UiMessage | UiMessage[]): item is ToolMessageGroup | ExplorationRun {
    return isToolGroup(item) || isExplorationRun(item)
}
