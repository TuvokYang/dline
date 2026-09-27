import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { ClaudeCodeIdentitySection } from "./ClaudeCodeIdentitySection"

// The toolkit checkbox is a web component whose checked state jsdom never
// reflects, so the sibling provider tests substitute a native input. Matching
// them keeps the checked assertions meaningful here.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		children,
		onChange,
	}: {
		checked?: boolean
		children: ReactNode
		onChange?: React.ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

describe("ClaudeCodeIdentitySection", () => {
	const checkbox = () => screen.getByRole("checkbox")

	it("is unchecked when no configuration exists", () => {
		render(<ClaudeCodeIdentitySection config={undefined} onChange={vi.fn()} />)

		expect(checkbox()).not.toBeChecked()
	})

	it("reflects an enabled configuration", () => {
		render(
			<ClaudeCodeIdentitySection
				config={{ enabled: true, clientVersionOverride: undefined, entrypointOverride: undefined }}
				onChange={vi.fn()}
			/>,
		)

		expect(checkbox()).toBeChecked()
	})

	it("reports the enabled transition", () => {
		const onChange = vi.fn()
		render(<ClaudeCodeIdentitySection config={undefined} onChange={onChange} />)

		fireEvent.click(checkbox())

		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
	})

	it("preserves the existing overrides when toggling", () => {
		const onChange = vi.fn()
		render(
			<ClaudeCodeIdentitySection
				config={{ enabled: true, clientVersionOverride: "2.1.280", entrypointOverride: "claude-vscode" }}
				onChange={onChange}
			/>,
		)

		fireEvent.click(checkbox())

		expect(onChange).toHaveBeenCalledWith({
			enabled: false,
			clientVersionOverride: "2.1.280",
			entrypointOverride: "claude-vscode",
		})
	})

	it("does not promise subscription quota", () => {
		render(<ClaudeCodeIdentitySection config={undefined} onChange={vi.fn()} />)

		// Anthropic attributes a request from several signals, so the copy must
		// not read as a guaranteed switch to plan limits.
		expect(screen.getByText(/does not guarantee/i)).toBeInTheDocument()
	})
})
