// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import SubagentStatusRow from "../../../SubagentStatusRow"
import { subagentBatch } from "./activityFoldStoryFixtures"

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ currentTaskItem: { id: "task-1" }, taskViewState: { taskId: undefined } }),
}))

vi.mock("../../../activity/useTaskActivities", () => ({
    cancelTaskActivities: vi.fn(),
    finishTaskActivities: vi.fn(),
    retryTaskActivities: vi.fn(),
    useTaskActivities: () => ({ activities: [], activeCount: 0, getById: () => undefined }),
}))

class TestResizeObserver implements ResizeObserver {
    disconnect = vi.fn()
    observe = vi.fn()
    unobserve = vi.fn()
}

globalThis.ResizeObserver = TestResizeObserver

describe("the subagent story fixture", () => {
    /**
     * The stories and the folding tests read this fixture instead of a real task,
     * so a payload that states a batch without its entries would make every one of
     * them agree on a shape the extension never writes: a header with no cards.
     */
    it("renders one card per entry instead of a header alone", () => {
        render(<SubagentStatusRow isLast={true} message={subagentBatch(1, "failed", 2)} />)

        const cards = screen.getAllByTestId("subagent-item")
        // Two failed agents, no completed one: the number of cards has to match
        // the batch count the fold header reports for the same payload.
        expect(cards).toHaveLength(2)
        expect(screen.getByText("Subagents failed:")).toBeInTheDocument()
        for (const card of cards) expect(card).toHaveTextContent(/Scan src\//)
    })

    it("keeps the batch count equal to the number of cards", () => {
        const message = subagentBatch(1, "failed", 3)
        const payload = JSON.parse(message.text ?? "{}") as { total: number; failures: number; items: unknown[] }

        render(<SubagentStatusRow isLast={true} message={message} />)

        expect(screen.getAllByTestId("subagent-item")).toHaveLength(payload.items.length)
        expect(payload.total).toBe(payload.items.length)
        expect(payload.failures).toBe(payload.items.length)
    })

    it("draws a single-entry batch with the singular title", () => {
        render(<SubagentStatusRow isLast={true} message={subagentBatch(1, "completed")} />)

        expect(screen.getAllByTestId("subagent-item")).toHaveLength(1)
        expect(screen.getByText("Subagent completed:")).toBeInTheDocument()
    })
})
