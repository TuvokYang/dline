import type { TaskViewState } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { readOnlyTaskView } from "../readOnlyTaskView"

describe("readOnlyTaskView", () => {
	it("disables input and every footer action while keeping the rest of the view", () => {
		const view = {
			taskInstanceId: "open-1",
			activeInteraction: { interactionId: "interaction-1" },
			input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
			footer: {
				actions: [
					{ actionId: "approve", enabled: true },
					{ actionId: "reject", enabled: true },
				],
			},
		} as unknown as TaskViewState

		const masked = readOnlyTaskView(view)

		expect(masked.input).toEqual({ enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false })
		expect(masked.footer.actions.map((action) => action.enabled)).toEqual([false, false])
		expect(masked.activeInteraction).toBe(view.activeInteraction)
		expect(view.input.enabled).toBe(true)
	})
})
