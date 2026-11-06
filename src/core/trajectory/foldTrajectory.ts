import type { UiAsk, UiMessage } from "@shared/ExtensionMessage"
import {
    askKindAfter,
    isContextIgnored,
    isCountedRound,
    isSuccessfulCompletion,
    isTurnStart,
    trajectoryToolKey,
} from "./TurnRules"

/** Longest prompt preview a turn stores; the rail shows only the opening of the message. */
export const PROMPT_PREVIEW_MAX_CHARS = 500

/** One committed chat row at its physical position in `messages.db`. */
export interface OrdinalRow {
    readonly ordinal: number
    readonly message: UiMessage
}

export interface ToolCount {
    readonly tool: string
    readonly count: number
}

/** A turn as the fold closes it; the store adds identity and revision fields. */
export interface FoldedTurn {
    readonly seq: number
    readonly attemptSeq: number
    readonly anchorTs: number
    readonly anchorOrdinal: number
    readonly prompt: string
    readonly rounds: number
    readonly toolUsage: readonly ToolCount[]
    /** Whether the turn contains a successful completion, which ends its attempt. */
    readonly endsAttempt: boolean
    /** ts of the last final row in the turn, copied only as a compatibility payload. */
    readonly tailTs: number
    /** Ask kind of the last meaningful row of the turn; seeds reply classification of the next row. */
    readonly tailAskKind: UiAsk | null
}

/** A turn whose closing row has not been seen yet. */
export interface OpenTurn {
    readonly seq: number
    readonly attemptSeq: number
    readonly anchorTs: number
    readonly anchorOrdinal: number
    readonly prompt: string
    readonly rounds: number
    readonly toolUsage: readonly ToolCount[]
    readonly endsAttempt: boolean
    /** Opaque identity of the last final row, never used to order or admit rows. */
    readonly tailTs: number
}

/**
 * Everything a fold needs from rows before its first row, so any split of the
 * history folds to the same turns as one pass over it.
 */
export interface FoldCarry {
    /** seq the next opened turn receives. */
    readonly seq: number
    /** attemptSeq of the most recent turn, or 0 before any turn. */
    readonly attemptSeq: number
    readonly openTurn: OpenTurn | null
    /** Whether the most recent closed turn ended its attempt, so the next turn starts a new one. */
    readonly prevCompleted: boolean
    readonly lastAskKind: UiAsk | null
}

export interface FoldResult {
    /** Turns closed by a later turn start inside the folded rows, in seq order. */
    readonly turns: readonly FoldedTurn[]
    readonly carry: FoldCarry
}

export const EMPTY_FOLD_CARRY: FoldCarry = {
    seq: 0,
    attemptSeq: 0,
    openTurn: null,
    prevCompleted: false,
    lastAskKind: null,
}

/** The carry that resumes folding at the anchor of the turn after `previous`. */
export function carryAfterTurn(previous: FoldedTurn): FoldCarry {
    return {
        seq: previous.seq + 1,
        attemptSeq: previous.attemptSeq,
        openTurn: null,
        prevCompleted: previous.endsAttempt,
        lastAskKind: previous.tailAskKind,
    }
}

/**
 * Fold rows, given in ascending ordinal order, into turns.
 *
 * Pure and chunk-invariant: folding a history in any number of slices, passing
 * each result's carry to the next slice, yields exactly the turns of one fold
 * over the whole history once the final open turn is closed with
 * {@link closeOpenTurn}. Every final user anchor opens a turn at its physical
 * ordinal, regardless of its ts. Partial rows occupy source positions without
 * contributing counts or changing reply classification.
 */
export function foldTrajectory(rows: readonly OrdinalRow[], carry: FoldCarry): FoldResult {
    const turns: FoldedTurn[] = []
    let state = carry

    for (const { ordinal, message } of rows) {
        if (isTurnStart(message, { lastAskKind: state.lastAskKind })) {
            if (state.openTurn) turns.push(closeTurn(state.openTurn, state.lastAskKind))
            const closedEndedAttempt = state.openTurn ? state.openTurn.endsAttempt : state.prevCompleted
            const attemptSeq = state.seq === 0 ? 0 : closedEndedAttempt ? state.attemptSeq + 1 : state.attemptSeq
            state = {
                ...state,
                seq: state.seq + 1,
                attemptSeq,
                prevCompleted: closedEndedAttempt,
                openTurn: {
                    seq: state.seq,
                    attemptSeq,
                    anchorTs: message.ts,
                    anchorOrdinal: ordinal,
                    prompt: previewOf(message.text),
                    rounds: 0,
                    toolUsage: [],
                    endsAttempt: false,
                    tailTs: message.ts,
                },
            }
        } else if (state.openTurn && message.partial !== true) {
            state = { ...state, openTurn: accumulate(state.openTurn, message) }
        }

        if (!isContextIgnored(message)) state = { ...state, lastAskKind: askKindAfter(message) }
    }

    return { turns, carry: state }
}

/** Close the turn still open after the last folded row; null when no turn has started. */
export function closeOpenTurn(carry: FoldCarry): FoldedTurn | null {
    return carry.openTurn ? closeTurn(carry.openTurn, carry.lastAskKind) : null
}

function closeTurn(turn: OpenTurn, lastAskKind: UiAsk | null): FoldedTurn {
    return { ...turn, tailAskKind: lastAskKind }
}

function accumulate(turn: OpenTurn, message: UiMessage): OpenTurn {
    let next = { ...turn, tailTs: message.ts }
    if (isCountedRound(message)) next = { ...next, rounds: next.rounds + 1 }
    const tool = trajectoryToolKey(message)
    if (tool !== undefined) next = { ...next, toolUsage: incrementTool(next.toolUsage, tool) }
    if (!next.endsAttempt && isSuccessfulCompletion(message)) next = { ...next, endsAttempt: true }
    return next
}

/** Counts keep first-use order so the preview lists tools as the turn used them. */
function incrementTool(usage: readonly ToolCount[], tool: string): readonly ToolCount[] {
    const index = usage.findIndex((entry) => entry.tool === tool)
    if (index < 0) return [...usage, { tool, count: 1 }]
    return usage.map((entry, position) => (position === index ? { tool, count: entry.count + 1 } : entry))
}

function previewOf(text: string | undefined): string {
    const value = text ?? ""
    return value.length > PROMPT_PREVIEW_MAX_CHARS ? value.slice(0, PROMPT_PREVIEW_MAX_CHARS) : value
}
