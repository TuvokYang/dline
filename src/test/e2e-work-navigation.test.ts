import type { Locator } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"
import { clickWorkScrollToBottom } from "./e2e/utils/work/session"

function createNavigationLocators(bottomGap = 100) {
	const geometry = { scrollHeight: 1_000, scrollTop: 800 - bottomGap, clientHeight: 200 }
	const evaluate = vi.fn(async (read: (element: typeof geometry) => boolean) => read(geometry))
	const click = vi.fn<Locator["click"]>().mockResolvedValue(undefined)
	return {
		geometry,
		evaluate,
		click,
		scroller: { evaluate } as unknown as Locator,
		button: { click } as unknown as Locator,
	}
}

describe("clickWorkScrollToBottom", () => {
	it.each([0, 10])("does not click when the transcript is already within %i pixels of the bottom", async (bottomGap) => {
		const { scroller, button, evaluate, click } = createNavigationLocators(bottomGap)

		await clickWorkScrollToBottom(scroller, button)

		expect(evaluate).toHaveBeenCalledTimes(1)
		expect(click).not.toHaveBeenCalled()
	})

	it("makes one normal bounded click when the transcript is outside the bottom threshold", async () => {
		const { scroller, button, geometry, evaluate, click } = createNavigationLocators(11)
		click.mockImplementation(async () => {
			geometry.scrollTop = 800
		})

		await clickWorkScrollToBottom(scroller, button)

		expect(evaluate).toHaveBeenCalledTimes(1)
		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})

	it("accepts a detached control only when independent geometry shows arrival at the bottom", async () => {
		const { scroller, button, geometry, evaluate, click } = createNavigationLocators()
		click.mockImplementation(async () => {
			geometry.scrollTop = 800
			throw new Error("Element was detached from the DOM")
		})

		await clickWorkScrollToBottom(scroller, button)

		expect(evaluate).toHaveBeenCalledTimes(2)
		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})

	it("rethrows the original click error when the transcript did not reach the bottom", async () => {
		const { scroller, button, evaluate, click } = createNavigationLocators()
		const detached = new Error("Element was detached from the DOM")
		click.mockRejectedValue(detached)

		await expect(clickWorkScrollToBottom(scroller, button)).rejects.toBe(detached)

		expect(evaluate).toHaveBeenCalledTimes(2)
		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})

	it("fails without clicking when the initial geometry cannot be read", async () => {
		const { scroller, button, evaluate, click } = createNavigationLocators()
		const geometryError = new Error("Transcript is unavailable")
		evaluate.mockRejectedValueOnce(geometryError)

		await expect(clickWorkScrollToBottom(scroller, button)).rejects.toBe(geometryError)

		expect(click).not.toHaveBeenCalled()
	})

	it("does not treat a failed post-click geometry read as successful navigation", async () => {
		const { scroller, button, geometry, evaluate, click } = createNavigationLocators()
		const geometryError = new Error("Transcript is unavailable")
		evaluate.mockImplementationOnce(async (read) => read(geometry)).mockRejectedValueOnce(geometryError)
		click.mockRejectedValue(new Error("Element was detached from the DOM"))

		await expect(clickWorkScrollToBottom(scroller, button)).rejects.toBe(geometryError)

		expect(evaluate).toHaveBeenCalledTimes(2)
		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})
})
