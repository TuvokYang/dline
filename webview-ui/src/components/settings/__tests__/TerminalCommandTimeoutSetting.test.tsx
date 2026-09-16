import { fireEvent, render, screen } from "@testing-library/react"
import type { InputHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TerminalCommandTimeoutSetting from "../TerminalCommandTimeoutSetting"

const mocks = vi.hoisted(() => ({
	updateSetting: vi.fn(),
	useExtensionState: vi.fn(() => ({ terminalCommandTimeoutSeconds: 1800 })),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: mocks.useExtensionState,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: mocks.updateSetting,
}))

describe("TerminalCommandTimeoutSetting", () => {
	beforeEach(() => {
		mocks.updateSetting.mockClear()
		mocks.useExtensionState.mockReturnValue({ terminalCommandTimeoutSeconds: 1800 })
	})

	it("shows minutes and persists the backend value in seconds", () => {
		render(<TerminalCommandTimeoutSetting />)
		const input = screen.getByLabelText("Terminal command timeout (minutes)") as HTMLInputElement

		expect(input.value).toBe("30")
		fireEvent.input(input, { target: { value: "45" } })
		fireEvent.blur(input)

		expect(mocks.updateSetting).toHaveBeenCalledWith("terminalCommandTimeoutSeconds", 2700)
	})

	it("does not replace an active edit with a stale persisted value", () => {
		const { rerender } = render(<TerminalCommandTimeoutSetting />)
		const input = screen.getByLabelText("Terminal command timeout (minutes)") as HTMLInputElement

		fireEvent.focus(input)
		fireEvent.input(input, { target: { value: "42" } })
		expect(input.value).toBe("42")

		mocks.useExtensionState.mockReturnValue({ terminalCommandTimeoutSeconds: 240 })
		rerender(<TerminalCommandTimeoutSetting />)

		expect(input.value).toBe("42")
	})

	it("keeps a multi-character draft stable while clearing a validation error", () => {
		render(<TerminalCommandTimeoutSetting />)
		const input = screen.getByLabelText("Terminal command timeout (minutes)") as HTMLInputElement

		fireEvent.focus(input)
		fireEvent.input(input, { target: { value: "0.5" } })
		expect(screen.getByText("Enter at least 1 minute")).toBeInTheDocument()

		fireEvent.input(input, { target: { value: "4" } })
		fireEvent.input(input, { target: { value: "42" } })

		expect(input.value).toBe("42")
		expect(screen.queryByText("Enter at least 1 minute")).not.toBeInTheDocument()
		fireEvent.blur(input)
		expect(mocks.updateSetting).toHaveBeenCalledWith("terminalCommandTimeoutSeconds", 2520)
	})

	it("does not persist values below one minute", () => {
		render(<TerminalCommandTimeoutSetting />)
		const input = screen.getByLabelText("Terminal command timeout (minutes)")

		fireEvent.input(input, { target: { value: "0.5" } })

		expect(mocks.updateSetting).not.toHaveBeenCalled()
		expect(screen.getByText("Enter at least 1 minute")).toBeInTheDocument()
	})
})
