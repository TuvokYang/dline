import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { createContextWindowIndicatorViewModel } from "./ContextWindowIndicatorViewModel"
import ContextWindowSegmentedProgress from "./ContextWindowSegmentedProgress"
import { ContextWindowSummary } from "./ContextWindowSummary"

const COMPOSITION = { basePrompt: 20_000, userRules: 5_000, skills: 3_000, workflows: 2_000, toolDefinitions: 10_000 }

function snapshot(overrides: Partial<ContextWindowIndicatorSnapshot> = {}): ContextWindowIndicatorSnapshot {
    return {
        taskId: "task-durable",
        revision: 1,
        epoch: 1,
        phase: "stable",
        durableContextTokens: 100_000,
        pendingSendTokens: 0,
        receivingTokens: 0,
        stagedTokens: 0,
        environmentTokens: 1_000,
        durableComposition: COMPOSITION,
        contextWindow: 200_000,
        mode: "act",
        updatedAt: 1,
        lineage: { kind: "baseline" },
        ...overrides,
    }
}

function renderSummary(source: ContextWindowIndicatorSnapshot) {
    const viewModel = createContextWindowIndicatorViewModel(source)
    render(
        <ContextWindowSummary
            contextWindow={viewModel.contextWindow}
            indicatorViewModel={viewModel}
            percentage={viewModel.percentage}
            tokenUsed={viewModel.totalTokens}
        />,
    )
}

describe("durable context breakdown", () => {
    it("splits durable into the six sources, deriving the conversation from what remains", () => {
        const breakdown = createContextWindowIndicatorViewModel(snapshot()).durableBreakdown

        expect(breakdown?.map((part) => [part.part, part.tokens])).toEqual([
            ["basePrompt", 20_000],
            ["userRules", 5_000],
            ["skills", 3_000],
            ["workflows", 2_000],
            ["toolDefinitions", 10_000],
            ["conversation", 60_000],
        ])
        expect(breakdown?.reduce((total, part) => total + part.percentOfDurable, 0)).toBeCloseTo(100)
    })

    it("leaves the four top-level segments unchanged and omits a breakdown the snapshot cannot support", () => {
        const withSplit = createContextWindowIndicatorViewModel(snapshot())
        const withoutSplit = createContextWindowIndicatorViewModel(snapshot({ durableComposition: undefined }))
        const invalid = createContextWindowIndicatorViewModel(
            snapshot({ durableComposition: { ...COMPOSITION, skills: -1 } as typeof COMPOSITION }),
        )

        expect(withSplit.segments).toEqual(withoutSplit.segments)
        expect(withoutSplit.durableBreakdown).toBeUndefined()
        expect(invalid.durableBreakdown).toBeUndefined()
    })

    it("expands the durable card into its breakdown and collapses it again", () => {
        renderSummary(snapshot())
        const durable = document.querySelector<HTMLButtonElement>('[data-segment-detail="durable"]')

        expect(durable?.tagName).toBe("BUTTON")
        expect(durable).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByTestId("context-window-durable-breakdown")).not.toBeInTheDocument()

        fireEvent.click(durable as HTMLButtonElement)
        const breakdown = screen.getByTestId("context-window-durable-breakdown")
        expect(durable).toHaveAttribute("aria-expanded", "true")
        expect(durable).toHaveAttribute("aria-controls", breakdown.id)
        expect(breakdown.querySelector('[data-durable-breakdown-part="conversation"]')).toHaveTextContent("60.0k")
        expect(breakdown.querySelector('[data-durable-breakdown-part="userRules"]')).toHaveTextContent("5%")
        expect(breakdown).toHaveTextContent("Tool definitions")

        fireEvent.click(durable as HTMLButtonElement)
        expect(screen.queryByTestId("context-window-durable-breakdown")).not.toBeInTheDocument()
    })

    it("says the breakdown is unavailable for a snapshot without a measured prefix", () => {
        renderSummary(snapshot({ durableComposition: undefined }))

        fireEvent.click(document.querySelector('[data-segment-detail="durable"]') as HTMLElement)

        expect(screen.getByTestId("context-window-durable-breakdown")).toHaveTextContent("Breakdown unavailable")
    })

    it("draws decorative stripes inside the durable segment and opens the breakdown on click", () => {
        const onDurableClick = vi.fn()
        render(<ContextWindowSegmentedProgress onDurableClick={onDurableClick} snapshot={snapshot()} />)
        const durable = screen.getByTestId("context-window-segment-durable")
        const stripes = screen.getByTestId("context-window-durable-stripes")

        expect(durable).toHaveAttribute("aria-label", "Durable: 100000 tokens")
        expect(durable).toHaveAttribute("data-tokens", "100000")
        expect(durable).toContainElement(stripes)
        expect(stripes).toHaveAttribute("aria-hidden", "true")
        expect(stripes.querySelector('[data-durable-part="conversation"]')).toHaveStyle({ width: "60%" })
        expect(stripes.querySelectorAll("[data-durable-part]")).toHaveLength(6)

        fireEvent.click(durable)
        expect(onDurableClick).toHaveBeenCalledTimes(1)
    })

    it("draws no stripes without a measured prefix", () => {
        render(<ContextWindowSegmentedProgress snapshot={snapshot({ durableComposition: undefined })} />)

        expect(screen.queryByTestId("context-window-durable-stripes")).not.toBeInTheDocument()
    })
})
