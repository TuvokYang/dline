import type { UiLanguage } from "@shared/UiLanguage"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { ConversationTrajectoryRail } from "../ConversationTrajectoryRail"
import type { TrajectoryAttempt } from "../trajectory-model"

const attempts: TrajectoryAttempt[] = [
    {
        id: "attempt-0",
        completed: true,
        turns: [
            {
                seq: 0,
                anchorIndex: 0,
                anchorTs: 500,
                prompt: "initial task",
                rounds: 2,
                toolUsage: [{ tool: "read_file", count: 3 }],
            },
            {
                seq: 1,
                anchorIndex: 19,
                anchorTs: 500,
                prompt: "equal timestamp",
                rounds: 4,
                toolUsage: [{ tool: "search_files", count: 6 }],
            },
        ],
    },
    {
        id: "attempt-1",
        completed: false,
        turns: [{ seq: 2, anchorTs: 20, prompt: "unlocated backwards timestamp", rounds: 7, toolUsage: [] }],
    },
]

afterEach(cleanup)

describe("ConversationTrajectoryRail source-index points", () => {
    it("keeps all points enabled, selects full targets and keys/marks them by seq rather than timestamp", () => {
        const select = vi.fn()
        const { rerender } = render(
            <ConversationTrajectoryRail activeTurnSeq={1} attempts={attempts} onSelectTurn={select} visible />,
        )
        const bars = screen.getAllByTestId("trajectory-turn")
        expect(bars).toHaveLength(3)
        expect(screen.getAllByTestId("trajectory-attempt")).toHaveLength(2)
        expect(bars.map((bar) => bar.getAttribute("aria-current"))).toEqual([null, "location", null])
        expect(bars.map((bar) => bar.getAttribute("data-turn-index"))).toEqual(["0", "19", null])
        for (const bar of bars) {
            expect(bar).not.toBeDisabled()
            fireEvent.click(bar)
        }
        expect(select.mock.calls.map(([turn]) => [turn.seq, turn.anchorIndex, turn.anchorTs])).toEqual([
            [0, 0, 500],
            [1, 19, 500],
            [2, undefined, 20],
        ])
        const replaced = [{ ...attempts[0], turns: attempts[0].turns.map((turn) => ({ ...turn, anchorTs: 9 })) }, attempts[1]]
        rerender(<ConversationTrajectoryRail activeTurnSeq={0} attempts={replaced} onSelectTurn={select} visible />)
        expect(screen.getAllByTestId("trajectory-turn")[1]).toBe(bars[1])
        const currentLocations = screen.getAllByTestId("trajectory-turn").map((bar) => bar.getAttribute("aria-current"))
        expect(currentLocations).toEqual(["location", null, null])
    })

    it("retranslates an open preview without changing the active anchor or original selection payload", async () => {
        const select = vi.fn()
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ConversationTrajectoryRail activeTurnSeq={1} attempts={attempts} onSelectTurn={select} visible />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const rail = screen.getByRole("navigation", { name: "Conversation trajectory" })
        const bar = screen.getAllByTestId("trajectory-turn")[1]
        fireEvent.focus(bar)
        const preview = await screen.findByTestId("trajectory-turn-preview")
        const checkAnchor = () => {
            expect(bar).toHaveAttribute("aria-current", "location")
            expect(bar).toHaveAttribute("data-turn-index", "19")
            expect(bar).toHaveAttribute("data-turn-seq", "1")
            expect(bar).toHaveAttribute("data-turn-ts", "500")
            expect(within(preview).getByText("equal timestamp")).toBeInTheDocument()
            expect(within(preview).getByText("search_files").closest("li")).toHaveTextContent("search_files6")
        }

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("navigation", { name: "对话轨迹" })).toBe(rail)
        expect(screen.getByRole("button", { name: "跳转到消息：equal timestamp" })).toBe(bar)
        expect(screen.getByTestId("trajectory-turn-preview")).toBe(preview)
        expect(within(preview).getByText("第 1 次尝试")).toBeInTheDocument()
        expect(within(preview).getByText("第 2 轮对话")).toBeInTheDocument()
        expect(within(preview).getByText("4 轮请求")).toBeInTheDocument()
        checkAnchor()
        expect(select).not.toHaveBeenCalled()

        view.rerender(tree("en"))
        expect(screen.getByTestId("trajectory-turn-preview")).toBe(preview)
        expect(bar).toHaveAccessibleName("Jump to message: equal timestamp")
        expect(within(preview).getByText("4 rounds")).toBeInTheDocument()
        checkAnchor()
        fireEvent.click(bar)
        expect(select).toHaveBeenCalledExactlyOnceWith(attempts[0].turns[1])
        expect(select.mock.calls[0][0]).toBe(attempts[0].turns[1])
    })

    it("preserves the preview's prompt, attempt/turn labels, rounds and tool totals for a repeated timestamp point", async () => {
        render(<ConversationTrajectoryRail activeTurnSeq={1} attempts={attempts} onSelectTurn={vi.fn()} visible />)
        fireEvent.focus(screen.getAllByTestId("trajectory-turn")[1])
        await waitFor(() => expect(screen.getByTestId("trajectory-turn-preview")).toBeInTheDocument())
        const preview = within(screen.getByTestId("trajectory-turn-preview"))
        expect(preview.getByText("Attempt 1")).toBeInTheDocument()
        expect(preview.getByText("Turn 2")).toBeInTheDocument()
        expect(preview.getByText("equal timestamp")).toBeInTheDocument()
        expect(preview.getByText("4 rounds")).toBeInTheDocument()
        expect(preview.getByText("search_files").closest("li")?.textContent).toBe("search_files6")
        expect(screen.getAllByTestId("trajectory-turn")).toHaveLength(3)
    })
})
