import { act } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"
import { vi } from "vitest"
import { TOOLTIP_OPEN_DELAY_MS } from "../tooltip"

/**
 * Hovers a tooltip trigger and lets the pointer rest for the full open delay, so a test
 * sees the tooltip the way a user does without waiting the delay in real time.
 *
 * Fake timers advance with real time while the hover runs, because user-event schedules
 * its own steps through `setTimeout`; real timers are restored before returning.
 */
export async function hoverPastTooltipDelay(user: UserEvent, trigger: Element): Promise<void> {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
        await user.hover(trigger)
        await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_OPEN_DELAY_MS))
    } finally {
        vi.useRealTimers()
    }
}
