import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { StickyUserMessage } from "./StickyUserMessage"

const USER_MESSAGE: ClineMessage = {
	ts: 1,
	type: "say",
	say: "text",
	text: "Keep this message reachable",
}

describe("StickyUserMessage", () => {
	it("owns pointer events only on the visible clickable card", () => {
		const onScrollToMessage = vi.fn()
		render(<StickyUserMessage isVisible lastUserMessage={USER_MESSAGE} onScrollToMessage={onScrollToMessage} />)

		const message = screen.getByRole("button", { name: /Scroll to your message/ })
		expect(message).toHaveClass("pointer-events-auto")

		fireEvent.click(message)
		expect(onScrollToMessage).toHaveBeenCalledOnce()
	})
})
