/**
 * Per-task arithmetic for how large the tool results of one round may be.
 *
 * Occupancy is read, never tracked here: the context window indicator owns what
 * the conversation already holds. The ledger adds only what it alone knows -
 * results produced since the indicator last counted them - and splits the
 * round's budget among the consumers that are still working. It bounds tool
 * results only; where compaction starts is decided by the user's settings.
 */

/** Share of the context left when a round starts that the round's tool results may take together. */
export const ROUND_RESULT_SHARE_RATIO = 0.8
/** Below this many remaining tokens new result bodies are held instead of delivered. */
export const CONTEXT_BUDGET_YIELD_TOKENS = 3_000
/** Used when no ratio has been learned for the current model yet. */
const FALLBACK_TOKEN_PER_BYTE = 0.25

export interface ContextBudgetReadings {
    /** The context window the user works in, in tokens. */
    contextWindow(): number
    /** Tokens the conversation already occupies, as the context window indicator counts them. */
    occupiedTokens(): number
    /** Learned tokens per byte for the current model. */
    tokenPerByte(): number
}

export interface ContextBudgetSnapshot {
    readonly contextWindowTokens: number
    readonly occupiedTokens: number
    /** Results produced since the indicator last counted them. */
    readonly stagedTokens: number
    /** Context still free: the window minus what is occupied and staged. */
    readonly remainingTokens: number
    /** What this round's tool results may take together: a share of the context left when it started. */
    readonly roundBudgetTokens: number
    /** Results this round has already produced. */
    readonly roundStagedTokens: number
    readonly activeConsumers: number
    /** What each active consumer may still add: the round's unused budget split among them. */
    readonly shareTokens: number
    readonly mustYield: boolean
}

/** One running tool call or subagent drawing on the shared budget. */
export interface ContextBudgetLease {
    /** The shared budget as it stands now. */
    snapshot(): ContextBudgetSnapshot
    /**
     * Bytes this consumer may still return, never above `capBytes`.
     *
     * Results its children already counted are included: they are part of what
     * this consumer returns and have been paid for once.
     */
    shareBytes(capBytes: number): number
    /**
     * Start a consumer working on this one's behalf, such as one subagent of a
     * fan-out. While any child is working this consumer draws no share of its
     * own, and what a child returns is credited to it.
     */
    child(): ContextBudgetLease
    /**
     * Count the result this consumer produced, then stop counting it as active.
     * Only the bytes its children did not already count are staged, plus the
     * tokens of images and documents the result carries. A child that outlives
     * its parent stages nothing: nobody returns its result inline, so background
     * delivery counts it when it is delivered. Idempotent.
     */
    end(resultBytes?: number, mediaTokens?: number): void
}

/** Room taken for one result delivered outside a tool call, until it is released. */
export interface ContextBudgetReservation {
    /** Bytes of the result that fit; never more than were asked for. */
    readonly bytes: number
    /** The result was not delivered after all; stop counting it. Idempotent. */
    release(): void
}

interface Consumer {
    readonly parent?: Consumer
    activeChildren: number
    creditedBytes: number
    ended: boolean
}

export class ContextBudgetLedger {
    private readonly consumers = new Set<Consumer>()
    private stagedTokens = 0
    /** The part of `stagedTokens` the round being composed carries. */
    private checkpointTokens = 0
    /** The part of `stagedTokens` the current round's tool results produced. */
    private roundStagedTokens = 0

    constructor(private readonly readings: ContextBudgetReadings) {}

    begin(): ContextBudgetLease {
        return this.open(undefined)
    }

    stageBytes(bytes: number): void {
        this.stageTokens(Math.ceil(Math.max(0, bytes) * this.tokenPerByte()))
    }

    /** Counts a result of the current round. */
    stageTokens(tokens: number): void {
        const counted = Math.max(0, Math.ceil(tokens))
        this.stagedTokens += counted
        this.roundStagedTokens += counted
    }

    /** The indicator now counts everything staged: a request carried it, or compaction replaced it. */
    clearStaged(): void {
        this.stagedTokens = 0
        this.checkpointTokens = 0
        this.roundStagedTokens = 0
    }

    /**
     * Marks what is staged now as carried by the round being composed, which
     * ends the round: results produced after it belong to the next one.
     *
     * The round is not counted yet: compose may stop, or compaction may fail,
     * before a request carries it. Until `retireCheckpoint` the results stay staged.
     */
    checkpoint(): void {
        this.checkpointTokens = this.stagedTokens
        this.roundStagedTokens = 0
    }

    /**
     * The indicator now counts what the last checkpoint marked: the request
     * carrying it opened, or a summary replaced it. Results staged after the
     * checkpoint keep counting. A second call without a new checkpoint does nothing.
     */
    retireCheckpoint(): void {
        this.stagedTokens = Math.max(0, this.stagedTokens - this.checkpointTokens)
        this.checkpointTokens = 0
    }

    snapshot(): ContextBudgetSnapshot {
        const contextWindowTokens = Math.max(0, Math.floor(this.readings.contextWindow()))
        const occupiedTokens = Math.max(0, this.readings.occupiedTokens())
        const remainingTokens = Math.max(0, contextWindowTokens - occupiedTokens - this.stagedTokens)
        // The round's budget is fixed by what was left when it started, so the
        // results it already produced shrink its unused part, not the base.
        const roundStartTokens = Math.max(0, contextWindowTokens - occupiedTokens - (this.stagedTokens - this.roundStagedTokens))
        const roundBudgetTokens = Math.floor(roundStartTokens * ROUND_RESULT_SHARE_RATIO)
        const activeConsumers = this.countDrawingConsumers()
        return {
            contextWindowTokens,
            occupiedTokens,
            stagedTokens: this.stagedTokens,
            remainingTokens,
            roundBudgetTokens,
            roundStagedTokens: this.roundStagedTokens,
            activeConsumers,
            shareTokens: Math.floor(Math.max(0, roundBudgetTokens - this.roundStagedTokens) / Math.max(1, activeConsumers)),
            mustYield: remainingTokens < CONTEXT_BUDGET_YIELD_TOKENS,
        }
    }

    /** Current share in bytes for one consumer, never above `capBytes`. */
    shareBytes(capBytes: number): number {
        return Math.max(0, Math.min(capBytes, Math.floor(this.snapshot().shareTokens / this.tokenPerByte())))
    }

    /**
     * Counts a result delivered outside any tool call, cut to the room left
     * above the yield floor. Undefined when no room is left: the result waits
     * for compaction, which the conversation then reaches.
     */
    reserveBytes(bytes: number): ContextBudgetReservation | undefined {
        const tokenPerByte = this.tokenPerByte()
        const roomTokens = this.snapshot().remainingTokens - CONTEXT_BUDGET_YIELD_TOKENS
        if (roomTokens <= 0) return undefined
        const granted = Math.min(Math.max(0, Math.floor(bytes)), Math.floor(roomTokens / tokenPerByte))
        const tokens = Math.ceil(granted * tokenPerByte)
        // Not a tool result of this round: it takes room, but not the round's budget.
        this.stagedTokens += tokens
        let released = false
        return {
            bytes: granted,
            release: () => {
                if (released) return
                released = true
                this.stagedTokens = Math.max(0, this.stagedTokens - tokens)
            },
        }
    }

    private open(parent: Consumer | undefined): ContextBudgetLease {
        const consumer: Consumer = { parent, activeChildren: 0, creditedBytes: 0, ended: false }
        this.consumers.add(consumer)
        if (parent) parent.activeChildren++
        return {
            snapshot: () => this.snapshot(),
            shareBytes: (capBytes) => Math.min(capBytes, consumer.creditedBytes + this.shareBytes(capBytes)),
            child: () => this.open(consumer),
            end: (resultBytes, mediaTokens) => this.close(consumer, Math.max(0, resultBytes ?? 0), Math.max(0, mediaTokens ?? 0)),
        }
    }

    private close(consumer: Consumer, resultBytes: number, mediaTokens: number): void {
        if (consumer.ended) return
        consumer.ended = true
        const parent = consumer.parent
        // Count the result before releasing the slot so no other consumer's
        // share is ever computed from a remainder that still includes it.
        if (!parent?.ended) {
            const uncounted = resultBytes - consumer.creditedBytes
            if (uncounted > 0) this.stageBytes(uncounted)
            this.stageTokens(mediaTokens)
        }
        if (parent) {
            parent.creditedBytes += Math.max(resultBytes, consumer.creditedBytes)
            parent.activeChildren--
        }
        this.consumers.delete(consumer)
    }

    /** A consumer whose children are working is represented by them, not counted again. */
    private countDrawingConsumers(): number {
        let count = 0
        for (const consumer of this.consumers) if (consumer.activeChildren === 0) count++
        return count
    }

    private tokenPerByte(): number {
        const ratio = this.readings.tokenPerByte()
        return Number.isFinite(ratio) && ratio > 0 ? ratio : FALLBACK_TOKEN_PER_BYTE
    }
}
