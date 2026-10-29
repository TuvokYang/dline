import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { createContextWindowIndicatorViewModel } from "./ContextWindowIndicatorViewModel"
import { ContextWindowSummary } from "./ContextWindowSummary"

describe("ContextWindowSummary", () => {
    it("shows authoritative segment sizes from the shared indicator view model", () => {
        const indicatorViewModel = createContextWindowIndicatorViewModel({
            taskId: "task-summary",
            revision: 1,
            epoch: 1,
            phase: "receiving",
            durableContextTokens: 137_000,
            pendingSendTokens: 0,
            receivingTokens: 100,
            stagedTokens: 2_000,
            environmentTokens: 1_000,
            contextWindow: 272_000,
            mode: "act",
            updatedAt: 1,
            lineage: { kind: "baseline" },
        })
        render(
            <ContextWindowSummary
                contextWindow={indicatorViewModel.contextWindow}
                indicatorViewModel={indicatorViewModel}
                percentage={indicatorViewModel.percentage}
                tokenUsed={indicatorViewModel.totalTokens}
            />,
        )

        expect(screen.getByText("Context Window")).toBeInTheDocument()
        expect(screen.getByText("140.1k")).toBeInTheDocument()
        const metricCells = ["used", "remaining", "total"].map((metric) =>
            document.querySelector<HTMLElement>(`[data-context-summary-metric="${metric}"]`),
        )
        for (const cell of metricCells) expect(cell).toHaveClass("min-w-0", "text-center")
        expect(metricCells[0]?.parentElement).toHaveClass("grid", "grid-cols-3", "gap-2")
        const segmentDetails = screen.getByTestId("context-window-segment-details")
        for (const [kind, value, color] of [
            ["durable", "137.0k", "var(--vscode-charts-green, #3fb950)"],
            ["active", "100", "var(--vscode-charts-yellow, #d29922)"],
            ["staged", "2.0k", "var(--vscode-charts-orange, #d18616)"],
            ["environment", "1.0k", "var(--vscode-charts-purple, #bc8cff)"],
        ] as const) {
            const detail = segmentDetails.querySelector<HTMLElement>(`[data-segment-detail="${kind}"]`)
            expect(detail).toHaveTextContent(value)
            expect(detail).toHaveStyle({ backgroundColor: color })
        }
    })

    it("reserves a six-character value column for every segment card", () => {
        const indicatorViewModel = createContextWindowIndicatorViewModel({
            taskId: "task-summary-width",
            revision: 1,
            epoch: 1,
            phase: "receiving",
            durableContextTokens: 229_400,
            pendingSendTokens: 0,
            receivingTokens: 14_100,
            stagedTokens: 3_900,
            environmentTokens: 2_200,
            contextWindow: 1_000_000,
            mode: "act",
            updatedAt: 1,
            lineage: { kind: "baseline" },
        })
        render(
            <ContextWindowSummary
                contextWindow={indicatorViewModel.contextWindow}
                indicatorViewModel={indicatorViewModel}
                percentage={indicatorViewModel.percentage}
                tokenUsed={indicatorViewModel.totalTokens}
            />,
        )

        const segmentDetails = screen.getByTestId("context-window-segment-details")
        expect(segmentDetails.closest(".context-window-tooltip-content")).toHaveClass("w-full")
        for (const kind of ["durable", "active", "staged", "environment"] as const) {
            const detail = segmentDetails.querySelector<HTMLElement>(`[data-segment-detail="${kind}"]`)
            const label = detail?.querySelector<HTMLElement>("span:first-child")
            const value = detail?.querySelector<HTMLElement>(".font-mono")
            expect(detail).toHaveClass("grid", "grid-cols-[max-content_6ch]")
            expect(label).toHaveClass("whitespace-nowrap")
            expect(label).not.toHaveClass("overflow-hidden", "text-ellipsis")
            expect(value).toHaveClass("w-[6ch]", "whitespace-nowrap", "text-right")
            expect(value?.textContent?.length).toBeLessThanOrEqual(6)
        }
    })

    it("promotes rounded threshold values before they exceed six characters", () => {
        const indicatorViewModel = createContextWindowIndicatorViewModel({
            taskId: "task-summary-threshold",
            revision: 1,
            epoch: 1,
            phase: "receiving",
            durableContextTokens: 999_999,
            pendingSendTokens: 0,
            receivingTokens: 0,
            stagedTokens: 0,
            environmentTokens: 0,
            contextWindow: 1_000_000,
            mode: "act",
            updatedAt: 1,
            lineage: { kind: "baseline" },
        })
        render(
            <ContextWindowSummary
                contextWindow={indicatorViewModel.contextWindow}
                indicatorViewModel={indicatorViewModel}
                percentage={indicatorViewModel.percentage}
                tokenUsed={indicatorViewModel.totalTokens}
            />,
        )

        expect(screen.queryAllByText("1000.0k")).toHaveLength(0)
        expect(screen.getAllByText("1.000M")).toHaveLength(2)
        expect(screen.getByText("1.0M")).toBeInTheDocument()
    })
})
