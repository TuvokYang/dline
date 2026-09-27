import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PRESENTATION_KINDS, renderPresentation } from "../renderer-registry"

const MESSAGE: ClineMessage = { ts: 100, type: "ask", ask: "tool", text: "Presentation text" }

const APPROVAL_PRESENTATION_KINDS = [
	"tool_approval",
	"command_approval",
	"browser_approval",
	"mcp_approval",
	"subagent_approval",
	"spawn_task_approval",
	"focus_chain_change",
] as const

describe("renderer registry", () => {
	it.each(PRESENTATION_KINDS)("renders %s without a dispatch port", (kind) => {
		render(renderPresentation(kind, { message: MESSAGE, selection: [], onSelectionChange: vi.fn() }))
		expect(screen.getByTestId(`presentation-${kind}`)).toBeVisible()
	})

	it.each(APPROVAL_PRESENTATION_KINDS)("caps %s at 30 percent of the viewport with internal scrolling", (kind) => {
		render(renderPresentation(kind, { message: MESSAGE, selection: [], onSelectionChange: vi.fn() }))

		expect(screen.getByTestId(`presentation-${kind}`)).toHaveClass("max-h-[30vh]", "overflow-y-auto", "overscroll-x-contain")
	})

	it("caps make_plan at 80 percent of the viewport with internal scrolling", () => {
		render(renderPresentation("make_plan", { message: MESSAGE, selection: [], onSelectionChange: vi.fn() }))

		expect(screen.getByTestId("presentation-make_plan")).toHaveClass(
			"max-h-[80vh]",
			"overflow-y-auto",
			"overscroll-x-contain",
		)
	})

	it("reports focus-chain checked items through selection state", () => {
		const onSelectionChange = vi.fn()
		const message: ClineMessage = {
			ts: 100,
			type: "ask",
			ask: "change_todo_list",
			text: JSON.stringify({ plan: "# Plan\n- [ ] First item\n- [ ] Second item", reason: "Review" }),
		}
		render(renderPresentation("focus_chain_change", { message, selection: [], onSelectionChange }))

		fireEvent.click(screen.getByLabelText("Second item"))

		expect(onSelectionChange).toHaveBeenLastCalledWith(["1"])
	})
})
