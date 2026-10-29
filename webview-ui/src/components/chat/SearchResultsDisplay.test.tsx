import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import SearchResultsDisplay from "./SearchResultsDisplay"

void React

describe("SearchResultsDisplay height boundary", () => {
    it("caps expanded multi-workspace results at 60vh", () => {
        const content = [
            "Found 2 results across 2 workspaces.",
            "## Workspace: first",
            "src/first.ts:1:first result",
            "## Workspace: second",
            "src/second.ts:2:second result",
        ].join("\n")

        render(<SearchResultsDisplay content={content} isExpanded onToggleExpand={vi.fn()} path="src" />)

        expect(screen.getByTestId("multi-workspace-search-scroll")).toHaveClass(
            "max-h-[60vh]",
            "overflow-y-auto",
            "overscroll-x-contain",
        )
    })
})
