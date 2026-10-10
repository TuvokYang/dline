import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AutoCondenseSettings from "./AutoCondenseSettings"

const mocks = vi.hoisted(() => ({
    extensionState: {
        autoCondenseTriggerPercent: 97,
        autoCondenseMinReserveTokens: 5_000,
        autoCondenseMaxReserveTokens: 30_000,
        autoCondenseMaxContextTokens: 0,
    },
    updateSetting: vi.fn(),
    updateSettings: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => mocks.extensionState,
}))

interface MockSettingsSliderProps {
    label: string
    max: number
    min: number
    onChange: (value: number) => void
    value: number
}

vi.mock("./SettingsSlider", () => ({
    default: ({ label, max, min, onChange, value }: MockSettingsSliderProps) => (
        <input
            aria-label={label}
            max={max}
            min={min}
            onChange={(event) => onChange(Number(event.target.value))}
            type="range"
            value={value}
        />
    ),
}))

vi.mock("./utils/settingsHandlers", () => ({
    updateSetting: (...args: unknown[]) => mocks.updateSetting(...args),
    updateSettings: (...args: unknown[]) => mocks.updateSettings(...args),
}))

describe("AutoCondenseSettings", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        mocks.updateSetting.mockReset()
        mocks.updateSettings.mockReset()
        mocks.extensionState.autoCondenseTriggerPercent = 97
        mocks.extensionState.autoCondenseMinReserveTokens = 5_000
        mocks.extensionState.autoCondenseMaxReserveTokens = 30_000
        mocks.extensionState.autoCondenseMaxContextTokens = 0
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("automatically saves the percentage and K-token limit", async () => {
        render(<AutoCondenseSettings />)

        fireEvent.change(screen.getByLabelText("Compression point (%)"), { target: { value: "60" } })
        fireEvent.change(screen.getByLabelText("Maximum context (K tokens)"), { target: { value: "500" } })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
        })

        expect(mocks.updateSetting).toHaveBeenCalledWith("autoCondenseTriggerPercent", 60)
        expect(mocks.updateSetting).toHaveBeenCalledWith("autoCondenseMaxContextTokens", 500_000)
    })

    it("saves a valid reserve pair in one request", async () => {
        render(<AutoCondenseSettings />)

        fireEvent.change(screen.getByLabelText("Minimum reserve (K tokens)"), { target: { value: "10" } })
        fireEvent.change(screen.getByLabelText("Maximum reserve (K tokens)"), { target: { value: "40" } })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
        })

        expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
        expect(mocks.updateSettings).toHaveBeenCalledWith({
            autoCondenseMinReserveTokens: 10_000,
            autoCondenseMaxReserveTokens: 40_000,
        })
    })

    it("keeps invalid input local and does not send it", async () => {
        render(<AutoCondenseSettings />)

        const input = screen.getByLabelText("Maximum context (K tokens)")
        fireEvent.change(input, { target: { value: "1.5" } })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
        })

        expect(screen.getByText(/Enter a whole number/)).toBeInTheDocument()
        expect(mocks.updateSetting).not.toHaveBeenCalledWith("autoCondenseMaxContextTokens", expect.anything())
    })

    it("does not send an invalid reserve combination", async () => {
        render(<AutoCondenseSettings />)

        fireEvent.change(screen.getByLabelText("Minimum reserve (K tokens)"), { target: { value: "40" } })
        fireEvent.change(screen.getByLabelText("Maximum reserve (K tokens)"), { target: { value: "30" } })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
        })

        expect(screen.getByText(/Minimum reserve cannot exceed maximum reserve/i)).toBeInTheDocument()
        expect(mocks.updateSettings).not.toHaveBeenCalled()
    })

    it("reflects settings changed outside the current view", () => {
        const { rerender } = render(<AutoCondenseSettings />)

        mocks.extensionState.autoCondenseTriggerPercent = 65
        mocks.extensionState.autoCondenseMinReserveTokens = 8_000
        mocks.extensionState.autoCondenseMaxReserveTokens = 42_000
        mocks.extensionState.autoCondenseMaxContextTokens = 400_000
        rerender(<AutoCondenseSettings />)

        expect(screen.getByLabelText("Compression point (%)")).toHaveValue("65")
        expect(screen.getByLabelText("Minimum reserve (K tokens)")).toHaveValue(8)
        expect(screen.getByLabelText("Maximum reserve (K tokens)")).toHaveValue(42)
        expect(screen.getByLabelText("Maximum context (K tokens)")).toHaveValue(400)
    })
})
