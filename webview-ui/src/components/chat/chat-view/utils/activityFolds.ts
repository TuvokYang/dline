import type { AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { type ActivityFold, isBrowserSession } from "./chatRowKinds"
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
 * - `turn_end`: a turn-ending interaction; it ends a turn unit and stays outside.
 * - `assistant`: an assistant message; it stays visible at the `activity` level.
 * - `splitter`: a row that is still running, failed, or is a restore point the
 *   user checked out; it is never folded and cuts the block it would sit in.
 * - `activity`: everything else, which is what the `activity` level folds.
 */
export type FoldRowClass = "user" | "turn_end" | "assistant" | "splitter" | "activity"

/** Tool rows that render as assistant updates (working_respond and phase_report). */
const ASSISTANT_TOOLS = new Set<string>(["actModeRespond", "statusUpdate"] satisfies UiSayTool["tool"][])

/**
 * Fold the finished rows of each turn into collapsible blocks.
 *
 * Runs last, after every other grouping step, on rows it never mutates. With
 * `standard` it returns the very same array.
 *
 * Only rows before the last settled turn-end row fold: that row is written after
 * the turn's tool execution drained, so everything before it is finished work.
 * The open tail after it is drawn as it is while it streams, runs or waits.
 */
export function foldActivity(rows: ChatRow[], options: FoldOptions, context: FoldContext): ChatRow[] {
    if (options.level === "standard") return rows
    const classes = rows.map((row, index) => classifyFoldRow(row, index === rows.length - 1, options, context))
    const cutoff = settledCutoff(rows)
    const spans = options.level === "activity" ? activitySpans(rows, classes, cutoff, context) : turnSpans(classes, cutoff)
    return applySpans(rows, spans)
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

/** Index of the last settled turn-end row, or -1 when the window holds none. */
function settledCutoff(rows: readonly ChatRow[]): number {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]
        if (!Array.isArray(row) && isSettledTurnEnd(row)) return index
    }
    return -1
}

/** A half-open range `[start, end)` of row indexes that folds into one block. */
interface Span {
    readonly start: number
    readonly end: number
}

const MIN_FOLD_ROWS = 2

/**
 * `activity`: each maximal run of activity rows before the cutoff, of at least
 * two rows, whose opener is stable.
 */
function activitySpans(rows: readonly ChatRow[], classes: readonly FoldRowClass[], cutoff: number, context: FoldContext): Span[] {
    const spans: Span[] = []
    let index = 0
    while (index < cutoff) {
        if (classes[index] !== "activity") {
            index += 1
            continue
        }
        const start = index
        while (index < cutoff && classes[index] === "activity") index += 1
        if (index - start >= MIN_FOLD_ROWS && hasStableOpener(rows, start, context)) spans.push({ start, end: index })
    }
    return spans
}

/**
 * The row before a run opens it. It must be in the window, and so must the
 * start of its request round: grouping inside a round depends only on that
 * round's rows, so a fold keeps its identity while older rows are paged in
 * ahead of it. `indexRequestRounds` numbers a leading partial round 0.
 */
function hasStableOpener(rows: readonly ChatRow[], runStart: number, context: FoldContext): boolean {
    if (runStart === 0) return false
    const opener = rows[runStart - 1]
    const openerTs = Array.isArray(opener) ? opener[0]?.ts : opener.ts
    const round = openerTs === undefined ? undefined : context.rounds.get(openerTs)
    return round !== undefined && round > 0
}

/**
 * `turn`: the rows strictly between a user row and the next turn-end or user
 * row, cut by splitters into segments of at least two rows. A user row always
 * opens a request round, so the opener is stable by construction.
 */
function turnSpans(classes: readonly FoldRowClass[], cutoff: number): Span[] {
    const spans: Span[] = []
    const pushSegment = (start: number, end: number) => {
        if (end - start >= MIN_FOLD_ROWS) spans.push({ start, end })
    }
    let index = 0
    while (index < cutoff) {
        if (classes[index] !== "user") {
            index += 1
            continue
        }
        let segmentStart = index + 1
        let cursor = segmentStart
        while (cursor < cutoff && classes[cursor] !== "user" && classes[cursor] !== "turn_end") {
            if (classes[cursor] === "splitter") {
                pushSegment(segmentStart, cursor)
                segmentStart = cursor + 1
            }
            cursor += 1
        }
        pushSegment(segmentStart, cursor)
        index = cursor
    }
    return spans
}

function applySpans(rows: readonly ChatRow[], spans: readonly Span[]): ChatRow[] {
    if (spans.length === 0) return rows as ChatRow[]
    const result: ChatRow[] = []
    let index = 0
    for (const span of spans) {
        while (index < span.start) result.push(rows[index++])
        result.push(buildFold(rows.slice(span.start, span.end)))
        index = span.end
    }
    while (index < rows.length) result.push(rows[index++])
    return result
}

function buildFold(children: readonly ChatRow[]): ActivityFold {
    const fold = children.flatMap((row) => (Array.isArray(row) ? row : [row])) as ActivityFold
    fold._isActivityFold = true
    fold._activityFoldId = `fold:${fold[0].ts}`
    fold._children = children
    return fold
}
