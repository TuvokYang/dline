import type { AggressiveRenderingSetting as AggressiveRenderingState } from "@shared/AggressiveRendering"
import { fireEvent, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AggressiveRenderingSetting from "../AggressiveRenderingSetting"

const mocks = vi.hoisted(() => ({
    updateSetting: vi.fn(),
    aggressiveRendering: undefined as AggressiveRenderingState | undefined,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ aggressiveRendering: mocks.aggressiveRendering }),
}))

vi.mock("../utils/settingsHandlers", () => ({
    updateSetting: mocks.updateSetting,
}))

function renderedDropdown(container: HTMLElement): Element {
    const dropdown = container.querySelector("#aggressive-rendering")
    if (!dropdown) throw new Error("aggressive rendering dropdown is not rendered")
    return dropdown
}

function chooseLevel(dropdown: Element, value: string) {
    Object.defineProperty(dropdown, "value", { configurable: true, value, writable: true })
    fireEvent.change(dropdown)
}

describe("AggressiveRenderingSetting", () => {
    beforeEach(() => {
        mocks.updateSetting.mockClear()
        mocks.aggressiveRendering = undefined
    })

    it("is absent while the rollout flag is off, even with a stored non-standard choice", () => {
        mocks.aggressiveRendering = { user: "turn", featureFlag: false }
        const { container } = render(<AggressiveRenderingSetting />)

        expect(container.querySelector("#aggressive-rendering")).toBeNull()
    })

    it("is absent before the extension has projected the setting", () => {
        const { container } = render(<AggressiveRenderingSetting />)

        expect(container.querySelector("#aggressive-rendering")).toBeNull()
    })

    it("offers the three levels while the flag is on and writes the chosen level", () => {
        mocks.aggressiveRendering = { user: "standard", featureFlag: true }
        const { container } = render(<AggressiveRenderingSetting />)
        const dropdown = renderedDropdown(container)

        const offered = Array.from(dropdown.querySelectorAll("vscode-option")).map((option) => option.getAttribute("value"))
        expect(offered).toEqual(["standard", "activity", "turn"])

        chooseLevel(dropdown, "turn")

        expect(mocks.updateSetting).toHaveBeenCalledTimes(1)
        expect(mocks.updateSetting).toHaveBeenCalledWith("aggressiveRendering", "turn")
    })

    it("ignores a value that is not a known level", () => {
        mocks.aggressiveRendering = { user: "activity", featureFlag: true }
        const { container } = render(<AggressiveRenderingSetting />)

        chooseLevel(renderedDropdown(container), "everything")

        expect(mocks.updateSetting).not.toHaveBeenCalled()
    })
})
