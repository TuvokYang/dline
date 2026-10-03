import type { Locator } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"
import { clickWorkScrollToBottom, waitForWorkNavigationReady } from "./e2e/utils/work/session"

function createNavigationLocators() {
	const state = { controlPresent: true, latestVisible: true, latestInViewport: true }
	const count = vi.fn(async () => Number(state.controlPresent))
	const click = vi.fn<Locator["click"]>().mockResolvedValue(undefined)
	const assertLatestReady = vi.fn(async () => {
		if (!state.latestVisible) throw new Error("Expected latest item is missing")
		if (!state.latestInViewport) throw new Error("Expected latest item is outside the viewport")
	})
	return {
		state,
		count,
		click,
		assertLatestReady,
		button: { count, click } as unknown as Locator,
	}
}

describe("clickWorkScrollToBottom", () => {
	it("accepts a ready semantic target despite unrelated scroller geometry changes", async () => {
		const { state, button, assertLatestReady, click } = createNavigationLocators()
		state.controlPresent = false
		const geometry = { scrollHeight: 1_000, scrollTop: 780, clientHeight: 200 }

		await clickWorkScrollToBottom(button, assertLatestReady)
		geometry.scrollHeight += 40
		geometry.scrollTop += 20
		await clickWorkScrollToBottom(button, assertLatestReady)

		expect(geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight).toBe(40)
		expect(assertLatestReady).toHaveBeenCalledTimes(2)
		expect(click).not.toHaveBeenCalled()
	})

	it.each(["missing", "offscreen"])("does not accept a loaded-window bottom when the expected tail is %s", async (failure) => {
		const { state, button, assertLatestReady, click } = createNavigationLocators()
		state.controlPresent = false
		state.latestVisible = failure !== "missing"
		state.latestInViewport = failure !== "offscreen"
		const loadedWindow = { scrollHeight: 1_000, scrollTop: 800, clientHeight: 200 }

		expect(loadedWindow.scrollHeight - loadedWindow.scrollTop - loadedWindow.clientHeight).toBe(0)
		await expect(clickWorkScrollToBottom(button, assertLatestReady)).rejects.toThrow("Expected latest item")

		expect(assertLatestReady).toHaveBeenCalledTimes(1)
		expect(click).not.toHaveBeenCalled()
	})

	it("makes one normal bounded click and requires the target afterward", async () => {
		const { button, assertLatestReady, click } = createNavigationLocators()

		await clickWorkScrollToBottom(button, assertLatestReady)

		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
		expect(assertLatestReady).toHaveBeenCalledTimes(1)
		expect(click.mock.invocationCallOrder[0]).toBeLessThan(assertLatestReady.mock.invocationCallOrder[0])
	})

	it("accepts a detached control only after the expected latest target is ready", async () => {
		const { state, button, assertLatestReady, count, click } = createNavigationLocators()
		click.mockImplementation(async () => {
			state.controlPresent = false
			throw new Error("Element was detached from the DOM")
		})

		await clickWorkScrollToBottom(button, assertLatestReady)

		expect(count).toHaveBeenCalledTimes(2)
		expect(assertLatestReady).toHaveBeenCalledTimes(1)
		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})

	it.each(["missing", "offscreen"])("rejects a disappeared control when the expected latest target is %s", async (failure) => {
		const { state, button, assertLatestReady, click } = createNavigationLocators()
		state.latestVisible = failure !== "missing"
		state.latestInViewport = failure !== "offscreen"
		click.mockImplementation(async () => {
			state.controlPresent = false
			throw new Error("Element was detached from the DOM")
		})

		await expect(clickWorkScrollToBottom(button, assertLatestReady)).rejects.toThrow("Expected latest item")

		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})

	it("preserves a genuine click failure on a still-present control even when the target is ready", async () => {
		const { button, assertLatestReady, click } = createNavigationLocators()
		const clickError = new Error("Another row intercepts pointer events")
		click.mockRejectedValue(clickError)

		await expect(clickWorkScrollToBottom(button, assertLatestReady)).rejects.toBe(clickError)

		expect(assertLatestReady).not.toHaveBeenCalled()
		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})

	it("propagates a failed control observation without clicking", async () => {
		const { button, assertLatestReady, count, click } = createNavigationLocators()
		const observationError = new Error("Frame is unavailable")
		count.mockRejectedValueOnce(observationError)

		await expect(clickWorkScrollToBottom(button, assertLatestReady)).rejects.toBe(observationError)

		expect(assertLatestReady).not.toHaveBeenCalled()
		expect(click).not.toHaveBeenCalled()
	})

	it("does not treat a failed target observation after control disappearance as navigation success", async () => {
		const { state, button, assertLatestReady, click } = createNavigationLocators()
		const observationError = new Error("Frame is unavailable")
		assertLatestReady.mockRejectedValueOnce(observationError)
		click.mockImplementation(async () => {
			state.controlPresent = false
			throw new Error("Element was detached from the DOM")
		})

		await expect(clickWorkScrollToBottom(button, assertLatestReady)).rejects.toBe(observationError)

		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
	})

	it("respects the caller's smaller click deadline", async () => {
		const { button, assertLatestReady, click } = createNavigationLocators()

		await clickWorkScrollToBottom(button, assertLatestReady, 123)

		expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 123 })
	})
})

describe("waitForWorkNavigationReady", () => {
	it("waits for a later control when the latest target is mounted but offscreen", async () => {
		const { state, button, count, click } = createNavigationLocators()
		state.latestInViewport = false
		count.mockResolvedValueOnce(0).mockResolvedValue(1)
		const isLatestInViewport = vi.fn(async () => state.latestVisible && state.latestInViewport)

		await waitForWorkNavigationReady(button, isLatestInViewport)

		expect(state.latestVisible).toBe(true)
		expect(count).toHaveBeenCalledTimes(2)
		expect(isLatestInViewport).toHaveBeenCalledTimes(1)
		expect(click).not.toHaveBeenCalled()
	})

	it("allows an in-viewport target when the control is absent", async () => {
		const { state, button, count } = createNavigationLocators()
		state.controlPresent = false
		const isLatestInViewport = vi.fn(async () => state.latestVisible && state.latestInViewport)

		await waitForWorkNavigationReady(button, isLatestInViewport)

		expect(count).toHaveBeenCalledTimes(1)
		expect(isLatestInViewport).toHaveBeenCalledTimes(1)
	})
})
