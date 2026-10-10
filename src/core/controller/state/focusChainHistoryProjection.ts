/**
 * Bounds the focus chain history carried in every state push.
 *
 * The history file is append-only and was projected into state in full, so a
 * long-running task rebroadcast its entire history on every update. Field logs
 * showed pushes around 12.5 MB repeating several times a second across
 * concurrent tasks, with the main thread serializing each one.
 *
 * The webview parses this text into entries delimited by `## Completed`
 * headings and ignores everything before the first one, so the projection is
 * cut on those same boundaries: a byte-level cut would leave a partial entry
 * that renders as a truncated checklist rather than as absent history.
 */

/** Entry heading the webview parser uses to start a new history entry. */
const ENTRY_HEADING = "## Completed"

/**
 * How many of the most recent entries reach the webview.
 *
 * The panel shows history newest-first inside a scroll region, so the entries
 * beyond this are reachable only by scrolling through a payload that costs
 * every task a full serialization. The complete history stays on disk and is
 * still opened directly from the panel.
 */
export const MAX_PROJECTED_FOCUS_CHAIN_ENTRIES = 20

export interface FocusChainHistoryProjection {
    /** History text to publish, or null when there is nothing to show. */
    text: string | null
    /** True when older entries were left out of this projection. */
    truncated: boolean
}

/**
 * Keeps the newest entries of a focus chain history for publication.
 *
 * Content before the first entry heading is a file header the webview parser
 * already discards, so it is dropped rather than counted against the limit.
 */
export function projectFocusChainHistory(
    history: string | null | undefined,
    maxEntries: number = MAX_PROJECTED_FOCUS_CHAIN_ENTRIES,
): FocusChainHistoryProjection {
    if (!history) {
        return { text: null, truncated: false }
    }

    const entryStarts = findEntryStarts(history)
    if (entryStarts.length <= maxEntries) {
        return { text: history, truncated: false }
    }

    const firstKept = entryStarts[entryStarts.length - maxEntries]
    return { text: history.slice(firstKept), truncated: true }
}

/**
 * Locates each entry heading at the start of a line.
 *
 * Matching only at line start keeps a checklist item that happens to quote the
 * heading from being read as an entry boundary.
 */
function findEntryStarts(history: string): number[] {
    const starts: number[] = []
    let searchFrom = 0

    while (searchFrom <= history.length) {
        const index = history.indexOf(ENTRY_HEADING, searchFrom)
        if (index === -1) {
            break
        }
        const isLineStart = index === 0 || history[index - 1] === "\n"
        if (isLineStart) {
            starts.push(index)
        }
        searchFrom = index + ENTRY_HEADING.length
    }

    return starts
}
