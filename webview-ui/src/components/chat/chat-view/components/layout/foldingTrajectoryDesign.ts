import { AGGRESSIVE_RENDERING_LEVELS, type AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import { type FoldRoundUsage, summarizeRoundsUsage } from "@shared/chat/foldUsage"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import {
    type ActivityFold,
    type ActivityFoldKind,
    type FoldFailureKind,
    isActivityFold,
    isBrowserSession,
    isExplorationRun,
} from "../../utils/chatRowKinds"
import {
    buildFoldContext,
    type FoldContext,
    failedWorkKind,
    failedWorkUnits,
    isFoldableWorkEnd,
    rowState,
} from "../../utils/foldContext"
import { indexRequestRounds } from "../../utils/messageUtils"
import { isSettledTurnEnd, isTurnEndRow } from "../../utils/turnEndRows"

export const DESIGN_FOLDING_MODES = AGGRESSIVE_RENDERING_LEVELS
export type DesignFoldingMode = AggressiveRenderingLevel

/** The stories' entry point: the reviewed policy over the Standard rows. */
export function designFoldRows(
    messages: UiMessage[],
    standardRows: ChatRow[],
    mode: DesignFoldingMode,
    roundUsage: readonly FoldRoundUsage[] = [],
): ChatRow[] {
    const rounds = indexRequestRounds(messages)
    const folded = foldRows(splitRunsByRound(standardRows), { level: mode }, buildFoldContext(messages, rounds))
    return attachUsage(folded, rounds, roundUsage)
}

/**
 * Attach each block the usage of the rounds it holds.
 *
 * A block's members belong to request rounds, so the figures are looked up by
 * those rounds rather than summed from message payloads. A block whose rounds
 * have no record simply shows no figures instead of guessing.
 */
function attachUsage(
    rows: readonly ChatRow[],
    rounds: ReadonlyMap<number, number>,
    roundUsage: readonly FoldRoundUsage[],
): ChatRow[] {
    if (roundUsage.length === 0) return [...rows]
    const byRound = indexUsageByRound(roundUsage, rounds)
    return rows.map((row) => {
        if (!isActivityFold(row)) return row
        const covered = new Set<FoldRoundUsage>()
        for (const member of row) {
            // A round-start restore point belongs to the round it opens, so it
            // must not pull in the previous round's figures.
            if (member.say === "checkpoint_created") continue
            const round = rounds.get(member.ts)
            const usage = round === undefined ? undefined : byRound.get(round)
            if (usage) covered.add(usage)
        }
        const usage = summarizeRoundsUsage([...covered])
        if (usage) row._usage = usage
        return row
    })
}

/**
 * Map a transcript round index onto its usage record.
 *
 * `indexRequestRounds` numbers the transcript's provider sends in order, and the
 * records arrive in that same order, so the nth round with a send is the nth
 * record. Rounds before the first send have no figures.
 */
function indexUsageByRound(
    roundUsage: readonly FoldRoundUsage[],
    rounds: ReadonlyMap<number, number>,
): ReadonlyMap<number, FoldRoundUsage> {
    const providerRounds = [...new Set(rounds.values())].filter((round) => round > 0).sort((left, right) => left - right)
    const byRound = new Map<number, FoldRoundUsage>()
    providerRounds.forEach((round, position) => {
        const usage = roundUsage[position]
        if (usage) byRound.set(round, usage)
    })
    return byRound
}

/**
 * Draw one row per request round.
 *
 * Standard grouping joins consecutive read-only rounds into a single exploration
 * run, so a stretch of reads collapses into one row whose summary reports several
 * rounds at once. That is the folding the review is about: a row must belong to
 * one round. Each round's rows are put back in order, keeping the round's own
 * restore point, thinking and tool group as the rows they already are.
 */
function splitRunsByRound(rows: readonly ChatRow[]): ChatRow[] {
    return rows.flatMap((row) => {
        if (!isExplorationRun(row)) return [row]
        const perRound = row._rounds.map((round) => {
            const roundRows: ChatRow[] = [...(round.checkpoint ? [round.checkpoint] : []), ...round.entries]
            return roundRows.length > 0 ? roundRows : []
        })
        // A round that contributed nothing would vanish; keep the run's own row.
        return perRound.some((roundRows) => roundRows.length === 0) ? [row] : perRound.flat()
    })
}

/**
 * The reviewed folding policy used by the folding stories.
 *
 * This is the policy the chat should render at. It keeps every completion and
 * safety rule of `utils/activityFolds.ts` and changes two things:
 *
 * 1. `message_segment` also cuts where the request round changes. The shipped
 *    level merges activity across request rounds and only cuts at assistant
 *    messages, so one block reports several rounds of work.
 * 2. A row whose own members span several request rounds — an exploration run or
 *    browser session that joined read-only rounds — is not folded at the message
 *    level, because it cannot honour the round boundary.
 *
 * The block lifetime is the renderer's: the stories keep a fold's header visible
 * while it is open, so the same header closes it again.
 */

type ChatRow = UiMessage | UiMessage[]

export interface DesignFoldOptions {
    readonly level: AggressiveRenderingLevel
    /** The ask the footer is answering right now; it stays visible whatever its row says. */
    readonly activeAskTs?: number
}

/** Tool rows that render as assistant updates (working_respond and phase_report). */
const ASSISTANT_TOOLS = new Set<string>(["actModeRespond", "statusUpdate"] satisfies UiSayTool["tool"][])

/**
 * How the policy treats a row.
 *
 * - `user`: a message the user wrote; folds never cross it and never take it in.
 * - `turn_end`: a turn-ending interaction; it ends a turn and stays outside.
 * - `assistant`: a communication boundary in message mode, a member in turn mode.
 * - `splitter`: still running, failed, or a restore point the user checked out;
 *   never folded, and it cuts the block it would sit in.
 * - `activity`: everything else.
 */
export type DesignRowKind = "user" | "turn_end" | "assistant" | "splitter" | "activity"

/** Fold finished rows into blocks at the requested level. */
export function foldRows(rows: ChatRow[], options: DesignFoldOptions, context: FoldContext): ChatRow[] {
    if (options.level === "none") return rows
    const kinds = rows.map((row, index) => classifyRow(row, index === rows.length - 1, options, context))
    const rounds = roundOfRows(rows, kinds, context)
    const ended = endedRows(rows, kinds, rounds)
    const spansRounds = rows.map((row) => groupSpansRounds(row, context))
    const hasContent = rows.map((row) => rowHasRoundContent(row, context))
    const spans = foldingSpans(kinds, rounds, ended, spansRounds, hasContent, options.level)
    const kind: ActivityFoldKind = options.level === "message_segment" ? "segment" : "turn"
    return applySpans(rows, spans, (span) => buildFold(rows.slice(span.start, span.end), kind, context))
}

export function classifyRow(row: ChatRow, isLastRow: boolean, options: DesignFoldOptions, context: FoldContext): DesignRowKind {
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

function isSplitterMessage(message: UiMessage, options: DesignFoldOptions, context: FoldContext): boolean {
    if (message.ts === options.activeAskTs) return true
    if (message.say === "checkpoint_created" && message.isCheckpointCheckedOut) return true
    // A restore point attached to this tool row carries the control the reader needs.
    if (context.checkedOutOwners.has(message.ts)) return true
    const state = rowState(message, context)
    if (state === "live") return true
    if (state === "settled") return false
    return !isFoldableWorkEnd(message, context)
}

/** A group is only as finished as its least finished member. */
function isSplitterGroup(group: UiMessage[], isLastRow: boolean, options: DesignFoldOptions, context: FoldContext): boolean {
    // The error row that ended a failed browser session is not one of its members.
    if (isBrowserSession(group) && group._end === "failed") return true
    if (isLastRow && group.at(-1)?.type === "ask") return true
    return group.some((message) => isSplitterMessage(message, options, context))
}

function isFoldable(kind: DesignRowKind): boolean {
    return kind === "activity" || kind === "assistant"
}

function isRestorePoint(row: ChatRow): boolean {
    return !Array.isArray(row) && row.say === "checkpoint_created"
}

/**
 * The request round each row belongs to.
 *
 * A group takes the latest round among its members. A restore point is written
 * before the request it protects, so it heads the round of the row after it; as
 * the last row it heads a round that has drawn nothing yet.
 */
function roundOfRows(rows: readonly ChatRow[], kinds: readonly DesignRowKind[], context: FoldContext): number[] {
    const rounds = rows.map((row) => memberRound(row, context))
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (!isRestorePoint(rows[index])) continue
        const next = index + 1
        if (next === rows.length) rounds[index] += 1
        else if (kinds[next] !== "user" && kinds[next] !== "turn_end") rounds[index] = rounds[next]
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
 * Whether one row's own messages belong to several request rounds.
 *
 * Standard grouping joins consecutive read-only rounds into one exploration run,
 * so such a row cannot be folded at the message level without merging rounds the
 * level exists to keep apart.
 */
function groupSpansRounds(row: ChatRow, context: FoldContext): boolean {
    if (!Array.isArray(row)) return false
    let lowest = Number.POSITIVE_INFINITY
    let highest = Number.NEGATIVE_INFINITY
    for (const member of row) {
        if (member.say === "checkpoint_created") continue
        const round = context.rounds.get(member.ts)
        if (round === undefined || round === 0) continue
        lowest = Math.min(lowest, round)
        highest = Math.max(highest, round)
    }
    return highest > lowest
}

/** Whether the row itself holds a message from a known request round, not only restore points. */
function rowHasRoundContent(row: ChatRow, context: FoldContext): boolean {
    const members = Array.isArray(row) ? row : [row]
    return members.some((member) => member.say !== "checkpoint_created" && (context.rounds.get(member.ts) ?? 0) > 0)
}

/**
 * Whether each row's round has ended: a later round has drawn a row, or a settled
 * turn end follows. A settled turn end is written only after the turn's tool
 * execution drained, so everything before it is finished work.
 */
function endedRows(rows: readonly ChatRow[], kinds: readonly DesignRowKind[], rounds: readonly number[]): boolean[] {
    const ended = new Array<boolean>(rows.length).fill(false)
    let latestRoundAhead = Number.NEGATIVE_INFINITY
    let settledTurnEndAhead = false
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        ended[index] = settledTurnEndAhead || latestRoundAhead > rounds[index]
        const row = rows[index]
        if (!Array.isArray(row) && isSettledTurnEnd(row)) settledTurnEndAhead = true
        if (kinds[index] !== "user") latestRoundAhead = Math.max(latestRoundAhead, rounds[index])
    }
    return ended
}

/** A half-open range `[start, end)` of row indexes that folds into one block. */
interface Span {
    readonly start: number
    readonly end: number
}

function foldingSpans(
    kinds: readonly DesignRowKind[],
    rounds: readonly number[],
    ended: readonly boolean[],
    spansRounds: readonly boolean[],
    hasContent: readonly boolean[],
    level: Exclude<AggressiveRenderingLevel, "none">,
): Span[] {
    const spans: Span[] = []
    let start = -1
    let blockRound = 0
    let blockHasContent = false
    let inUserTurn = false
    // A block of restore points alone reads as a header hiding a single marker.
    const close = (end: number) => {
        if (start >= 0 && blockHasContent) spans.push({ start, end })
        start = -1
        blockRound = 0
        blockHasContent = false
    }
    for (let index = 0; index < kinds.length; index += 1) {
        const kind = kinds[index]
        if (kind === "user" || kind === "turn_end") {
            close(index)
            inUserTurn = kind === "user"
            continue
        }
        const eligible = level === "message_segment" ? kind === "activity" && !spansRounds[index] : inUserTurn && isFoldable(kind)
        if (!eligible || !ended[index] || rounds[index] === 0) {
            close(index)
            continue
        }
        // The message level keeps each block inside one request round.
        if (level === "message_segment" && start >= 0 && rounds[index] !== blockRound) close(index)
        if (start < 0) {
            start = index
            blockRound = rounds[index]
        }
        if (hasContent[index]) blockHasContent = true
    }
    close(kinds.length)
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
    // Round-start restore points precede their request, so their raw index belongs
    // to the previous round. Count content, not these leading markers.
    fold._roundCount = new Set(
        fold
            .filter((member) => member.say !== "checkpoint_created")
            .map((member) => context.rounds.get(member.ts))
            .filter((round) => round !== undefined && round > 0),
    ).size
    // Failure counts are fixed at build time, exactly as the production fold does,
    // so the story renders the same header the transcript would.
    const failures = new Map<FoldFailureKind, number>()
    const failedMemberTs = new Set<number>()
    for (const member of fold) {
        const failureKind = failedWorkKind(member, context)
        if (!failureKind) continue
        failures.set(failureKind, (failures.get(failureKind) ?? 0) + failedWorkUnits(member, context))
        failedMemberTs.add(member.ts)
    }
    if (failures.size > 0) {
        fold._failures = failures
        fold._failedMemberTs = failedMemberTs
    }
    return fold
}
