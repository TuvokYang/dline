import type { AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { type ActivityFold, type ActivityFoldKind, isActivityFold, isBrowserSession } from "./chatRowKinds"
import { type FoldContext, rowState } from "./foldContext"
import { isSettledTurnEnd, isTurnEndRow } from "./turnEndRows"

type ChatRow = UiMessage | UiMessage[]

export interface FoldOptions {
    readonly level: AggressiveRenderingLevel
    /** The ask the footer is answering right now; it stays visible whatever its row says. */
    readonly activeAskTs?: number
}

export const STANDARD_FOLD: FoldOptions = { level: "none" }

/**
 * How the fold step treats a row.
 *
 * - `user`: a message the user wrote; folds never cross it and never take it in.
 * - `turn_end`: a turn-ending interaction; it ends a turn and stays outside.
 * - `assistant`: a communication boundary in message mode, a member in turn mode.
 * - `splitter`: a row that is still running, failed, or is a restore point the
 *   user checked out; it is never folded and cuts the block it would sit in.
 * - `activity`: everything else.
 */
export type FoldRowClass = "user" | "turn_end" | "assistant" | "splitter" | "activity"

/** Tool rows that render as assistant updates (working_respond and phase_report). */
const ASSISTANT_TOOLS = new Set<string>(["actModeRespond", "statusUpdate"] satisfies UiSayTool["tool"][])

/**
 * Fold eligible Standard rows without regrouping their members. Request rounds
 * determine completion, never block boundaries. Message segments stop at prose,
 * replies and phase reports; user turns include those messages. Live, failed and
 * checked-out rows split both modes. Leading partial rounds stay visible.
 */
export function foldActivity(rows: ChatRow[], options: FoldOptions, context: FoldContext): ChatRow[] {
    if (options.level === "none") return rows
    const classes = rows.map((row, index) => classifyFoldRow(row, index === rows.length - 1, options, context))
    const rounds = roundOfRows(rows, classes, context)
    const ended = endedRows(rows, classes, rounds)
    const spans = foldingSpans(classes, rounds, ended, options.level)
    const kind = options.level === "message_segment" ? "segment" : "turn"
    return applySpans(rows, spans, (span) => buildFold(rows.slice(span.start, span.end), kind, context))
}

/** Open folds into the exact original top-level rows, with no rendering wrapper. */
export function projectFoldExpansion(rows: ChatRow[], expanded: Readonly<Record<string, boolean>>): ChatRow[] {
    if (!rows.some((row) => isActivityFold(row) && expanded[row._activityFoldId])) return rows
    return rows.flatMap((row) => (isActivityFold(row) && expanded[row._activityFoldId] ? [...row._children] : [row]))
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

function foldingSpans(
    classes: readonly FoldRowClass[],
    rounds: readonly number[],
    ended: readonly boolean[],
    level: Exclude<AggressiveRenderingLevel, "none">,
): Span[] {
    const spans: Span[] = []
    let start = -1
    let inUserTurn = false
    const close = (end: number) => {
        if (start >= 0) spans.push({ start, end })
        start = -1
    }
    for (let index = 0; index < classes.length; index += 1) {
        const kind = classes[index]
        if (kind === "user" || kind === "turn_end") {
            close(index)
            inUserTurn = kind === "user"
            continue
        }
        const eligible = level === "message_segment" ? kind === "activity" : inUserTurn && isFoldable(kind)
        if (!eligible || !ended[index] || rounds[index] === 0) {
            close(index)
            continue
        }
        if (start < 0) start = index
    }
    close(classes.length)
    return spans
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

function buildFold(children: readonly ChatRow[], kind: ActivityFoldKind, context: FoldContext): ActivityFold {
    const fold = children.flatMap((row) => (Array.isArray(row) ? row : [row])) as ActivityFold
    fold._isActivityFold = true
    fold._foldKind = kind
    fold._activityFoldId = `${kind}:${fold[0].ts}`
    fold._children = children
    // Round-start checkpoints precede their request, so their raw index belongs
    // to the previous round. Count content, not these leading markers.
    fold._roundCount = new Set(
        fold
            .filter((member) => member.say !== "checkpoint_created")
            .map((member) => context.rounds.get(member.ts))
            .filter((round) => round !== undefined && round > 0),
    ).size
    return fold
}
