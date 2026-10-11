import { describe, expect, it } from "vitest"
import { boundToolText, MAX_TOOL_RESULT_TEXT_BYTES, TRUNCATION_MARKER_PREFIX, truncateContent } from "./content-limits"

const bytes = (text: string) => Buffer.byteLength(text, "utf8")

function numberedLines(count: number, width: number, last?: string): string {
    const lines = Array.from({ length: count }, (_, index) => `line ${index + 1} `.padEnd(width, "x"))
    if (last !== undefined) lines[count - 1] = last
    return lines.join("\n")
}

describe("content limits", () => {
    it("enforces the complete UTF-8 byte limit including the truncation marker", () => {
        const maxBytes = 1_024
        const result = truncateContent("😀".repeat(2_000), maxBytes)

        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(maxBytes)
        expect(result).toContain(TRUNCATION_MARKER_PREFIX)
        expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result)
    })
})

describe("boundToolText", () => {
    it("returns the joined parts unchanged when they fit", () => {
        const result = boundToolText({ header: "status", body: "a\nb", trailer: "done" }, { strategy: "headTail" })

        expect(result).toBe("status\na\nb\ndone")
    })

    it("keeps the status line, log path, and last error line of a long failing command", () => {
        const errorLine = "Error: build failed at step 600"
        const result = boundToolText(
            {
                header: "Command failed with exit code 1.\nFull output saved to: /tmp/command-logs/run.log",
                body: numberedLines(600, 1024, errorLine),
            },
            { strategy: "headTail", hint: "read the saved log for the omitted lines" },
        )

        // Boolean assertions keep a failure report from dumping the 64 KB result.
        expect(bytes(result)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
        expect(result.startsWith("Command failed with exit code 1.\nFull output saved to: /tmp/command-logs/run.log\n")).toBe(
            true,
        )
        expect(result.endsWith(`\n${errorLine}`)).toBe(true)
        expect(result.includes("\nline 1 ")).toBe(true)
        expect(
            /\n\[OUTPUT TRUNCATED: showed [\d.]+ KB of 599\.\d KB; read the saved log for the omitted lines\]\n/.test(result),
        ).toBe(true)
    })

    it("keeps whole lines on both sides of the notice for headTail", () => {
        const result = boundToolText({ body: numberedLines(200, 100) }, { strategy: "headTail", maxBytes: 4_096 })
        const [head, tail] = result.split(/\n\[OUTPUT TRUNCATED:[^\]]*\]\n/)

        expect(bytes(result)).toBeLessThanOrEqual(4_096)
        for (const line of [...head.split("\n"), ...tail.split("\n")]) {
            expect(line).toMatch(/^line \d+ x+$/)
            expect(line).toHaveLength(100)
        }
        expect(tail.endsWith("line 200 ".padEnd(100, "x"))).toBe(true)
    })

    it("keeps whole leading lines and the trailer for the lines strategy", () => {
        const trailer = "[Showing lines 1-200. Use start_line=201 to continue.]"
        const result = boundToolText(
            { body: numberedLines(200, 100), trailer },
            { strategy: "lines", maxBytes: 4_096, hint: "narrow the range" },
        )

        expect(bytes(result)).toBeLessThanOrEqual(4_096)
        expect(result.endsWith(`; narrow the range]\n${trailer}`)).toBe(true)
        const kept = result.slice(0, result.indexOf("\n[OUTPUT TRUNCATED:")).split("\n")
        expect(kept[0]).toMatch(/^line 1 x+$/)
        for (const line of kept) expect(line).toHaveLength(100)
    })

    it("cuts the head strategy at the byte budget without splitting a code point", () => {
        const result = boundToolText({ body: "😀".repeat(4_000) }, { strategy: "head", maxBytes: 1_000 })

        expect(bytes(result)).toBeLessThanOrEqual(1_000)
        expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result)
        expect(result).toContain("[OUTPUT TRUNCATED:")
    })

    it("caps a runaway header so the body still gets room", () => {
        const result = boundToolText(
            { header: "h".repeat(20_000), body: numberedLines(500, 100) },
            { strategy: "lines", maxBytes: 16_384 },
        )

        expect(bytes(result)).toBeLessThanOrEqual(16_384)
        expect(result).toContain("line 1 ")
    })

    it("cuts long lines only once the body does not fit", () => {
        const longLine = "j".repeat(10_000)
        const fits = boundToolText({ body: `short\n${longLine}` }, { strategy: "headTail", maxLineBytes: 100 })
        const overflows = boundToolText(
            { body: [longLine, ...numberedLines(50, 100).split("\n"), longLine].join("\n") },
            { strategy: "headTail", maxBytes: 8_192, maxLineBytes: 100 },
        )

        expect(fits).toBe(`short\n${longLine}`)
        expect(bytes(overflows)).toBeLessThanOrEqual(8_192)
        expect(overflows.includes("[line cut: 9.7 KB omitted]")).toBe(true)
        expect(overflows.includes("line 25 ")).toBe(true)
        expect(overflows.includes("[OUTPUT TRUNCATED:")).toBe(false)
    })

    it("stays within a budget smaller than its frame", () => {
        const result = boundToolText({ header: "status", body: "x".repeat(1_000) }, { strategy: "headTail", maxBytes: 20 })

        expect(bytes(result)).toBeLessThanOrEqual(20)
    })

    it("keeps the trailer when only the frame fits", () => {
        const trailer = "Log: /tmp/command.log"
        const result = boundToolText(
            { header: "h".repeat(400), body: "x".repeat(5_000), trailer },
            { strategy: "headTail", maxBytes: 120 },
        )

        expect(bytes(result)).toBeLessThanOrEqual(120)
        expect(result.endsWith(trailer)).toBe(true)
    })

    it("stays within the budget when the kept size is wider than the full size", () => {
        // 1.0 MB of body; the kept part renders as e.g. "1023.5 KB", wider than "1.0 MB".
        const body = "y\n".repeat(512 * 1024)
        for (const maxBytes of [1_000_000, 1_040_000, 1_048_000]) {
            const result = boundToolText({ body }, { strategy: "head", maxBytes })
            expect(bytes(result)).toBeLessThanOrEqual(maxBytes)
        }
    })
})
