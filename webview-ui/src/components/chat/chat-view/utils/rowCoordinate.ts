import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * Origin for the row coordinate reported to the virtual list.
 *
 * Loading older history moves the origin backwards, so it starts far enough
 * from zero that a long browsing session cannot walk it negative.
 */
export const ROW_INDEX_BASE = 1_000_000

/**
 * One row of the chat transcript together with the coordinate bookkeeping
 * needed to recognise it again after the loaded window moves.
 */
export interface RowCoordinate {
    firstItemIndex: number
    identities: string[]
}

/** Identify a virtual row by its stable logical owner, falling back to membership for ordinary groups. */
export function rowIdentity(row: UiMessage | UiMessage[]): string {
    if (!Array.isArray(row)) return String(row.ts)
    const group = row as UiMessage[] & { _toolGroupId?: string; _explorationRunId?: string; _browserSessionId?: string }
    return group._explorationRunId ?? group._toolGroupId ?? group._browserSessionId ?? row.map((message) => message.ts).join(",")
}

/**
 * Smallest number of rows that must agree on a displacement before it is used.
 *
 * One or two rows landing at the same offset can happen by chance, and acting
 * on a wrong offset moves every remembered height onto the wrong row.
 */
const MIN_AGREEING_ROWS = 3

/** Marks an identity that appears more than once and so cannot locate a row. */
const AMBIGUOUS = -1

/**
 * Measure how far the previously known rows moved within the new list.
 *
 * Returns the number of rows inserted ahead of them — negative when rows were
 * dropped from the front — or null when nothing recognisable remains, which
 * means the previous measurements describe rows that are no longer present.
 *
 * Comparing the ends does not work here: the newest row changes on every token
 * of a streaming reply, and the oldest changes whenever history loads, so
 * either end can differ for reasons that say nothing about the other. Instead
 * this looks up where known rows ended up and requires several of them to
 * agree on the same displacement, which separates a window that slid from one
 * that was rebuilt.
 *
 * @param previous Row identities as of the last committed coordinate.
 * @param next Row identities being rendered now.
 * @returns Rows inserted ahead of the known rows, or null when unrecognisable.
 */
export function leadingRowShift(previous: readonly string[], next: readonly string[]): number | null {
    if (previous.length === 0 || next.length === 0) return null

    const positions = new Map<string, number>()
    for (const [index, identity] of next.entries()) {
        // A duplicate identity cannot locate anything. Marking it rather than
        // keeping the first occurrence stops an ambiguous match from being
        // counted as agreement.
        if (positions.has(identity)) positions.set(identity, AMBIGUOUS)
        else positions.set(identity, index)
    }

    const shiftCounts = new Map<number, number>()
    for (const [previousIndex, identity] of previous.entries()) {
        const nextIndex = positions.get(identity)
        if (nextIndex === undefined || nextIndex === AMBIGUOUS) continue
        const shift = nextIndex - previousIndex
        shiftCounts.set(shift, (shiftCounts.get(shift) ?? 0) + 1)
    }

    let bestShift: number | null = null
    let bestCount = 0
    for (const [shift, count] of shiftCounts) {
        if (count > bestCount) {
            bestShift = shift
            bestCount = count
        }
    }

    return bestCount >= MIN_AGREEING_ROWS ? bestShift : null
}

/**
 * Advance the row coordinate to describe the rows being rendered now.
 *
 * When the change cannot be recognised the coordinate is held still. Resetting
 * it would itself be a large jump — the list would read it as the whole window
 * moving — and that is the very thing this coordinate exists to prevent. A
 * stale coordinate costs at most a re-measure; a wrong one moves the view.
 *
 * @param previous Last committed coordinate.
 * @param rows Rows being rendered now, in display order.
 * @returns Coordinate describing the rows now on screen.
 */
export function advanceRowCoordinate(previous: RowCoordinate, rows: readonly (UiMessage | UiMessage[])[]): RowCoordinate {
    const identities = rows.map(rowIdentity)
    const shift = leadingRowShift(previous.identities, identities)
    const firstItemIndex = shift === null ? previous.firstItemIndex : previous.firstItemIndex - shift
    return { firstItemIndex, identities }
}
