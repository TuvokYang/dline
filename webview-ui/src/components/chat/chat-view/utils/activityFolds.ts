import type { AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import { type FoldRoundUsage, summarizeRoundsUsage } from "@shared/chat/foldUsage"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import {
    type ActivityFold,
    type ActivityFoldKind,
    type FoldFailureKind,
    isActivityFold,
    isBrowserSession,
    isExplorationRun,
} from "./chatRowKinds"
import { type FoldContext, failedWorkKind, failedWorkUnits, isFoldableWorkEnd, rowState } from "./foldContext"
import { isSettledTurnEnd, isTurnEndRow } from "./turnEndRows"

type ChatRow = UiMessage | UiMessage[]

export interface FoldOptions {
    readonly level: AggressiveRenderingLevel
    /** The ask the footer is answering right now; it stays visible whatever its row says. */
    readonly activeAskTs?: number
    /**
     * The usage record of each provider round, in request-round order.
     *
     * The chat has no such records projected to it yet, so it omits this and the
     * header states no figures. Stories and tests pass fixture records to exercise
     * the same code path a projected transcript will use.
     */
    readonly roundUsage?: readonly FoldRoundUsage[]
}

export const STANDARD_FOLD: FoldOptions = { level: "none" }

/**
 * What each folding level does, in one table.
 *
 * Every level runs the same fold step; only these four facts differ, so a level
 * can never silently mean something different from the one next to it.
 *
 * - `rounds`: which request rounds one block may hold. `single` keeps a block
 *   inside one round; `any` lets it merge finished rounds the way the coarser
 *   levels always have.
 * - `userTurnOnly`: whether nothing before the first user message of a run folds.
 * - `cutsAtAssistant`: whether prose and assistant updates end the block they
 *   would otherwise join.
 * - `splitsCrossRoundRuns`: whether a row whose own members span several rounds
 *   (an exploration run of read-only rounds) is put back into one row per round
 *   instead of being folded whole.
 */
interface FoldPolicy {
    readonly rounds: "single" | "any"
    readonly userTurnOnly: boolean
    readonly cutsAtAssistant: boolean
    readonly splitsCrossRoundRuns: boolean
}

export const FOLD_POLICIES: Record<Exclude<AggressiveRenderingLevel, "none">, FoldPolicy> = {
    round: { rounds: "single", userTurnOnly: true, cutsAtAssistant: true, splitsCrossRoundRuns: true },
    message_segment: { rounds: "any", userTurnOnly: false, cutsAtAssistant: true, splitsCrossRoundRuns: false },
    user_turn: { rounds: "any", userTurnOnly: true, cutsAtAssistant: false, splitsCrossRoundRuns: false },
}

/** Whether a level's blocks keep to one request round. */
export function foldsWithinOneRound(level: AggressiveRenderingLevel): boolean {
    return level !== "none" && FOLD_POLICIES[level].rounds === "single"
}

/**
 * How the fold step treats a row.
 *
 * - `user`: a message the user wrote; folds never cross it and never take it in.
 * - `turn_end`: a turn-ending interaction; it ends a turn and stays outside.
 * - `assistant`: a communication boundary in message mode, a member in turn mode.
 * - `splitter`: a row that is still running, failed in a way the block cannot
 *   account for, or is a restore point the user checked out; it is never folded
 *   and cuts the block it would sit in.
 * - `activity`: everything else, including a failed edit, command or subagent,
 *   which folds into the block and is counted there.
 */
export type FoldRowClass = "user" | "turn_end" | "assistant" | "splitter" | "activity"

/** Tool rows that render as assistant updates (working_respond and phase_report). */
const ASSISTANT_TOOLS = new Set<string>(["actModeRespond", "statusUpdate"] satisfies UiSayTool["tool"][])

/**
 * Fold eligible Standard rows without regrouping their members. Request rounds
 * determine completion, never block boundaries. Message segments stop at prose,
 * replies and phase reports; user turns include those messages. Live rows and
 * checked-out restore points split both modes; a failed edit, command or
 * subagent does not. Leading partial rounds stay visible.
 */
export function foldActivity(rows: ChatRow[], options: FoldOptions, context: FoldContext): ChatRow[] {
    if (options.level === "none") return rows
    const policy = FOLD_POLICIES[options.level]
    const prepared = policy.splitsCrossRoundRuns ? splitCrossRoundRuns(rows) : rows
    const classes = prepared.map((row, index) => classifyFoldRow(row, index === prepared.length - 1, options, context))
    const rounds = roundOfRows(prepared, classes, context)
    const ended = endedRows(prepared, classes, rounds)
    const spans = foldingSpans(prepared, classes, rounds, ended, policy)
    const kind = options.level === "user_turn" ? "turn" : "segment"
    const folded = applySpans(prepared, spans, (span) => buildFold(prepared.slice(span.start, span.end), kind, context))
    return options.roundUsage ? attachUsage(folded, context.rounds, options.roundUsage) : folded
}

/**
 * Attach each block the usage of the request rounds it holds.
 *
 * A block's members belong to request rounds, so the figures are looked up by
 * those rounds rather than summed from message payloads. A block whose rounds
 * have no record states no figures instead of guessing.
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

/** Map a transcript round index onto its usage record, in provider-send order. */
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
 * Put a row that joined several read-only rounds back into one row per round.
 *
 * Standard grouping folds consecutive read-only rounds into a single exploration
 * run, so that one row cannot honour a level whose blocks stay inside one round.
 * A run whose rounds would contribute nothing keeps its own row, so no work
 * disappears.
 */
function splitCrossRoundRuns(rows: readonly ChatRow[]): ChatRow[] {
    return rows.flatMap((row) => {
        if (!isExplorationRun(row)) return [row]
        const perRound = row._rounds.map((round) => {
            const roundRows: ChatRow[] = [...(round.checkpoint ? [round.checkpoint] : []), ...round.entries]
            return roundRows
        })
        return perRound.some((roundRows) => roundRows.length === 0) ? [row] : perRound.flat()
    })
}

/**
 * The rows a fold holds, for callers that must reach a member through a block.
 *
 * The list never expands by projection: an open block keeps its header and draws
 * its members beneath it, so one row stays one row and the control that opened it
 * closes it again. This is only a view for lookups.
 */
export function foldChildren(row: ChatRow): readonly ChatRow[] {
    return isActivityFold(row) ? row._children : [row]
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
    const state = rowState(message, context)
    // A row that is still running is never finished work, so it can neither join
    // a block nor be hidden behind it.
    if (state === "live") return true
    // A finished edit, command or subagent is one work item inside the turn, so
    // it stays in the block whether it succeeded, failed or was cancelled. Any
    // other failure is why the turn stopped; hiding it behind a header would
    // misreport the transcript.
    if (state === "settled") return false
    return !isFoldableWorkEnd(message, context)
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
        else if (classes[next] === "turn_end") {
            // A restore point whose round drew nothing but its own turn end still
            // opens that round: the turn it protects must stay foldable, or its
            // Restore control would be left with no block to live in.
            const ending = rows[next]
            if (!Array.isArray(ending)) rounds[index] = memberRound(ending, context)
        } else if (classes[next] !== "user") rounds[index] = rounds[next]
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
    rows: readonly ChatRow[],
    classes: readonly FoldRowClass[],
    rounds: readonly number[],
    ended: readonly boolean[],
    policy: FoldPolicy,
): Span[] {
    const spans: Span[] = []
    let start = -1
    let blockRound = 0
    let inUserTurn = false
    // A block is kept even when it holds only a restore point: the reader must be
    // able to reach that checkpoint, and a turn whose work was a single marker
    // would otherwise lose its Restore control behind no block at all.
    const close = (end: number) => {
        if (start >= 0) spans.push({ start, end })
        start = -1
        blockRound = 0
    }
    for (let index = 0; index < classes.length; index += 1) {
        const kind = classes[index]
        if (kind === "user" || kind === "turn_end") {
            close(index)
            inUserTurn = kind === "user"
            continue
        }
        const eligible = policy.cutsAtAssistant
            ? kind === "activity" && (!policy.userTurnOnly || inUserTurn)
            : policy.userTurnOnly
              ? inUserTurn && isFoldable(kind)
              : isFoldable(kind)
        if (!eligible || !ended[index] || rounds[index] === 0) {
            close(index)
            continue
        }
        // A level whose blocks stay inside one request round cuts at every round change.
        if (policy.rounds === "single" && start >= 0 && rounds[index] !== blockRound) close(index)
        if (start < 0) {
            start = index
            blockRound = rounds[index]
        }
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
    const failures = new Map<FoldFailureKind, number>()
    const failedMemberTs = new Set<number>()
    for (const member of fold) {
        const kind = failedWorkKind(member, context)
        if (!kind) continue
        failures.set(kind, (failures.get(kind) ?? 0) + failedWorkUnits(member, context))
        failedMemberTs.add(member.ts)
    }
    if (failures.size > 0) {
        fold._failures = failures
        fold._failedMemberTs = failedMemberTs
    }
    return fold
}
