import { describe, expect, it } from "vitest"
import { parseSearchStats } from "../SearchFilesToolHandler"

/**
 * Build output shaped like formatResults in src/services/ripgrep: a header, a
 * blank line, then per file a path line, a separator, the context lines, and a
 * closing separator followed by a blank line.
 */
function formattedOutput(header: string, files: string[]): string {
    const blocks = files.map((file) => `${file}\n│----\n1 | match\n│----\n`)
    return `${header}\n\n${blocks.join("\n")}`.trim()
}

describe("parseSearchStats", () => {
    it("reads the match count and file count from a complete result set", () => {
        const output = formattedOutput("Found 3 results.", ["src/a.ts", "src/b.ts"])

        expect(parseSearchStats(output)).toEqual({ matches: 3, files: 2, truncated: false })
    })

    it("reads a single-result header", () => {
        const output = formattedOutput("Found 1 result.", ["src/a.ts"])

        expect(parseSearchStats(output)).toEqual({ matches: 1, files: 1, truncated: false })
    })

    it("strips thousands separators from the match count", () => {
        const output = formattedOutput("Found 1,234 results.", ["src/a.ts"])

        expect(parseSearchStats(output)).toMatchObject({ matches: 1234, truncated: false })
    })

    it("marks a capped result set as truncated", () => {
        const output = formattedOutput("Showing first 300 of 300+ results. Use a more specific search if necessary.", [
            "src/a.ts",
            "src/b.ts",
            "src/c.ts",
        ])

        expect(parseSearchStats(output)).toEqual({ matches: 300, files: 3, truncated: true })
    })

    it("reports zero matches without inventing files", () => {
        expect(parseSearchStats("Found 0 results.\n\n")).toEqual({ matches: 0, files: 0, truncated: false })
    })

    it("leaves counts undefined when the output is not a formatted result set", () => {
        const failure =
            "Search failed: unable to search in /repo/src. This may be caused by ripgrep not being available or the search path not being accessible."

        expect(parseSearchStats(failure)).toEqual({ truncated: false })
    })

    it("leaves counts undefined for the no-results prompt text", () => {
        expect(parseSearchStats("No results found")).toEqual({ truncated: false })
    })
})
