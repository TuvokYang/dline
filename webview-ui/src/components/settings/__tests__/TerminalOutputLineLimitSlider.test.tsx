import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TerminalOutputLineLimitSlider from "../TerminalOutputLineLimitSlider"

const mocks = vi.hoisted(() => ({
    updateSetting: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ terminalOutputLineLimit: 500 }),
}))

vi.mock("../utils/settingsHandlers", () => ({
    updateSetting: mocks.updateSetting,
}))

describe("TerminalOutputLineLimitSlider", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        mocks.updateSetting.mockClear()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("keeps the latest rapid input locally and persists only the final value", async () => {
        render(<TerminalOutputLineLimitSlider />)
        const slider = screen.getByLabelText("Terminal output limit") as HTMLInputElement

        for (const value of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
            fireEvent.change(slider, { target: { value: String(value) } })
        }

        expect(slider.value).toBe("900")
        expect(mocks.updateSetting).not.toHaveBeenCalled()
        await act(async () => vi.advanceTimersByTimeAsync(100))
        expect(mocks.updateSetting).toHaveBeenCalledOnce()
        expect(mocks.updateSetting).toHaveBeenCalledWith("terminalOutputLineLimit", 900)
    })
})
