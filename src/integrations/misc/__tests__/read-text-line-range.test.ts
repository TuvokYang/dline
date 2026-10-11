import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as iconv from "iconv-lite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readTextLineRange, type TextLineRangeRequest } from "../read-text-line-range"

const LINE_BYTES = 200

/** One fixed-width line per number, so line N starts at byte (N - 1) * LINE_BYTES. */
function fixedWidthLines(count: number): Buffer {
    const lines = Array.from({ length: count }, (_, index) => `L${index + 1}`.padEnd(LINE_BYTES - 1, "x"))
    return Buffer.from(`${lines.join("\n")}\n`, "utf8")
}

const generous: Omit<TextLineRangeRequest, "startLine"> = { maxLines: 1000, maxBytes: 1024 * 1024, maxLineBytes: 64 * 1024 }

describe("readTextLineRange", () => {
    let dir: string

    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), "dline-read-range-"))
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    async function file(name: string, content: Buffer | string): Promise<string> {
        const filePath = path.join(dir, name)
        await writeFile(filePath, content)
        return filePath
    }

    it.each([
        ["10 MB", 52_428],
        ["25 MB", 131_072],
    ])("reads lines deep inside a %s file that a whole-file read would cut off", async (_label, lineCount) => {
        const filePath = await file("large.log", fixedWidthLines(lineCount))

        const range = await readTextLineRange(filePath, { ...generous, startLine: 50_000, maxLines: 85 })

        expect(range.lines).toHaveLength(85)
        expect(range.lines[0].text.startsWith("L50000x")).toBe(true)
        expect(range.lines[84].text.startsWith("L50084x")).toBe(true)
        expect(range.endLine).toBe(50_084)
        expect(range.stop).toBe("max_lines")
        expect(range.scannedLines).toBeGreaterThanOrEqual(50_084)
        if (range.totalLines !== undefined) expect(range.totalLines).toBe(lineCount)
    })

    it("reports the total once the lookahead reaches the end, and only a lower bound otherwise", async () => {
        const filePath = await file("count.log", fixedWidthLines(5_000))

        const counted = await readTextLineRange(filePath, { ...generous, startLine: 1, maxLines: 10 })
        expect(counted.totalLines).toBe(5_000)

        const bounded = await readTextLineRange(filePath, {
            ...generous,
            startLine: 1,
            maxLines: 10,
            countLookaheadBytes: 64 * 1024,
        })
        expect(bounded.totalLines).toBeUndefined()
        expect(bounded.scannedLines).toBeGreaterThanOrEqual(10)
        expect(bounded.scannedLines).toBeLessThan(5_000)
    })

    it("cuts a minified line to the per-line limit and accounts for what it dropped", async () => {
        const minified = "a".repeat(1024 * 1024)
        const filePath = await file("bundle.min.js", `${minified}\nnext line\n`)

        const range = await readTextLineRange(filePath, { ...generous, startLine: 1, maxLineBytes: 2048 })

        expect(range.lines).toEqual([
            { text: "a".repeat(2048), omittedBytes: 1024 * 1024 - 2048 },
            { text: "next line", omittedBytes: 0 },
        ])
        expect(range.totalLines).toBe(2)
    })

    it("keeps multi-byte characters whole and strips CRLF line endings", async () => {
        const filePath = await file("text.txt", "héllo\r\n世界世界\r\n🙂end")

        const whole = await readTextLineRange(filePath, { ...generous, startLine: 1 })
        expect(whole.lines.map((line) => line.text)).toEqual(["héllo", "世界世界", "🙂end"])
        expect(whole.totalLines).toBe(3)

        const cut = await readTextLineRange(filePath, { ...generous, startLine: 2, maxLines: 1, maxLineBytes: 7 })
        expect(cut.lines).toEqual([{ text: "世界", omittedBytes: 6 }])
    })

    it("decodes a UTF-16 file detected from its head", async () => {
        const filePath = await file("utf16.txt", Buffer.from("\ufeffalpha\r\nbeta\r\n", "utf16le"))

        const range = await readTextLineRange(filePath, { ...generous, startLine: 1 })

        expect(range.lines.map((line) => line.text)).toEqual(["alpha", "beta"])
    })

    it("numbers lines like a whole-file read around trailing and blank lines", async () => {
        const filePath = await file("blank.txt", "a\n\n")

        const range = await readTextLineRange(filePath, { ...generous, startLine: 1 })

        expect(range.lines.map((line) => line.text)).toEqual(["a", ""])
        expect(range.totalLines).toBe(2)
    })

    it("returns no lines and the real total when the start line is past the end", async () => {
        const filePath = await file("short.txt", "one\ntwo\nthree\n")

        const range = await readTextLineRange(filePath, { ...generous, startLine: 10 })

        expect(range.lines).toEqual([])
        expect(range.endLine).toBe(9)
        expect(range.stop).toBe("end_of_file")
        expect(range.totalLines).toBe(3)
    })

    it("treats an empty file as having no lines", async () => {
        const filePath = await file("empty.txt", "")

        const range = await readTextLineRange(filePath, { ...generous, startLine: 1 })

        expect(range).toMatchObject({ lines: [], stop: "end_of_file", totalLines: 0 })
    })

    it("stops at the byte budget, counting each line's prefix, but always returns the first line", async () => {
        const filePath = await file("budget.txt", fixedWidthLines(100))

        const range = await readTextLineRange(filePath, {
            startLine: 1,
            maxLines: 100,
            maxBytes: 1_000,
            maxLineBytes: 1_000,
            lineOverheadBytes: (lineNumber) => `${lineNumber} | `.length,
        })

        // Each line costs 199 bytes, a break, and a 4-byte label: four lines fit in 1000 bytes.
        expect(range.lines).toHaveLength(4)
        expect(range.stop).toBe("max_bytes")
        expect(range.endLine).toBe(4)

        const single = await readTextLineRange(filePath, { startLine: 1, maxLines: 100, maxBytes: 50, maxLineBytes: 50 })
        expect(single.lines).toHaveLength(1)
        expect(single.lines[0].omittedBytes).toBe(LINE_BYTES - 1 - 50)
    })

    it("stops scanning at the scan limit instead of walking an arbitrarily large file", async () => {
        const filePath = await file("huge.log", fixedWidthLines(10_000))

        const range = await readTextLineRange(filePath, { ...generous, startLine: 9_000, maxScanBytes: 64 * 1024 })

        expect(range.lines).toEqual([])
        expect(range.stop).toBe("scan_limit")
        expect(range.totalLines).toBeUndefined()
        expect(range.scannedLines).toBeLessThan(9_000)
    })

    it("omits the rest of a cut line instead of splicing a later fragment onto the kept prefix", async () => {
        // "中" ends exactly at the first 64 KB chunk and does not fit the line limit; "z\r" arrives in the next chunk.
        const filePath = await file("cut.txt", `${"a".repeat(65_533)}中z\r\nnext\r\n`)

        const range = await readTextLineRange(filePath, { ...generous, startLine: 1, maxLineBytes: 65_535 })

        expect(range.lines[0].text === "a".repeat(65_533)).toBe(true)
        expect(range.lines[0].omittedBytes).toBe(4)
        expect(range.lines[1]).toEqual({ text: "next", omittedBytes: 0 })
    })

    it("charges the caller's overhead for a cut line against the byte budget", async () => {
        const filePath = await file("overhead.txt", "abcdefghij\nxy\n")
        const calls: Array<[number, number]> = []

        const range = await readTextLineRange(filePath, {
            ...generous,
            startLine: 1,
            maxBytes: 106,
            maxLineBytes: 4,
            lineOverheadBytes: (lineNumber, omittedBytes) => {
                calls.push([lineNumber, omittedBytes])
                return omittedBytes > 0 ? 100 : 0
            },
        })

        expect(calls[0]).toEqual([1, 6])
        expect(range.lines).toEqual([{ text: "abcd", omittedBytes: 6 }])
        expect(range.stop).toBe("max_bytes")
    })

    it("decodes a legacy encoding that first appears after a plain ASCII head", async () => {
        const chinese = "这是一段用于检测编码的中文文本，包含常见的汉字与标点符号。".repeat(40)
        const content = Buffer.concat([Buffer.from(`${"a".repeat(70_000)}\n`, "ascii"), iconv.encode(`${chinese}\n`, "gbk")])
        const filePath = await file("legacy.txt", content)

        const range = await readTextLineRange(filePath, { ...generous, startLine: 2 })

        expect(range.lines[0].text === chinese).toBe(true)
    })

    it("rejects a cancelled read", async () => {
        const filePath = await file("cancel.txt", fixedWidthLines(10))
        const controller = new AbortController()
        controller.abort()

        await expect(readTextLineRange(filePath, { ...generous, startLine: 1, signal: controller.signal })).rejects.toThrow(
            "Read cancelled",
        )
    })
})
