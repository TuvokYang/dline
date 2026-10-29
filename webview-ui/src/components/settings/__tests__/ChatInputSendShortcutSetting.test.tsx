import { fireEvent, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ChatInputSendShortcutSetting from "../ChatInputSendShortcutSetting"

const mocks = vi.hoisted(() => ({
    updateSetting: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ chatInputSendShortcut: "enter" }),
}))

vi.mock("../utils/settingsHandlers", () => ({
    updateSetting: mocks.updateSetting,
}))

describe("ChatInputSendShortcutSetting", () => {
    beforeEach(() => {
        mocks.updateSetting.mockClear()
    })

    it("persists the selected shortcut", () => {
        const { container } = render(<ChatInputSendShortcutSetting />)
        const dropdown = container.querySelector("#chat-input-send-shortcut")

        expect(dropdown).not.toBeNull()
        Object.defineProperty(dropdown!, "value", { configurable: true, value: "ctrlEnter", writable: true })
        fireEvent.change(dropdown!)

        expect(mocks.updateSetting).toHaveBeenCalledWith("chatInputSendShortcut", "ctrlEnter")
    })
})
