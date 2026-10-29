import { fireEvent, render, screen } from "@testing-library/react"
import type { InputHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TerminalHandoffSecondsSetting from "../TerminalHandoffSecondsSetting"

const mocks = vi.hoisted(() => ({
    updateSetting: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ terminalCommandHandoffSeconds: 10 }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeTextField: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock("../utils/settingsHandlers", () => ({
    updateSetting: mocks.updateSetting,
}))

describe("TerminalHandoffSecondsSetting", () => {
    beforeEach(() => {
        mocks.updateSetting.mockClear()
    })

    it("shows the default 10 seconds and persists the value in seconds", () => {
        render(<TerminalHandoffSecondsSetting />)
        const input = screen.getByLabelText("Foreground command handoff (seconds)") as HTMLInputElement

        expect(input.value).toBe("10")
        fireEvent.input(input, { target: { value: "15" } })

        expect(mocks.updateSetting).toHaveBeenCalledWith("terminalCommandHandoffSeconds", 15)
    })

    it("does not persist values below one second", () => {
        render(<TerminalHandoffSecondsSetting />)
        const input = screen.getByLabelText("Foreground command handoff (seconds)")

        fireEvent.input(input, { target: { value: "0" } })

        expect(mocks.updateSetting).not.toHaveBeenCalled()
        expect(screen.getByText("Enter at least 1 second")).toBeInTheDocument()
    })
})
