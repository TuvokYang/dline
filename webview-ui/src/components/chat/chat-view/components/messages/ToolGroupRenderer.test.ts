import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { formatWorkspaceDisplayPath } from "@/utils/workspaceDisplayPath"
import {
    buildToolsWithReasoning,
    formatScale,
    formatSearchTerms,
    getActivityText,
    getToolDisplayInfo,
    getToolGroupSummaryFromParsedTools,
} from "./ToolGroupRenderer"

const readToolMessage = (ts: number, type: "ask" | "say", path: string, range?: { start: number; end: number }): UiMessage => ({
    ts,
    type,
    ...(type === "ask" ? { ask: "tool" as const } : { say: "tool" as const }),
    text: JSON.stringify({
        tool: "readFile",
        path,
        ...(range ? { readLineStart: range.start, readLineEnd: range.end } : {}),
    }),
})

describe("buildToolsWithReasoning", () => {
    it("replaces an immediately-following read approval ask with the completed read", () => {
        const tools = buildToolsWithReasoning([
            readToolMessage(1, "ask", "src/a.ts"),
            readToolMessage(2, "say", "src/a.ts", { start: 1, end: 20 }),
        ])

        expect(tools).toHaveLength(1)
        expect(tools[0].tool.say).toBe("tool")
        expect(tools[0].parsedTool.readLineStart).toBe(1)
        expect(tools[0].parsedTool.readLineEnd).toBe(20)
    })

    // An approval row is written when the dialog is revealed, which is not
    // necessarily next to the result row it belongs to. Matching by path keeps
    // the pair collapsed instead of reporting one read as two files.
    it("collapses an approval and its result even when another row sits between them", () => {
        const tools = buildToolsWithReasoning([
            readToolMessage(1, "ask", "src/a.ts"),
            { ts: 2, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "src/b.ts" }) },
            readToolMessage(3, "say", "src/a.ts", { start: 1, end: 20 }),
        ])

        expect(tools).toHaveLength(2)
        expect(tools.map((tool) => tool.parsedTool.path)).toEqual(["src/a.ts", "src/b.ts"])
        expect(tools[0].tool.say).toBe("tool")
    })

    // The result row carries the timestamp of the tool block while the approval
    // row is anchored when the dialog is revealed, so the result can sort first.
    it("collapses the pair when the result row precedes its approval row", () => {
        const tools = buildToolsWithReasoning([
            readToolMessage(1, "say", "src/a.ts", { start: 1, end: 3 }),
            readToolMessage(2, "ask", "src/a.ts"),
        ])

        expect(tools).toHaveLength(1)
        expect(tools[0].tool.say).toBe("tool")
        expect(tools[0].parsedTool.readLineEnd).toBe(3)
    })

    it("keeps separate reads of the same file when they are distinct operations", () => {
        const tools = buildToolsWithReasoning([
            readToolMessage(1, "ask", "src/a.ts"),
            readToolMessage(2, "say", "src/a.ts", { start: 1, end: 20 }),
            readToolMessage(3, "ask", "src/a.ts"),
            readToolMessage(4, "say", "src/a.ts", { start: 40, end: 60 }),
        ])

        expect(tools).toHaveLength(2)
        expect(tools.map((tool) => [tool.parsedTool.readLineStart, tool.parsedTool.readLineEnd])).toEqual([
            [1, 20],
            [40, 60],
        ])
    })

    it("keeps result-first pairs separate for repeated reads of the same file", () => {
        const tools = buildToolsWithReasoning([
            readToolMessage(1, "say", "src/a.ts", { start: 1, end: 20 }),
            readToolMessage(2, "ask", "src/a.ts"),
            readToolMessage(3, "say", "src/a.ts", { start: 40, end: 60 }),
            readToolMessage(4, "ask", "src/a.ts"),
        ])

        expect(tools).toHaveLength(2)
        expect(tools.map((tool) => [tool.parsedTool.readLineStart, tool.parsedTool.readLineEnd])).toEqual([
            [1, 20],
            [40, 60],
        ])
    })
})

describe("getToolGroupSummaryFromParsedTools", () => {
    it("counts rendered read tools once after ask/say collapse", () => {
        const tools = buildToolsWithReasoning([
            readToolMessage(1, "ask", "src/a.ts"),
            readToolMessage(2, "say", "src/a.ts", { start: 1, end: 20 }),
        ])

        expect(getToolGroupSummaryFromParsedTools(tools.map((tool) => tool.parsedTool))).toBe("Dline read 1 file")
    })
})

describe("formatSearchTerms", () => {
    it("quotes a single term identically in both forms", () => {
        expect(formatSearchTerms("toolResult")).toEqual({
            displayText: '"toolResult"',
            tooltipText: '"toolResult"',
        })
    })

    it("joins alternation terms with a separator", () => {
        expect(formatSearchTerms("describe|it|expect").displayText).toBe('"describe | it | expect"')
    })

    it("collapses the overflow into a count instead of dropping the terms", () => {
        expect(formatSearchTerms("describe|it|expect|vi|beforeEach")).toEqual({
            displayText: '"describe | it | expect +2"',
            tooltipText: '"describe | it | expect | vi | beforeEach"',
        })
    })

    it("strips word-boundary and optional-space regex syntax", () => {
        expect(formatSearchTerms("\\bfoo\\b|bar\\s?baz").tooltipText).toBe('"foo | bar baz"')
    })

    it("drops empty alternation branches", () => {
        expect(formatSearchTerms("foo||bar").tooltipText).toBe('"foo | bar"')
    })
})

describe("formatScale", () => {
    it("returns nothing when the count is unknown", () => {
        expect(formatScale(undefined, 3, "match")).toBe("")
    })

    it("reports zero matches without a file count", () => {
        expect(formatScale(0, 0, "match")).toBe(" (0 matches)")
    })

    it("uses the singular unit for exactly one hit", () => {
        expect(formatScale(1, 1, "match")).toBe(" (1 match · 1 file)")
    })

    it("pluralizes both the unit and the file count", () => {
        expect(formatScale(14, 5, "match")).toBe(" (14 matches · 5 files)")
    })

    it("uses the reference unit label", () => {
        expect(formatScale(12, 3, "ref")).toBe(" (12 refs · 3 files)")
    })

    it("marks a capped count as a lower bound and keeps the plural unit", () => {
        expect(formatScale(300, 42, "match", true)).toBe(" (300+ matches · 42 files)")
    })

    it("omits the file part when the file count is unknown", () => {
        expect(formatScale(4, undefined, "ref")).toBe(" (4 refs)")
    })
})

describe("getToolDisplayInfo workspace paths", () => {
    const multiRoot = (path: string) =>
        formatWorkspaceDisplayPath(path, {
            workspaceRoots: [
                { path: "/home/dev/frontend", name: "frontend" },
                { path: "/home/dev/backend", name: "backend" },
            ],
            primaryRootIndex: 0,
        })

    it("shows the folder-relative path but still opens the reported one", () => {
        const info = getToolDisplayInfo({ tool: "readFile", path: "/home/dev/backend/src/b.ts" } as UiSayTool, multiRoot)

        expect(info?.displayText).toBe("backend/src/b.ts")
        expect(info?.tooltipText).toBe("backend/src/b.ts")
        expect(info?.path).toBe("/home/dev/backend/src/b.ts")
    })

    it("formats a listed folder and an in-flight search the same way", () => {
        const listed = getToolDisplayInfo({ tool: "listFilesTopLevel", path: "src" } as UiSayTool, multiRoot)
        const searching = getActivityText(
            { tool: "searchFiles", path: "/home/dev/backend/src", regex: "needle" } as UiSayTool,
            multiRoot,
        )

        expect(listed?.displayText).toBe("frontend/src/")
        expect(listed?.path).toBe("src/")
        expect(searching?.row?.path).toBe("backend/src/")
    })
})

describe("getToolDisplayInfo", () => {
    it("names the symbol, its file and the reference scale", () => {
        const tool = {
            tool: "findReferences",
            path: "src/core/task/ToolExecutor.ts",
            symbolName: "ToolExecutor",
            count: 12,
            files: 3,
        } as UiSayTool

        expect(getToolDisplayInfo(tool)).toMatchObject({
            displayText: '"ToolExecutor" in src/core/task/ToolExecutor.ts (12 refs · 3 files)',
            tooltipText: '"ToolExecutor" in src/core/task/ToolExecutor.ts (12 refs · 3 files)',
        })
    })

    it("falls back to a generic reference target when the symbol is unknown", () => {
        const tool = { tool: "findReferences", path: "src/a.ts" } as UiSayTool

        expect(getToolDisplayInfo(tool)).toMatchObject({
            displayText: "references in src/a.ts",
            tooltipText: "references in src/a.ts",
        })
    })

    it("keeps search terms and adds the match scale", () => {
        const tool = {
            tool: "searchFiles",
            path: "src/core/prompts",
            regex: "describe|it|expect|vi|beforeEach",
            filePattern: "*.test.ts",
            count: 300,
            files: 42,
            truncated: true,
        } as UiSayTool

        expect(getToolDisplayInfo(tool)).toMatchObject({
            displayText: '"describe | it | expect +2" in src/core/prompts/ (*.test.ts) (300+ matches · 42 files)',
            tooltipText: '"describe | it | expect | vi | beforeEach" in src/core/prompts/ (*.test.ts) (300+ matches · 42 files)',
        })
    })

    it("omits the file pattern when it matches everything", () => {
        const tool = { tool: "searchFiles", path: "src", regex: "toolResult", filePattern: "*" } as UiSayTool

        expect(getToolDisplayInfo(tool)?.displayText).toBe('"toolResult" in src/')
    })

    it("keeps a complete read path with an independently protected line range", () => {
        const tool = {
            tool: "readFile",
            path: "src/core/task/tools/handlers/ReadFileToolHandler.ts",
            readLineStart: 125,
            readLineEnd: 416,
        } as UiSayTool

        expect(getToolDisplayInfo(tool)).toMatchObject({
            displayText: "src/core/task/tools/handlers/ReadFileToolHandler.ts · lines 125-416",
            tooltipText: "src/core/task/tools/handlers/ReadFileToolHandler.ts · lines 125-416",
            row: {
                path: "src/core/task/tools/handlers/ReadFileToolHandler.ts",
                suffix: "lines 125-416",
                suffixSeparator: " · ",
            },
        })
    })

    it("renders a directory listing with its trailing slash", () => {
        const tool = { tool: "listFilesRecursive", path: "src/core/task/tools" } as UiSayTool

        expect(getToolDisplayInfo(tool)).toMatchObject({
            displayText: "src/core/task/tools/",
            tooltipText: "src/core/task/tools/",
        })
    })

    it("returns null for tools that have no row representation", () => {
        expect(getToolDisplayInfo({ tool: "webFetch" } as UiSayTool)).toBeNull()
    })
})

describe("getActivityText", () => {
    it("describes an in-flight reference lookup instead of rendering nothing", () => {
        const tool = { tool: "findReferences", path: "src/core/task/ToolExecutor.ts" } as UiSayTool

        expect(getActivityText(tool)).toMatchObject({
            displayText: "Finding references in src/core/task/ToolExecutor.ts...",
            tooltipText: "Finding references in src/core/task/ToolExecutor.ts",
            row: { prefix: "Finding references", path: "src/core/task/ToolExecutor.ts", suffix: "" },
        })
    })

    it("presents in-flight search terms the same way as the completed entry", () => {
        const tool = {
            tool: "searchFiles",
            path: "src/core/prompts",
            regex: "describe|it|expect|vi|beforeEach",
            filePattern: "*.test.ts",
        } as UiSayTool

        const active = getActivityText(tool)
        const completed = getToolDisplayInfo(tool)

        expect(active?.displayText).toBe(`Searching ${completed?.displayText}...`)
        expect(active?.tooltipText).toBe(`Searching ${completed?.tooltipText}`)
    })

    it("preserves known scale metadata in active search and reference rows", () => {
        for (const tool of [
            { tool: "searchFiles", path: "src", regex: "needle", count: 4, files: 2 },
            { tool: "findReferences", path: "src/a.ts", symbolName: "MySymbol", count: 4, files: 2 },
        ] satisfies UiSayTool[]) {
            expect(getActivityText(tool)?.row?.suffix).toBe(getToolDisplayInfo(tool)?.row?.suffix)
            expect(getActivityText(tool)?.tooltipText).toContain("4 ")
        }
    })

    it("has no text for a tool without a path", () => {
        expect(getActivityText({ tool: "readFile" } as UiSayTool)).toBeNull()
    })
})
