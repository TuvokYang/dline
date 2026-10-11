import assert from "node:assert/strict"
import type { TextLineRange } from "@integrations/misc/read-text-line-range"
import { DlineDefaultTool } from "@shared/tools"
import { describe, it } from "vitest"
import {
    DEFAULT_MAX_LINES,
    formatFileContentWithLineNumbers,
    formatTextLineRange,
    getReadToolDisplayedLineRange,
} from "../ReadFileToolHandler"

describe("getReadToolDisplayedLineRange", () => {
    const block = (start?: string, end?: string) => ({
        type: "tool_use" as const,
        function_id: "test_read_range",
        dline_tid: "test_read_range_tid",
        name: DlineDefaultTool.FILE_READ,
        params: {
            path: "f.txt",
            ...(start !== undefined ? { start_line: start } : {}),
            ...(end !== undefined ? { end_line: end } : {}),
        },
        partial: false,
        ts: Date.now(),
    })

    it("matches the slice shown for explicit start/end", () => {
        const text = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n")
        const r = getReadToolDisplayedLineRange(block("3", "5"), { text })
        assert.deepEqual(r, { start: 3, end: 5 })
    })

    it("returns undefined for image reads", () => {
        const r = getReadToolDisplayedLineRange(block(), {
            text: "ok",
            imageBlock: { type: "image", source: { type: "url", url: "x" } } as any,
        })
        assert.equal(r, undefined)
    })
})

describe("formatFileContentWithLineNumbers", () => {
    describe("line labels", () => {
        it("adds 1-indexed line prefixes", () => {
            const result = formatFileContentWithLineNumbers("alpha\nbeta")
            assert.ok(result.startsWith("1 | alpha\n2 | beta"))
        })

        it("does not add an extra numbered line for trailing newline", () => {
            const result = formatFileContentWithLineNumbers("alpha\nbeta\n")
            assert.ok(result.startsWith("1 | alpha\n2 | beta"))
            assert.ok(!result.includes("3 |"))
        })

        it("returns empty content unchanged", () => {
            const result = formatFileContentWithLineNumbers("")
            assert.equal(result, "")
        })
    })

    describe("chunked reads", () => {
        const tenLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
        const oversizedContent = Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, i) => `line${i + 1}`).join("\n")

        it("defaults to reading from line 1 and applies the default chunk size", () => {
            const result = formatFileContentWithLineNumbers(oversizedContent)
            assert.ok(result.startsWith("1 | line1\n"))
            assert.ok(result.includes(`${DEFAULT_MAX_LINES} | line${DEFAULT_MAX_LINES}`))
            assert.ok(!result.includes(`${DEFAULT_MAX_LINES + 1} |`))
            assert.ok(result.includes(`Showing lines 1-${DEFAULT_MAX_LINES} of ${DEFAULT_MAX_LINES + 10} total`))
            assert.ok(result.includes(`start_line=${DEFAULT_MAX_LINES + 1}`))
        })

        it("respects start_line parameter", () => {
            const result = formatFileContentWithLineNumbers(tenLines, 5)
            assert.ok(result.startsWith("5 | line5\n"))
            assert.ok(!result.includes("4 |"))
        })

        it("respects start_line and end_line parameters", () => {
            const result = formatFileContentWithLineNumbers(tenLines, 3, 5)
            assert.ok(result.startsWith("3 | line3\n"))
            assert.ok(result.includes("4 | line4\n"))
            assert.ok(result.includes("5 | line5"))
            assert.ok(!result.includes("2 |"))
            assert.ok(!result.includes("6 |"))
        })

        it("normalizes inverted start_line and end_line parameters", () => {
            const result = formatFileContentWithLineNumbers(tenLines, 5, 3)
            assert.ok(result.startsWith("3 | line3\n"))
            assert.ok(result.includes("4 | line4\n"))
            assert.ok(result.includes("5 | line5"))
            assert.ok(!result.includes("2 |"))
            assert.ok(!result.includes("6 |"))
        })

        it("clamps start_line to 1 if below", () => {
            const result = formatFileContentWithLineNumbers(tenLines, -5, 3)
            assert.ok(result.startsWith("1 | line1\n"))
        })

        it("clamps end_line to total lines if beyond", () => {
            const result = formatFileContentWithLineNumbers(tenLines, 8, 999)
            assert.ok(result.includes("10 | line10"))
            assert.ok(!result.includes("11 |"))
        })
    })

    describe("continuation hints", () => {
        const tenLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")

        it("shows continuation hint when more lines remain", () => {
            const result = formatFileContentWithLineNumbers(tenLines, 1, 5)
            assert.ok(result.includes("Showing lines 1-5 of 10 total"))
            assert.ok(result.includes("start_line=6"))
        })

        it("shows total-lines footer when entire file is returned", () => {
            const result = formatFileContentWithLineNumbers(tenLines, 1, 10)
            assert.ok(result.includes("File has 10 lines total"))
        })

        it("shows total-lines footer when file fits within default limit", () => {
            const result = formatFileContentWithLineNumbers(tenLines)
            assert.ok(result.includes("File has 10 lines total"))
        })
    })

    describe("default max lines", () => {
        const bigContent = Array.from({ length: DEFAULT_MAX_LINES + 500 }, (_, i) => `row${i + 1}`).join("\n")

        it("limits output to DEFAULT_MAX_LINES when no end_line given", () => {
            const result = formatFileContentWithLineNumbers(bigContent)
            assert.ok(result.includes(`1 | row1`))
            assert.ok(result.includes(`${DEFAULT_MAX_LINES} | row${DEFAULT_MAX_LINES}`))
            assert.ok(!result.includes(`${DEFAULT_MAX_LINES + 1} |`))
            assert.ok(result.includes(`start_line=${DEFAULT_MAX_LINES + 1}`))
        })

        it("caps an explicit end_line at the per-read line limit", () => {
            const requestedEnd = DEFAULT_MAX_LINES + 200
            const result = formatFileContentWithLineNumbers(bigContent, 1, requestedEnd)
            assert.ok(result.includes(`${DEFAULT_MAX_LINES} | row${DEFAULT_MAX_LINES}`))
            assert.ok(!result.includes(`${DEFAULT_MAX_LINES + 1} |`))
            assert.ok(result.includes(`start_line=${DEFAULT_MAX_LINES + 1}`))
        })
    })

    describe("byte truncation interaction", () => {
        it("preserves truncation notice without numbering it", () => {
            const input = "alpha\nbeta\n\n---\n\n[OUTPUT TRUNCATED: showed the first part of 1.0 MB; the limit is 400.0 KB.]"
            const result = formatFileContentWithLineNumbers(input)
            assert.ok(result.startsWith("1 | alpha\n2 | beta"))
            assert.ok(result.includes("[OUTPUT TRUNCATED: showed the first part of 1.0 MB; the limit is 400.0 KB.]"))
            assert.ok(!result.includes("3 |"))
        })
    })
})

describe("formatTextLineRange", () => {
    function range(overrides: Partial<TextLineRange>): TextLineRange {
        return {
            startLine: 1,
            lines: [
                { text: "alpha", omittedBytes: 0 },
                { text: "beta", omittedBytes: 0 },
            ],
            endLine: 2,
            stop: "end_of_file",
            totalLines: 2,
            scannedLines: 2,
            ...overrides,
        }
    }

    it("labels lines and reports the total when the read reached the end", () => {
        assert.equal(formatTextLineRange(range({})), "1 | alpha\n2 | beta\n\n(File has 2 lines total.)")
    })

    it("points to the next line when the total is known", () => {
        const result = formatTextLineRange(range({ stop: "max_lines", totalLines: 10, scannedLines: 10 }))
        assert.ok(result.endsWith("(Showing lines 1-2 of 10 total. Use start_line=3 to continue reading.)"))
    })

    it("states only a lower bound when the scan stopped before the end", () => {
        const result = formatTextLineRange(
            range({ startLine: 50_000, endLine: 50_001, stop: "max_lines", totalLines: undefined, scannedLines: 90_000 }),
        )
        assert.ok(result.startsWith("50000 | alpha\n50001 | beta"))
        assert.ok(result.includes("(Showing lines 50000-50001 of at least 90000. Use start_line=50002 to continue reading.)"))
    })

    it("explains a read cut short by the size budget", () => {
        const result = formatTextLineRange(range({ stop: "max_bytes", totalLines: 10, scannedLines: 10 }))
        assert.ok(result.includes("stopped early to stay within the result size limit"))
        assert.ok(result.includes("Use start_line=3 to continue reading."))
    })

    it("marks a cut line and suggests searching inside it", () => {
        const result = formatTextLineRange(range({ lines: [{ text: "aaaa", omittedBytes: 1_000 }], endLine: 1, totalLines: 1 }))
        assert.ok(result.startsWith("1 | aaaa …[line cut: 1000 more bytes]"))
        assert.ok(result.includes("1 long line(s) were cut"))
    })

    it("says so when the start line is past the end or too large to reach, and keeps an empty file empty", () => {
        assert.equal(
            formatTextLineRange(range({ startLine: 10, lines: [], endLine: 9, totalLines: 3, scannedLines: 3 })),
            "(start_line=10 is past the end of the file, which has 3 lines.)",
        )
        assert.equal(formatTextLineRange(range({ lines: [], endLine: 0, totalLines: 0, scannedLines: 0 })), "")
        assert.ok(
            formatTextLineRange(
                range({
                    startLine: 9_000_000,
                    lines: [],
                    endLine: 8_999_999,
                    stop: "scan_limit",
                    totalLines: undefined,
                    scannedLines: 1_000,
                }),
            ).includes("too large to read that far"),
        )
    })

    it("does not point past a scan limit that a follow-up read would hit again", () => {
        const result = formatTextLineRange(range({ stop: "scan_limit", totalLines: undefined, scannedLines: 2 }))
        assert.ok(result.includes("(Showing lines 1-2 of at least 2. The file is too large to read past this line"))
        assert.ok(!result.includes("start_line=3"))
    })
})
