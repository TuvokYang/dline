// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import ThinkingControl from "./ThinkingControl"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		children,
		disabled,
		onChange,
	}: {
		checked?: boolean
		children: ReactNode
		disabled?: boolean
		onChange?: React.ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

const DISPLAY_OPTIONS = [
	{ value: "none", label: "None" },
	{ value: "summarized", label: "Summarized" },
	{ value: "omitted", label: "Omitted" },
]

// The Select trigger carries no accessible name, so the selectors are addressed by the
// render order used in effort-only mode: effort first, then reasoning display.
const effortSelector = () => screen.getAllByRole("combobox")[0]
const displaySelector = () => screen.getAllByRole("combobox")[1]

describe("ThinkingControl", () => {
	it("leaves an undeclared effort default unset instead of selecting the first level", () => {
		render(
			<ThinkingControl
				defaultEnabled={true}
				effortOptions={["low"]}
				mode="effort-only"
				onReasoningConfigUpdate={vi.fn()}
			/>,
		)
		expect(screen.getByRole("combobox")).toHaveTextContent("Provider default")
	})

	it("does not fabricate a medium preference when thinking is enabled", () => {
		const onUpdate = vi.fn()
		render(<ThinkingControl effortOptions={["low"]} mode="effort-only" onReasoningConfigUpdate={onUpdate} />)
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
		expect(onUpdate).toHaveBeenCalledWith({
			enableThinking: true,
			effort: undefined,
			thinkingBudget: undefined,
			display: undefined,
		})
	})

	it.each([undefined, true])("keeps explicit None off even with enableThinking=%s and an enabled default", (enableThinking) => {
		render(
			<ThinkingControl
				defaultEnabled={true}
				effortOptions={["none", "low"]}
				mode="effort-only"
				onReasoningConfigUpdate={vi.fn()}
				reasoningConfig={{ enableThinking, effort: "none" }}
			/>,
		)
		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
	})

	it("preserves a legal model-declared effort outside the old OpenAI whitelist", () => {
		render(
			<ThinkingControl
				effortOptions={["low", "custom"]}
				mode="effort-only"
				onReasoningConfigUpdate={vi.fn()}
				reasoningConfig={{ enableThinking: true, effort: "custom" }}
			/>,
		)
		expect(screen.getByRole("combobox")).toHaveTextContent("Custom")
	})

	it("does not render an empty-string effort as a Radix option", () => {
		render(
			<ThinkingControl
				defaultEnabled={true}
				effortOptions={["", "low"]}
				mode="effort-only"
				onReasoningConfigUpdate={vi.fn()}
			/>,
		)
		fireEvent.click(screen.getByRole("combobox"))
		expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument()
	})

	it("does not offer a selector for an explicitly empty effort declaration", () => {
		render(<ThinkingControl defaultEnabled={true} effortOptions={[]} mode="effort-only" onReasoningConfigUpdate={vi.fn()} />)
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
	})

	it("does not invent a budget maximum when the declaration omits it", () => {
		const onUpdate = vi.fn()
		render(
			<ThinkingControl
				effortOptions={[]}
				mode="budget-only"
				onReasoningConfigUpdate={onUpdate}
				reasoningConfig={{ enableThinking: true, thinkingBudget: 3000, display: "omitted" }}
			/>,
		)
		const input = screen.getByRole("spinbutton")
		expect(input).not.toHaveAttribute("max")
		fireEvent.change(input, { target: { value: "9000" } })
		fireEvent.blur(input)
		expect(onUpdate).toHaveBeenCalledWith({
			enableThinking: true,
			effort: undefined,
			thinkingBudget: 9000,
			display: "omitted",
		})
	})

	it("does not fabricate a budget preference when thinking is enabled", () => {
		const onUpdate = vi.fn()
		render(<ThinkingControl effortOptions={[]} maxBudget={2000} mode="budget-only" onReasoningConfigUpdate={onUpdate} />)
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
		expect(onUpdate).toHaveBeenCalledWith({
			enableThinking: true,
			effort: undefined,
			thinkingBudget: undefined,
			display: undefined,
		})
	})

	it.each([
		{ value: "1", expected: 1024 },
		{ value: "9000", expected: 2000 },
	])("bounds an explicit budget edit $value by the supplied protocol and model limits", ({ value, expected }) => {
		const onUpdate = vi.fn()
		render(
			<ThinkingControl
				effortOptions={[]}
				maxBudget={2000}
				minBudget={1024}
				mode="budget-only"
				onReasoningConfigUpdate={onUpdate}
				reasoningConfig={{ enableThinking: true, thinkingBudget: 1500, display: "omitted" }}
			/>,
		)
		const slider = screen.getByRole("slider")
		fireEvent.change(slider, { target: { value } })
		fireEvent.mouseUp(slider)
		expect(onUpdate).toHaveBeenCalledWith({
			enableThinking: true,
			effort: undefined,
			thinkingBudget: expected,
			display: "omitted",
		})
	})

	it("shows a default-enabled model at its configured default effort", () => {
		render(
			<ThinkingControl
				defaultEffort="high"
				defaultEnabled={true}
				effortOptions={["none", "low", "medium", "high", "max"]}
				mode="effort-only"
				onReasoningConfigUpdate={vi.fn()}
			/>,
		)

		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
		expect(screen.getByRole("combobox")).toHaveTextContent("High")
	})

	it("persists an explicit disabled request when None is selected", () => {
		const onReasoningConfigUpdate = vi.fn()
		render(
			<ThinkingControl
				defaultEffort="high"
				defaultEnabled={true}
				effortLabel="Adaptive Thinking"
				effortOptions={["none", "low", "medium", "high", "max"]}
				mode="effort-only"
				onReasoningConfigUpdate={onReasoningConfigUpdate}
			/>,
		)

		fireEvent.click(screen.getByRole("combobox"))
		fireEvent.click(screen.getByRole("option", { name: "None" }))

		expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
			enableThinking: false,
			effort: "none",
			thinkingBudget: undefined,
		})
	})

	it("stores the selected reasoning display", () => {
		const onReasoningConfigUpdate = vi.fn()
		render(
			<ThinkingControl
				defaultEffort="high"
				defaultEnabled={true}
				displayOptions={DISPLAY_OPTIONS}
				effortOptions={["none", "low", "medium", "high", "max"]}
				mode="effort-only"
				onReasoningConfigUpdate={onReasoningConfigUpdate}
				reasoningConfig={{ enableThinking: true, effort: "high" }}
			/>,
		)

		fireEvent.click(displaySelector())
		fireEvent.click(screen.getByRole("option", { name: "Omitted" }))

		expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
			enableThinking: true,
			effort: "high",
			display: "omitted",
		})
	})

	it("clears the stored display when None is selected", () => {
		const onReasoningConfigUpdate = vi.fn()
		render(
			<ThinkingControl
				defaultEffort="high"
				defaultEnabled={true}
				displayOptions={DISPLAY_OPTIONS}
				effortOptions={["none", "low", "medium", "high", "max"]}
				mode="effort-only"
				onReasoningConfigUpdate={onReasoningConfigUpdate}
				reasoningConfig={{ enableThinking: true, effort: "high", display: "omitted" }}
			/>,
		)

		fireEvent.click(displaySelector())
		fireEvent.click(screen.getByRole("option", { name: "None" }))

		expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
			enableThinking: true,
			effort: "high",
			display: undefined,
		})
	})

	it("preserves the stored display when the effort changes", () => {
		const onReasoningConfigUpdate = vi.fn()
		render(
			<ThinkingControl
				defaultEffort="high"
				defaultEnabled={true}
				displayOptions={DISPLAY_OPTIONS}
				effortLabel="Adaptive Thinking"
				effortOptions={["none", "low", "medium", "high", "max"]}
				mode="effort-only"
				onReasoningConfigUpdate={onReasoningConfigUpdate}
				reasoningConfig={{ enableThinking: true, effort: "high", display: "omitted" }}
			/>,
		)

		fireEvent.click(effortSelector())
		fireEvent.click(screen.getByRole("option", { name: "Low" }))

		expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
			enableThinking: true,
			effort: "low",
			thinkingBudget: undefined,
			display: "omitted",
		})
	})

	it("omits the display selector when a provider exposes no options", () => {
		render(
			<ThinkingControl
				defaultEffort="high"
				defaultEnabled={true}
				effortOptions={["none", "low", "medium", "high", "max"]}
				mode="effort-only"
				onReasoningConfigUpdate={vi.fn()}
			/>,
		)

		expect(screen.queryByText("Thinking Display")).not.toBeInTheDocument()
	})

	it("keeps required thinking enabled when a stale profile requests disabled", () => {
		const onReasoningConfigUpdate = vi.fn()
		render(
			<ThinkingControl
				defaultEffort="high"
				defaultEnabled={true}
				disableSupported={false}
				effortLabel="Adaptive Thinking"
				effortOptions={["low", "medium", "high", "max"]}
				mode="effort-only"
				onReasoningConfigUpdate={onReasoningConfigUpdate}
				reasoningConfig={{ enableThinking: false, effort: "none" }}
			/>,
		)

		const enableThinking = screen.getByRole("checkbox", { name: "Enable Thinking" })
		expect(enableThinking).toBeChecked()
		expect(enableThinking).toBeDisabled()
		expect(screen.getByRole("combobox")).toHaveTextContent("High")
		expect(screen.queryByRole("option", { name: "None" })).not.toBeInTheDocument()
		expect(onReasoningConfigUpdate).not.toHaveBeenCalled()
	})
})
