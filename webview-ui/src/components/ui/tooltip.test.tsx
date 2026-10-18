import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TOOLTIP_OPEN_DELAY_MS, Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

function renderTooltip() {
    render(
        <Tooltip>
            <TooltipTrigger>Trigger</TooltipTrigger>
            <TooltipContent>Explanation</TooltipContent>
        </Tooltip>,
    )
    return screen.getByRole("button", { name: "Trigger" })
}

describe("Tooltip", () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    // user-event schedules its own steps through `setTimeout`, so the fake clock also
    // follows real time. The margin keeps that drift from reaching the asserted boundary.
    const DRIFT_MARGIN_MS = 300

    it("opens a hovered tooltip only after the pointer rests for the open delay", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const user = userEvent.setup()
        const trigger = renderTooltip()

        await user.hover(trigger)
        await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_OPEN_DELAY_MS - DRIFT_MARGIN_MS))
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()

        await act(() => vi.advanceTimersByTimeAsync(DRIFT_MARGIN_MS))
        expect(screen.getByRole("tooltip")).toHaveTextContent("Explanation")
    })

    it("does not open when the pointer leaves before the delay elapses", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const user = userEvent.setup()
        const trigger = renderTooltip()

        await user.hover(trigger)
        await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_OPEN_DELAY_MS / 2))
        await user.unhover(trigger)
        await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_OPEN_DELAY_MS))

        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    })

    it("opens immediately when the trigger receives keyboard focus", async () => {
        const user = userEvent.setup()
        renderTooltip()

        await user.tab()

        expect(screen.getByRole("tooltip")).toHaveTextContent("Explanation")
    })
})
