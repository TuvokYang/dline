import { describe, expect, it } from "vitest"
import { renderCapabilitiesSection } from "../CapabilitiesSection"
import type { CapabilitiesSnapshot } from "../types"

const EMPTY: CapabilitiesSnapshot = { mcp: [], skills: [], workflows: [], subagents: [] }

describe("renderCapabilitiesSection", () => {
    it("lists each server's MCP tools under that server with their full advertised names", () => {
        const section = renderCapabilitiesSection({
            ...EMPTY,
            mcp: [
                { name: "docs.search", description: "Search docs", server: "docs" },
                { name: "otel.query_logs", description: "Query logs", server: "otel" },
                { name: "docs.fetch", description: "Fetch a page", server: "docs" },
            ],
        })

        expect(section).toContain(
            [
                "- Server `docs` (tools: 2):",
                "  - `docs.search`: Search docs",
                "  - `docs.fetch`: Fetch a page",
                "- Server `otel` (tools: 1):",
                "  - `otel.query_logs`: Query logs",
            ].join("\n"),
        )
    })

    it("keeps MCP descriptions to one bounded line", () => {
        const section = renderCapabilitiesSection({
            ...EMPTY,
            mcp: [{ name: "docs.search", description: `Search\n\ndocs ${"x".repeat(400)}`, server: "docs" }],
        })
        const toolLine = section.split("\n").find((line) => line.startsWith("  - `docs.search`:")) ?? ""

        expect(toolLine).toContain("Search docs")
        expect(toolLine.length).toBeLessThanOrEqual("  - `docs.search`: ".length + 240)
    })

    it("leaves capabilities without a server as a flat list", () => {
        const section = renderCapabilitiesSection({
            ...EMPTY,
            skills: [{ name: "review", description: "Review changes" }],
        })

        expect(section).toContain("- `review`: Review changes")
        expect(section).not.toContain("Server")
    })
})
