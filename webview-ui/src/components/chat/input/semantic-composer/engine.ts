import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { type ComposerState, EMPTY_COMPOSER_STATE } from "./model"
import { applyOperation, type EditKind, type SemanticEditOperation } from "./operations"
import { type ComposerProjectionContext, projectComposerDocument } from "./projection"

export interface Disposable {
    dispose(): void
}

export type ComposerListener = (state: ComposerState) => void

/**
 * Told whenever states stopped being reachable - a load restarted the
 * history, the oldest undo step was dropped, or an edit discarded the redo
 * steps - with every state that is still reachable. Anything held for a state
 * outside them can be released.
 */
export type ReachabilityListener = (reachable: readonly ComposerState[]) => void

export interface SemanticComposerEngineOptions {
    readonly initial?: ComposerState
    /** Milliseconds clock; injected so undo grouping is testable. */
    readonly now?: () => number
    /** Undo steps kept; the oldest are dropped first. */
    readonly historyLimit?: number
}

/** Consecutive typing within this window undoes as one step, as in a native text field. */
const TYPING_GROUP_WINDOW_MS = 1000
const DEFAULT_HISTORY_LIMIT = 200

/**
 * The composer's single source of truth.
 *
 * The engine owns the draft and its undo history and knows nothing about any
 * view: a DOM editor, a test or an application action all change the draft by
 * applying {@link SemanticEditOperation}s and observe it by subscribing. The
 * semantic document a submission sends is projected on demand, because it
 * depends on the catalog revision at the moment of sending.
 */
export class SemanticComposerEngine {
    private state: ComposerState
    private readonly listeners = new Set<ComposerListener>()
    private readonly reachabilityListeners = new Set<ReachabilityListener>()
    private readonly past: ComposerState[] = []
    private readonly future: ComposerState[] = []
    /** Kept reachable across one load, until the load after it; see {@link holdThroughNextLoad}. */
    private held: ComposerState | undefined
    private pendingHold: ComposerState | undefined
    private loads = 0
    private lastKind: EditKind | undefined
    private lastEditAt = Number.NEGATIVE_INFINITY
    private readonly now: () => number
    private readonly historyLimit: number

    constructor(options: SemanticComposerEngineOptions = {}) {
        this.state = options.initial ?? EMPTY_COMPOSER_STATE
        this.now = options.now ?? (() => Date.now())
        this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    }

    getState(): ComposerState {
        return this.state
    }

    /**
     * Counts the drafts this engine has held: it changes whenever a load
     * replaces the draft. Asynchronous work captures it when it starts and
     * inserts nothing once it changed, so a result for a draft that is gone
     * never lands in the next one.
     */
    get generation(): number {
        return this.loads
    }

    /**
     * Keep `state` reachable through the next load and until the load after
     * it, without making it undoable.
     *
     * A sent draft is cleared by a load, yet a refused send puts the same
     * draft back; what its resources hold (preview URLs, retry sources) must
     * survive until that is decided, which at the latest is the next load.
     */
    holdThroughNextLoad(state: ComposerState): void {
        this.pendingHold = state
    }

    getDocument(context: ComposerProjectionContext): SemanticInputDocument {
        return projectComposerDocument(this.state.segments, context).document
    }

    canUndo(): boolean {
        return this.past.length > 0
    }

    canRedo(): boolean {
        return this.future.length > 0
    }

    apply(operation: SemanticEditOperation): void {
        const result = applyOperation(this.state, operation)
        if (result.kind === "settlement") {
            this.settleHistory(operation)
            if (result.changed) this.publish(result.state)
            return
        }
        if (!result.changed) return
        if (result.kind === "load") {
            this.loads++
            this.held = this.pendingHold
            this.pendingHold = undefined
        }
        const dropped = this.record(result.kind, result.historySeed)
        this.publish(result.state)
        if (dropped) this.announceReachability()
    }

    undo(): void {
        const previous = this.past.pop()
        if (!previous) return
        this.future.push(this.state)
        this.lastKind = undefined
        this.publish({ ...previous, revision: this.state.revision + 1 })
    }

    redo(): void {
        const next = this.future.pop()
        if (!next) return
        this.past.push(this.state)
        this.lastKind = undefined
        this.publish({ ...next, revision: this.state.revision + 1 })
    }

    subscribe(listener: ComposerListener): Disposable {
        this.listeners.add(listener)
        return { dispose: () => this.listeners.delete(listener) }
    }

    onReachabilityChange(listener: ReachabilityListener): Disposable {
        this.reachabilityListeners.add(listener)
        return { dispose: () => this.reachabilityListeners.delete(listener) }
    }

    /** Every state undo or redo can reach, plus a state held through a load. */
    reachableStates(): readonly ComposerState[] {
        return [this.state, ...this.past, ...this.future, ...(this.held ? [this.held] : [])]
    }

    /**
     * Apply a settlement to every state undo or redo can reach.
     *
     * The settled atom is the same entity in each of them, and the request that
     * settled it is finished, so going back must not bring back the unsettled
     * atom: a staging placeholder restored by undo would wait forever.
     */
    private settleHistory(operation: SemanticEditOperation): void {
        const settle = (state: ComposerState): ComposerState => {
            const result = applyOperation(state, operation)
            return result.changed ? { ...result.state, revision: state.revision } : state
        }
        this.past.splice(0, this.past.length, ...this.past.map(settle))
        this.future.splice(0, this.future.length, ...this.future.map(settle))
        if (this.held) this.held = settle(this.held)
    }

    private announceReachability(): void {
        const reachable = this.reachableStates()
        for (const listener of [...this.reachabilityListeners]) listener(reachable)
    }

    /**
     * Decide whether the state before this edit becomes an undo step.
     *
     * Selection moves are not undoable but end a typing group, so typing at two
     * places undoes separately. Loading a draft starts a fresh history: undo
     * never crosses into a different draft, except into the one step the load
     * itself seeds.
     *
     * Returns whether any state stopped being reachable, so what was held for
     * it can be released.
     */
    private record(kind: EditKind, seed: ComposerState | undefined): boolean {
        const at = this.now()
        let dropped = false
        if (kind === "load") {
            dropped = true
            this.past.length = 0
            this.future.length = 0
            if (seed) this.past.push(seed)
        } else if (kind !== "selection") {
            const continuesGroup =
                (kind === "typing" || kind === "deletion") &&
                this.lastKind === kind &&
                at - this.lastEditAt <= TYPING_GROUP_WINDOW_MS
            if (!continuesGroup) {
                this.past.push(this.state)
                if (this.past.length > this.historyLimit) {
                    this.past.shift()
                    dropped = true
                }
            }
            if (this.future.length > 0) {
                this.future.length = 0
                dropped = true
            }
        }
        this.lastKind = kind
        this.lastEditAt = at
        return dropped
    }

    private publish(state: ComposerState): void {
        this.state = state
        for (const listener of [...this.listeners]) listener(state)
    }
}
