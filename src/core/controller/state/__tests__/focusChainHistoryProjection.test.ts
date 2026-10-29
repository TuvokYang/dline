import { describe, expect, it } from "vitest"
import { MAX_PROJECTED_FOCUS_CHAIN_ENTRIES, projectFocusChainHistory } from "../focusChainHistoryProjection"

/**
 * The focus chain history file is append-only and was projected into state in
 * full, so every state push rebroadcast the entire history. Field logs showed
 * ~12.5 MB payloads repeating several times a second across concurrent tasks,
 * with the extension host serializing each one on the main thread.
 *
 * The webview parses this text into entries delimited by `## Completed`
 * headings, so these tests pin that the projection cuts on those boundaries —
 * a byte-level cut would leave a partial entry that renders as a truncated
 * checklist rather than as absent history.
 */

const HEADER = "# Focus Chain History for Task task-1\n\n"

function entry(index: number, itemCount = 1): string {
    const items = Array.from({ length: itemCount }, (_, item) => `- [x] entry ${index} item ${item}`).join("\n")
    return `## Completed — 2026-08-2${index % 10} 10:00:00 UTC+8\n# Title ${index}\n${items}\n\n`
}

function buildHistory(entryCount: number, itemsPerEntry = 1): string {
    return HEADER + Array.from({ length: entryCount }, (_, index) => entry(index, itemsPerEntry)).join("")
}

describe("focus chain history projection", () => {
    it("passes a short history through untouched", () => {
        const history = buildHistory(3)

        const projection = projectFocusChainHistory(history)

        expect(projection.text).toBe(history)
        expect(projection.truncated).toBe(false)
    })

    it("reports no history rather than an empty string when there is none", () => {
        expect(projectFocusChainHistory(null)).toEqual({ text: null, truncated: false })
        expect(projectFocusChainHistory(undefined)).toEqual({ text: null, truncated: false })
        expect(projectFocusChainHistory("")).toEqual({ text: null, truncated: false })
    })

    it("keeps the newest entries when the history exceeds the limit", () => {
        const projection = projectFocusChainHistory(buildHistory(30), 5)

        expect(projection.truncated).toBe(true)
        // Newest five kept, everything older dropped.
        expect(projection.text).toContain("# Title 29")
        expect(projection.text).toContain("# Title 25")
        expect(projection.text).not.toContain("# Title 24")
    })

    /**
     * The cut must land on an entry boundary. A projection starting mid-entry
     * would render as a checklist missing its heading and items, which is worse
     * than showing fewer entries.
     */
    it("starts the projection at an entry heading", () => {
        const projection = projectFocusChainHistory(buildHistory(30), 5)

        expect(projection.text?.startsWith("## Completed")).toBe(true)
    })

    it("keeps every entry it retains complete", () => {
        const projection = projectFocusChainHistory(buildHistory(30, 4), 3)

        // Each retained entry keeps its heading, title and all four items.
        expect(projection.text?.match(/## Completed/g)).toHaveLength(3)
        expect(projection.text?.match(/entry 29 item \d/g)).toHaveLength(4)
    })

    /**
     * The parser discards anything before the first entry heading, so the file
     * header is not content the webview would miss. Counting it against the
     * limit, or keeping it, would only add bytes.
     */
    it("drops the file header when truncating", () => {
        const projection = projectFocusChainHistory(buildHistory(30), 5)

        expect(projection.text).not.toContain("Focus Chain History for Task")
    })

    /**
     * A checklist item may legitimately quote the heading text. Treating that
     * as a boundary would split one entry into two and lose the items above it.
     */
    it("treats a heading only at line start as an entry boundary", () => {
        const history =
            HEADER +
            "## Completed — 2026-08-21 10:00:00 UTC+8\n# Only entry\n- [x] mentions ## Completed inline\n- [x] second item\n"

        const projection = projectFocusChainHistory(history, 1)

        expect(projection.truncated).toBe(false)
        expect(projection.text).toContain("second item")
    })

    it("reduces the payload by orders of magnitude for a long-running task", () => {
        // Roughly the shape of a task that ran long enough to be reported.
        const history = buildHistory(500, 20)
        const projection = projectFocusChainHistory(history)

        expect(projection.truncated).toBe(true)
        expect(projection.text!.length).toBeLessThan(history.length / 10)
    })

    it("defaults to a bounded number of entries", () => {
        const projection = projectFocusChainHistory(buildHistory(MAX_PROJECTED_FOCUS_CHAIN_ENTRIES + 10))

        expect(projection.truncated).toBe(true)
        expect(projection.text?.match(/## Completed/g)).toHaveLength(MAX_PROJECTED_FOCUS_CHAIN_ENTRIES)
    })

    it("keeps a history exactly at the limit intact", () => {
        const history = buildHistory(MAX_PROJECTED_FOCUS_CHAIN_ENTRIES)

        const projection = projectFocusChainHistory(history)

        expect(projection.truncated).toBe(false)
        expect(projection.text).toBe(history)
    })
})
