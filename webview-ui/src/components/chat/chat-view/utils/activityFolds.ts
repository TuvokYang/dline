import type { AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { type ActivityFold, type ActivityFoldKind, isBrowserSession } from "./chatRowKinds"
import { type FoldContext, rowState } from "./foldContext"
import { isSettledTurnEnd, isTurnEndRow } from "./turnEndRows"

type ChatRow = UiMessage | UiMessage[]

export interface FoldOptions {
    readonly level: AggressiveRenderingLevel
    /** The ask the footer is answering right now; it stays visible whatever its row says. */
    readonly activeAskTs?: number
}

export const STANDARD_FOLD: FoldOptions = { level: "standard" }

/**
 * How the fold step treats a row.
 *
 * - `user`: a message the user wrote; folds never cross it and never take it in.
 * - `turn_end`: a turn-ending interaction; it ends a turn and stays outside.
 * - `assistant`: an assistant message; it folds with the rest of its round.
 * - `splitter`: a row that is still running, failed, or is a restore point the
 *   user checked out; it is never folded and cuts the block it would sit in.
 * - `activity`: everything else.
 */
export type FoldRowClass = "user" | "turn_end" | "assistant" | "splitter" | "activity"

/** Tool rows that render as assistant updates (working_respond and phase_report). */
const ASSISTANT_TOOLS = new Set<string>(["actModeRespond", "statusUpdate"] satisfies UiSayTool["tool"][])

/**
 * Fold the rows of every ended request round into collapsible blocks.
 *
 * Runs last, after every other grouping step, on rows it never mutates. With
 * `standard` it returns the very same array.
 *
 * Folding follows the task as it runs: a round folds as soon as it has ended,
 * that is once a later round has started or a settled turn end follows it. The
 * round still running is drawn as it is while it streams, runs or waits.
 *
 * - `activity`: each ended round folds into its own block.
 * - `turn`: every ended round between a user message and the turn end folds
 *   into one block, which takes in each further round when that round ends.
 *   Inside it, each round is folded on its own, as at the `activity` level.
 */
export function foldActivity(rows: ChatRow[], options: FoldOptions, context: FoldContext): ChatRow[] {
    if (options.level === "standard") return rows
    const classes = rows.map((row, index) => classifyFoldRow(row, index === rows.length - 1, options, context))
    const rounds = roundOfRows(rows, classes, context)
    const ended = endedRows(rows, classes, rounds)
    if (options.level === "activity") {
        return applySpans(rows, roundSpans(classes, rounds, ended), (span) =>
            buildFold(rows.slice(span.start, span.end), "round"),
        )
    }
    return applySpans(rows, turnSpans(classes, ended), (span) => buildFold(roundFoldsOf(rows, rounds, span), "turn"))
}

export function classifyFoldRow(row: ChatRow, isLastRow: boolean, options: FoldOptions, context: FoldContext): FoldRowClass {
    if (Array.isArray(row)) return isSplitterGroup(row, isLastRow, options, context) ? "splitter" : "activity"
    if (isUserRow(row)) return "user"
    if (isTurnEndRow(row)) return "turn_end"
    if (isSplitterMessage(row, options, context) || (isLastRow && row.type === "ask")) return "splitter"
    if (isAssistantMessage(row)) return "assistant"
    return "activity"
}

function isUserRow(message: UiMessage): boolean {
    return message.type === "say" && (message.say === "task" || message.say === "user_feedback")
}

function isAssistantMessage(message: UiMessage): boolean {
    if (message.type !== "say") return false
    if (message.say === "text") return true
    return message.say === "tool" && ASSISTANT_TOOLS.has(toolName(message) ?? "")
}

function toolName(message: UiMessage): string | undefined {
    try {
        const tool = JSON.parse(message.text ?? "") as { tool?: unknown }
        return typeof tool?.tool === "string" ? tool.tool : undefined
    } catch {
        return undefined
    }
}

function isSplitterMessage(message: UiMessage, options: FoldOptions, context: FoldContext): boolean {
    if (message.ts === options.activeAskTs) return true
    if (message.say === "checkpoint_created" && message.isCheckpointCheckedOut) return true
    if (context.checkedOutOwners.has(message.ts)) return true
    return rowState(message, context) !== "settled"
}

/** A group is only as finished as its least finished member. */
function isSplitterGroup(group: UiMessage[], isLastRow: boolean, options: FoldOptions, context: FoldContext): boolean {
    // The error row that ended a failed browser session is not one of its members.
    if (isBrowserSession(group) && group._end === "failed") return true
    if (isLastRow && group.at(-1)?.type === "ask") return true
    return group.some((message) => isSplitterMessage(message, options, context))
}

function isFoldable(rowClass: FoldRowClass): boolean {
    return rowClass === "activity" || rowClass === "assistant"
}

function isRestorePoint(row: ChatRow): boolean {
    return !Array.isArray(row) && row.say === "checkpoint_created"
}

/**
 * The request round each row belongs to.
 *
 * A group takes the latest round among its members, since an exploration run
 * spans the read-only rounds it joined. A restore point is written before the
 * request it protects, so it heads the round of the row after it; as the last
 * row it heads a round that has drawn nothing yet.
 */
function roundOfRows(rows: readonly ChatRow[], classes: readonly FoldRowClass[], context: FoldContext): number[] {
    const rounds = rows.map((row) => memberRound(row, context))
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (!isRestorePoint(rows[index])) continue
        const next = index + 1
        if (next === rows.length) rounds[index] += 1
        else if (classes[next] !== "user" && classes[next] !== "turn_end") rounds[index] = rounds[next]
    }
    return rounds
}

function memberRound(row: ChatRow, context: FoldContext): number {
    const members = Array.isArray(row) ? row : [row]
    let round = 0
    for (const member of members) {
        if (Array.isArray(row) && member.say === "checkpoint_created") continue
        round = Math.max(round, context.rounds.get(member.ts) ?? 0)
    }
    return round
}

/**
 * Whether each row's round has ended: a later round has drawn a row, or a
 * settled turn end follows. A settled turn end is only written after the turn's
 * tool execution drained, so everything before it is finished work.
 *
 * A user row alone proves nothing: an approval note is written while the call
 * it approves may still be running.
 */
function endedRows(rows: readonly ChatRow[], classes: readonly FoldRowClass[], rounds: readonly number[]): boolean[] {
    const ended = new Array<boolean>(rows.length).fill(false)
    let latestRoundAhead = Number.NEGATIVE_INFINITY
    let settledTurnEndAhead = false
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        ended[index] = settledTurnEndAhead || latestRoundAhead > rounds[index]
        const row = rows[index]
        if (!Array.isArray(row) && isSettledTurnEnd(row)) settledTurnEndAhead = true
        if (classes[index] !== "user") latestRoundAhead = Math.max(latestRoundAhead, rounds[index])
    }
    return ended
}

/** A half-open range `[start, end)` of row indexes that folds into one block. */
interface Span {
    readonly start: number
    readonly end: number
}

/**
 * `activity`: the ended rows of each round, cut by splitters.
 *
 * Round 0 is the partial round `indexRequestRounds` assigns to rows before the
 * first round start in the window. Its rows are left alone, so a fold keeps its
 * identity while older rows are paged in ahead of it.
 */
function roundSpans(classes: readonly FoldRowClass[], rounds: readonly number[], ended: readonly boolean[]): Span[] {
    const spans: Span[] = []
    let start = -1
    const close = (end: number) => {
        if (start >= 0) spans.push({ start, end })
        start = -1
    }
    for (let index = 0; index < classes.length; index += 1) {
        if (!isFoldable(classes[index]) || !ended[index] || rounds[index] === 0) {
            close(index)
            continue
        }
        if (start >= 0 && rounds[index] !== rounds[start]) close(index)
        if (start < 0) start = index
    }
    close(classes.length)
    return spans
}

/**
 * `turn`: the ended rows strictly between a user row and the next turn-end or
 * user row, cut by splitters. A user row always opens a request round, so the
 * block keeps its identity as further rounds join it.
 */
function turnSpans(classes: readonly FoldRowClass[], ended: readonly boolean[]): Span[] {
    const spans: Span[] = []
    let index = 0
    while (index < classes.length) {
        if (classes[index] !== "user") {
            index += 1
            continue
        }
        let start = -1
        let cursor = index + 1
        for (; cursor < classes.length && classes[cursor] !== "user" && classes[cursor] !== "turn_end"; cursor += 1) {
            if (isFoldable(classes[cursor]) && ended[cursor]) {
                if (start < 0) start = cursor
                continue
            }
            if (start >= 0) spans.push({ start, end: cursor })
            start = -1
        }
        if (start >= 0) spans.push({ start, end: cursor })
        index = cursor
    }
    return spans
}

/** One round fold for each run of rows of the same round inside a turn span; every row in it has ended. */
function roundFoldsOf(rows: readonly ChatRow[], rounds: readonly number[], span: Span): ActivityFold[] {
    const folds: ActivityFold[] = []
    let start = span.start
    for (let index = span.start + 1; index <= span.end; index += 1) {
        if (index < span.end && rounds[index] === rounds[start]) continue
        folds.push(buildFold(rows.slice(start, index), "round"))
        start = index
    }
    return folds
}

function applySpans(rows: readonly ChatRow[], spans: readonly Span[], build: (span: Span) => ActivityFold): ChatRow[] {
    if (spans.length === 0) return rows as ChatRow[]
    const result: ChatRow[] = []
    let index = 0
    for (const span of spans) {
        while (index < span.start) result.push(rows[index++])
        result.push(build(span))
        index = span.end
    }
    while (index < rows.length) result.push(rows[index++])
    return result
}

const FOLD_ID_PREFIX: Record<ActivityFoldKind, string> = { round: "fold", turn: "turn" }

function buildFold(children: readonly ChatRow[], kind: ActivityFoldKind): ActivityFold {
    const fold = children.flatMap((row) => (Array.isArray(row) ? row : [row])) as ActivityFold
    fold._isActivityFold = true
    fold._foldKind = kind
    fold._activityFoldId = `${FOLD_ID_PREFIX[kind]}:${fold[0].ts}`
    fold._children = children
    return fold
}
