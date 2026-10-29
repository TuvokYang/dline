import { describe, expect, it } from "vitest"
import { compactPath, layoutToolRow, TOOL_ROW_GAP, TOOL_ROW_ICON_WIDTH, type ToolRowParts } from "./tool-row-layout"

// Deliberately proportional metrics: equal character counts do not imply equal widths.
const measure = (text: string) =>
    Array.from(text).reduce((width, character) => width + (character === "W" ? 14 : character === "i" ? 3 : 7), 0)
const iconSpace = TOOL_ROW_ICON_WIDTH + TOOL_ROW_GAP
const path = "src/core/task/tools/handlers/ReadFileToolHandler.ts"
const read: ToolRowParts = { path, suffix: "lines 125-416", suffixSeparator: " · " }

function renderedWidth(layout: ReturnType<typeof layoutToolRow>) {
    return (
        (layout.showIcon ? iconSpace : 0) +
        [layout.prefix, layout.prefixSeparator, layout.path, layout.suffixSeparator, layout.suffix].reduce(
            (sum, text) => sum + measure(text),
            0,
        )
    )
}

describe("compactPath", () => {
    it("keeps every directory when the complete path fits exactly", () => {
        expect(compactPath(path, measure(path), measure)).toBe(path)
    })

    it("retains a variable number of tail directories according to measured width", () => {
        for (const expected of [
            "…/task/tools/handlers/ReadFileToolHandler.ts",
            "…/tools/handlers/ReadFileToolHandler.ts",
            "…/handlers/ReadFileToolHandler.ts",
            "…/ReadFileToolHandler.ts",
        ]) {
            expect(compactPath(path, measure(expected), measure)).toBe(expected)
        }
    })

    it("handles Windows, absolute Unix, mixed separators and directory trailing slashes", () => {
        for (const [source, expected] of [
            ["C:\\work\\src\\test.ts", "…\\src\\test.ts"],
            ["\\\\server\\share\\dir\\test.ts", "…\\dir\\test.ts"],
            ["/home/user/src/test.ts", "…/src/test.ts"],
            ["C:\\work/src/test.ts", "…/src/test.ts"],
            ["src/core/tools/handlers/", "…/handlers/"],
        ]) {
            expect(compactPath(source, measure(expected), measure)).toBe(expected)
        }
    })

    it("drops the directory marker before abbreviating a filename and keeps its extension", () => {
        expect(compactPath(path, measure("ReadFileToolHandler.ts"), measure)).toBe("ReadFileToolHandler.ts")
        expect(compactPath("src/LongFile.tsx", measure("LongF….tsx"), measure)).toBe("LongF….tsx")
        expect(compactPath("src/a.veryLongExtension", measure("a.very…"), measure)).toBe("a.very…")
    })

    it("uses actual glyph widths, handles dotfiles and does not split surrogate pairs", () => {
        expect(compactPath("iiii.ts", 45, measure)).toBe("iiii.ts")
        expect(compactPath("WWWW.ts", 45, measure)).not.toBe("WWWW.ts")
        expect(compactPath("src/.gitignore", measure(".git…"), measure)).toBe(".git…")
        expect(compactPath("src/😀😀😀😀.ts", measure("😀😀….ts"), measure)).toBe("😀😀….ts")
    })
})

describe("layoutToolRow", () => {
    it("reserves suffixes before folding directories and restores without mutating input", () => {
        const original = { ...read }
        const wide = layoutToolRow(read, 1000, measure)
        const narrow = layoutToolRow(read, 380, measure)
        expect(wide.path).toBe(path)
        expect(narrow.path).toMatch(/^…\//)
        expect(narrow.suffix).toBe(read.suffix)
        expect(renderedWidth(narrow)).toBeLessThanOrEqual(380)
        expect(layoutToolRow(read, 1000, measure)).toEqual(wide)
        expect(read).toEqual(original)
    })

    it("shows only metadata at extreme widths without icons or orphan separators", () => {
        const layout = layoutToolRow(read, measure(read.suffix!) + 5, measure)
        expect(layout).toEqual({
            mode: "metadata-only",
            showIcon: false,
            prefix: "",
            prefixSeparator: "",
            path: "",
            suffixSeparator: "",
            suffix: "lines 125-416",
        })
        // Impossible widths preserve the original metadata rather than dropping digits.
        expect(layoutToolRow(read, 1, measure).suffix).toBe(read.suffix)
    })

    it("shrinks long search terms independently without displacing file/count metadata", () => {
        const parts = {
            prefix: "W".repeat(100),
            prefixSeparator: " in ",
            path: "src/core/tools",
            suffix: "(*.ts) (300+ matches · 42 files)",
        }
        const layout = layoutToolRow(parts, 500, measure)
        expect(layout.prefix).toMatch(/…$/)
        expect(layout.path).toContain("tools")
        expect(layout.suffix).toBe(parts.suffix)
        expect(renderedWidth(layout)).toBeLessThanOrEqual(500)
    })

    it("keeps meaningful path content when metadata is unavailable", () => {
        for (const width of [1000, 300, 150, 50]) {
            const layout = layoutToolRow({ prefix: "Exploring", path: "src/core/tools/handlers/" }, width, measure)
            expect(layout.mode).not.toBe("metadata-only")
            expect(layout.path).not.toBe("")
            expect(renderedWidth(layout)).toBeLessThanOrEqual(width)
        }
    })

    it("never over-allocates at boundary widths where the suffix itself fits", () => {
        for (const parts of [
            read,
            { prefix: "Finding references", prefixSeparator: " in ", path, suffix: "(12 refs · 3 files)" },
        ]) {
            for (let width = measure(parts.suffix!); width < 800; width += 1) {
                const layout = layoutToolRow(parts, width, measure)
                expect(layout.suffix).toBe(parts.suffix)
                expect(renderedWidth(layout)).toBeLessThanOrEqual(width)
            }
        }
    })
})
