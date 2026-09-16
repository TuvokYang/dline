import type { ClineMessage } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useScrollBehavior } from "./useScrollBehavior"

/**
 * Bottom restoration after the webview is hidden and shown again.
 *
 * `disableAutoScrollRef` is a browsing-ownership flag, not a position. It is
 * raised by any upward wheel, by jumping to a message and by expanding a row,
 * and it is only cleared by a deliberate downward wheel that lands on the
 * absolute bottom. A reader who drags the scrollbar to the bottom, or who
 * nudges upward and then returns, is therefore visually pinned to the bottom
 * while the flag still says "browsing".
 *
 * Reading that flag as if it meant "not at the bottom" is what left the view
 * stranded after switching away and back.
 */

const MESSAGES: ClineMessage[] = [
	{ ts: 1, type: "say", say: "task", text: "task" },
	{ ts: 2, type: "say", say: "text", text: "reply" },
]

type VisibilityState = "visible" | "hidden"

function setVisibility(state: VisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => state,
	})
}

function renderScrollBehavior() {
	const setExpandedRows = vi.fn()
	return renderHook(() => useScrollBehavior(MESSAGES, MESSAGES, MESSAGES, {}, setExpandedRows))
}

/**
 * Stand in for Virtuoso and report every scroll target the hook commits.
 *
 * The arbiter defers the actual call to an animation frame, so the frame is
 * driven manually rather than waited on.
 */
function attachVirtuoso(result: { current: ReturnType<typeof useScrollBehavior> }) {
	const scrollToIndex = vi.fn()
	// biome-ignore lint/suspicious/noExplicitAny: only scrollToIndex is exercised here
	;(result.current.virtuosoRef as any).current = { scrollToIndex }
	return scrollToIndex
}

describe("useScrollBehavior bottom restoration across visibility changes", () => {
	let frameCallbacks: FrameRequestCallback[]

	beforeEach(() => {
		frameCallbacks = []
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frameCallbacks.push(callback)
			return frameCallbacks.length
		})
		vi.stubGlobal("cancelAnimationFrame", () => undefined)
		setVisibility("visible")
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	const runPendingFrames = () => {
		const pending = frameCallbacks
		frameCallbacks = []
		for (const callback of pending) {
			callback(0)
		}
	}

	it("returns to the bottom when the reader was visually pinned there but owned the scroll", () => {
		const { result } = renderScrollBehavior()
		const scrollToIndex = attachVirtuoso(result)

		// The reader is physically at the bottom, yet owns the viewport: this is
		// what an upward nudge followed by a scrollbar drag back down produces.
		act(() => {
			result.current.isAtBottomRef.current = true
			result.current.disableAutoScrollRef.current = true
		})

		act(() => {
			setVisibility("hidden")
			document.dispatchEvent(new Event("visibilitychange"))
		})

		act(() => {
			setVisibility("visible")
			document.dispatchEvent(new Event("visibilitychange"))
			runPendingFrames()
		})

		expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ align: "end" }))
	})

	it("does not treat the end of a paged window as the end of the conversation", () => {
		const { result } = renderScrollBehavior()
		const scrollToIndex = attachVirtuoso(result)

		// History is paged. Reaching the last loaded row can be the middle of
		// the conversation, and restoring "the bottom" there would move the
		// reader somewhere they never asked to be.
		act(() => {
			result.current.isAtBottomRef.current = true
			result.current.absoluteBottomLoadedRef.current = false
			result.current.disableAutoScrollRef.current = true
		})

		act(() => {
			setVisibility("hidden")
			document.dispatchEvent(new Event("visibilitychange"))
		})

		act(() => {
			setVisibility("visible")
			document.dispatchEvent(new Event("visibilitychange"))
			runPendingFrames()
		})

		expect(scrollToIndex).not.toHaveBeenCalled()
		// Ownership must survive too: clearing it would also silence the paging
		// that has to bring the rest of the conversation into the window.
		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	it("stays where the reader left it when they were browsing away from the bottom", () => {
		const { result } = renderScrollBehavior()
		const scrollToIndex = attachVirtuoso(result)

		act(() => {
			result.current.isAtBottomRef.current = false
			result.current.disableAutoScrollRef.current = true
		})

		act(() => {
			setVisibility("hidden")
			document.dispatchEvent(new Event("visibilitychange"))
		})

		act(() => {
			setVisibility("visible")
			document.dispatchEvent(new Event("visibilitychange"))
			runPendingFrames()
		})

		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("still restores the bottom for a reader who never took ownership", () => {
		const { result } = renderScrollBehavior()
		const scrollToIndex = attachVirtuoso(result)

		act(() => {
			result.current.isAtBottomRef.current = true
			result.current.disableAutoScrollRef.current = false
		})

		act(() => {
			setVisibility("hidden")
			document.dispatchEvent(new Event("visibilitychange"))
		})

		act(() => {
			setVisibility("visible")
			document.dispatchEvent(new Event("visibilitychange"))
			runPendingFrames()
		})

		expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ align: "end" }))
	})

	it("hands auto-follow back once the bottom has been restored", () => {
		const { result } = renderScrollBehavior()
		attachVirtuoso(result)

		act(() => {
			result.current.isAtBottomRef.current = true
			result.current.disableAutoScrollRef.current = true
		})

		act(() => {
			setVisibility("hidden")
			document.dispatchEvent(new Event("visibilitychange"))
		})

		act(() => {
			setVisibility("visible")
			document.dispatchEvent(new Event("visibilitychange"))
			runPendingFrames()
		})

		// Restoring the bottom without releasing ownership would leave streaming
		// output frozen behind the flag that was just acted upon.
		expect(result.current.disableAutoScrollRef.current).toBe(false)
	})

	it("abandons the restore when the reader takes the viewport back mid-retry", () => {
		// Only the retry timers are faked. Faking the clock wholesale would also
		// replace the animation frame that the stub above is standing in for.
		const pendingTimers: { at: number; run: () => void }[] = []
		let now = 0
		vi.stubGlobal("setTimeout", (run: () => void, delay = 0) => {
			pendingTimers.push({ at: now + delay, run })
			return pendingTimers.length
		})
		vi.stubGlobal("clearTimeout", (id: number) => {
			if (typeof id === "number" && pendingTimers[id - 1]) {
				pendingTimers[id - 1].run = () => undefined
			}
		})
		const advanceTimers = (ms: number) => {
			now += ms
			for (const timer of [...pendingTimers]) {
				if (timer.at <= now) {
					const run = timer.run
					timer.run = () => undefined
					run()
				}
			}
		}

		const { result } = renderScrollBehavior()
		const scrollToIndex = attachVirtuoso(result)

		act(() => {
			result.current.isAtBottomRef.current = true
			result.current.disableAutoScrollRef.current = true
		})

		act(() => {
			setVisibility("hidden")
			document.dispatchEvent(new Event("visibilitychange"))
		})

		act(() => {
			setVisibility("visible")
			document.dispatchEvent(new Event("visibilitychange"))
			runPendingFrames()
		})

		const attemptsBeforeTakeover = scrollToIndex.mock.calls.length
		expect(attemptsBeforeTakeover).toBeGreaterThan(0)

		// A restored panel settles late, so the restore keeps retrying for half a
		// second, and a reader who takes over during that window must not have
		// the viewport pulled back.
		//
		// The flag is raised directly here because every writer of it responds to
		// a wheel event scrolling up (`MessagesArea` and `createWheelHandler`) or
		// to an explicit navigation such as jumping to a message, toggling a row,
		// or the jump-to-top button. Dragging the scrollbar, pressing PageUp, and
		// touch scrolling reach none of them: `MessagesArea`'s scroll listener
		// only stamps a timestamp. Those gestures are covered by
		// `absoluteBottomLoadedRef` and the arbiter's own checks instead, so this
		// case asserts the remaining requirement — once the flag is set by any
		// means, a later attempt in the chain must recognise the takeover itself.
		act(() => {
			result.current.disableAutoScrollRef.current = true
			advanceTimers(1_000)
		})

		expect(scrollToIndex).toHaveBeenCalledTimes(attemptsBeforeTakeover)
		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	it("stops restoring once the reader leaves the bottom without raising the ownership flag", () => {
		let now = 0
		const pendingTimers: Array<{ at: number; run: () => void }> = []
		vi.spyOn(window, "setTimeout").mockImplementation(((run: () => void, delay = 0) => {
			pendingTimers.push({ at: now + delay, run })
			return pendingTimers.length as unknown as ReturnType<typeof setTimeout>
		}) as typeof window.setTimeout)
		const advanceTimers = (ms: number) => {
			now += ms
			for (const timer of [...pendingTimers]) {
				if (timer.at <= now) {
					const run = timer.run
					timer.run = () => undefined
					run()
				}
			}
		}

		const { result } = renderScrollBehavior()
		const scrollToIndex = attachVirtuoso(result)

		act(() => {
			result.current.isAtBottomRef.current = true
			result.current.absoluteBottomLoadedRef.current = true
			result.current.disableAutoScrollRef.current = true
		})

		act(() => {
			setVisibility("hidden")
			document.dispatchEvent(new Event("visibilitychange"))
		})

		act(() => {
			setVisibility("visible")
			document.dispatchEvent(new Event("visibilitychange"))
			runPendingFrames()
		})

		const attemptsBeforeTakeover = scrollToIndex.mock.calls.length
		expect(attemptsBeforeTakeover).toBeGreaterThan(0)

		// Dragging the scrollbar, pressing PageUp and touch scrolling move the
		// viewport without going through any writer of the ownership flag, so
		// the flag stays down and cannot end the retry chain. Virtuoso still
		// reports the reader is no longer at the bottom, and that has to be
		// enough: otherwise a later attempt drags them back to a position they
		// deliberately left.
		act(() => {
			result.current.isAtBottomRef.current = false
			advanceTimers(1_000)
		})

		expect(scrollToIndex).toHaveBeenCalledTimes(attemptsBeforeTakeover)
		expect(result.current.disableAutoScrollRef.current).toBe(false)
	})
})
