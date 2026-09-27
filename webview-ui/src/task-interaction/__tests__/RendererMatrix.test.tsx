import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PRESENTATION_KINDS, renderPresentation } from "../renderer-registry"

const MESSAGE: UiMessage = { ts: 100, type: "ask", ask: "tool", text: "Presentation text" }

describe("renderer registry", () => {
	it.each(PRESENTATION_KINDS)("renders %s without a dispatch port", (kind) => {
		render(renderPresentation(kind, { message: MESSAGE, selection: [], onSelectionChange: vi.fn() }))
		expect(screen.getByTestId(`presentation-${kind}`)).toBeVisible()
	})

	it("reports focus-chain checked items through selection state", () => {
		const onSelectionChange = vi.fn()
		const message: UiMessage = {
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
