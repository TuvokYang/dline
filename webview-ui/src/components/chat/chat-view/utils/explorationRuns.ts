import type { UiMessage } from "@shared/ExtensionMessage"
import { type ExplorationRound, type ExplorationRun, isToolGroup, type ToolMessageGroup } from "./chatRowKinds"
import { isRoundStartCheckpoint, restoresSameFiles } from "./checkpointRows"

type ChatRow = UiMessage | UiMessage[]

/** The rows one request round contributed, collected before deciding whether the round folds. */
interface RoundUnit {
    /** The rows exactly as grouping produced them, drawn unchanged when the round does not fold. */
    readonly rows: ChatRow[]
    readonly checkpoint?: UiMessage
    readonly entries: (UiMessage | ToolMessageGroup)[]
    hasTools: boolean
}

/** A run is worth drawing only when it replaces more than one row. */
const MIN_FOLDED_ROWS = 2

/**
 * Fold consecutive read-only rounds into exploration runs.
 *
 * Every request round writes a restore point, so a stretch of reads renders as
 * restore point, thinking and tool list for each round. A round is read-only
 * when it holds nothing but its round checkpoint, reasoning and one low-stakes
 * tool group. Consecutive read-only rounds fold into one run while their
 * restore points describe the same files.
 *
 * What stays a row of its own:
 * - anything else, which ends the run: prose, a file-changing tool, a command,
 *   an approval, an error, user input or a turn-ending interaction;
 * - rounds before the first and after the last round that called a tool, so a
 *   round still thinking stays visible until it shows what it does;
 * - a lone tool group with nothing to fold into it.
 *
 * Input is the output of `groupLowStakesTools`, whose tool groups already hold
 * exactly one round each.
 */
export function groupExplorationRuns(rows: readonly ChatRow[]): ChatRow[] {
    const result: ChatRow[] = []
    let units: RoundUnit[] = []
    let current: RoundUnit | undefined

    const closeUnit = () => {
        if (current) units.push(current)
        current = undefined
    }
    const flushUnits = () => {
        closeUnit()
        result.push(...foldUnits(units))
        units = []
    }

    for (const row of rows) {
        if (isRoundCheckpoint(row)) {
            closeUnit()
            current = { rows: [row], checkpoint: row, entries: [], hasTools: false }
            continue
        }
        if (isReasoning(row) || isQuietToolGroup(row)) {
            // A tool group closes its round: whatever follows belongs to a later one.
            if (!current || current.hasTools) {
                closeUnit()
                current = { rows: [], entries: [], hasTools: false }
            }
            current.rows.push(row)
            current.entries.push(row)
            if (isToolGroup(row)) current.hasTools = true
            continue
        }
        flushUnits()
        result.push(row)
    }
    flushUnits()
    return result
}

/** Split the rounds between two breaking rows into runs and standalone rows. */
function foldUnits(units: readonly RoundUnit[]): ChatRow[] {
    const result: ChatRow[] = []
    let index = 0
    while (index < units.length) {
        const start = units.findIndex((unit, position) => position >= index && unit.hasTools)
        if (start === -1) {
            result.push(...rowsOf(units.slice(index)))
            break
        }
        result.push(...rowsOf(units.slice(index, start)))

        let reference = units[start].checkpoint
        let end = start
        for (let cursor = start + 1; cursor < units.length; cursor++) {
            const candidate = units[cursor]
            if (!canJoin(candidate, reference)) break
            reference ??= candidate.checkpoint
            if (candidate.hasTools) end = cursor
        }
        result.push(...buildRun(units.slice(start, end + 1)))
        index = end + 1
    }
    return result
}

/**
 * A round joins a run while its restore point brings back the same files as the
 * run's, and while it is not the restore point the user checked out: that one
 * must stay visible, so it can only head a run.
 */
function canJoin(unit: RoundUnit, reference: UiMessage | undefined): boolean {
    const checkpoint = unit.checkpoint
    if (!checkpoint) return true
    if (checkpoint.isCheckpointCheckedOut) return false
    return !reference || restoresSameFiles(reference, checkpoint)
}

function buildRun(units: readonly RoundUnit[]): ChatRow[] {
    const rows = rowsOf(units)
    if (rows.length < MIN_FOLDED_ROWS) return rows

    const members = rows.flatMap((row) => (Array.isArray(row) ? row : [row]))
    const rounds: ExplorationRound[] = units.map((unit) => ({
        ...(unit.checkpoint ? { checkpoint: unit.checkpoint } : {}),
        entries: unit.entries,
    }))
    const run = members as ExplorationRun
    run._isExplorationRun = true
    run._explorationRunId = `explore:${members[0].ts}`
    run._rounds = rounds
    return [run]
}

function rowsOf(units: readonly RoundUnit[]): ChatRow[] {
    return units.flatMap((unit) => unit.rows)
}

function isRoundCheckpoint(row: ChatRow): row is UiMessage {
    return !Array.isArray(row) && isRoundStartCheckpoint(row)
}

function isReasoning(row: ChatRow): row is UiMessage {
    return !Array.isArray(row) && row.say === "reasoning"
}

/** A tool group whose request failed shows that failure, so it cannot be folded away. */
function isQuietToolGroup(row: ChatRow): row is ToolMessageGroup {
    return isToolGroup(row) && !row.some(isFailedRequest)
}

function isFailedRequest(message: UiMessage): boolean {
    if (message.say !== "api_req_started") return false
    try {
        return Boolean(JSON.parse(message.text || "{}").streamingFailedMessage)
    } catch {
        return true
    }
}
