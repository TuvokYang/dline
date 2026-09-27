// @vitest-environment jsdom

import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CommandRenderer } from "./PresentationRenderers"

const COMMAND_ASK: UiMessage = {
	ts: 100,
	type: "ask",
	ask: "command",
	text: "npm run check",
	interactionId: "command-1",
}

describe("CommandRenderer", () => {
	beforeEach(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn(async () => undefined) },
		})
	})

	it("copies the command from its top-right action", async () => {
		render(<CommandRenderer message={COMMAND_ASK} onSelectionChange={vi.fn()} selection={[]} />)

		fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

		await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npm run check"))
	})
})
