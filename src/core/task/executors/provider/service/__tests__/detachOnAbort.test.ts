import { describe, expect, it, vi } from "vitest"
import { detachOnAbort } from "../detachOnAbort"

/** A source whose pulls the test settles by hand, recording when it is closed. */
function manualSource<T>() {
	const pulls: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = []
	let closed = 0
	const iterator: AsyncIterator<T> = {
		next: () => new Promise((resolve, reject) => pulls.push({ resolve, reject })),
		return: async () => {
			closed += 1
			return { done: true, value: undefined }
		},
	}
	return {
		source: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<T>,
		pulls,
		closed: () => closed,
	}
}

describe("detachOnAbort", () => {
	it("passes values through and closes the source when the consumer stops early", async () => {
		const { source, pulls, closed } = manualSource<string>()
		const stream = detachOnAbort(source, new AbortController().signal)[Symbol.asyncIterator]()

		const first = stream.next()
		pulls[0].resolve({ done: false, value: "a" })
		expect(await first).toEqual({ done: false, value: "a" })

		await stream.return?.(undefined)
		expect(closed()).toBe(1)
	})

	it("ends at once on abort, discards the late value, and closes the source after the pending pull", async () => {
		const { source, pulls, closed } = manualSource<string>()
		const controller = new AbortController()
		const stream = detachOnAbort(source, controller.signal)[Symbol.asyncIterator]()

		const pending = stream.next()
		await vi.waitFor(() => expect(pulls).toHaveLength(1))
		controller.abort()
		expect(await pending).toEqual({ done: true, value: undefined })
		expect(closed()).toBe(0)

		pulls[0].resolve({ done: false, value: "late" })
		await vi.waitFor(() => expect(closed()).toBe(1))
		expect(await stream.next()).toEqual({ done: true, value: undefined })
	})

	it("observes a pull that rejects after the abort won, so no rejection goes unhandled", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		try {
			const { source, pulls, closed } = manualSource<string>()
			const controller = new AbortController()
			const stream = detachOnAbort(source, controller.signal)[Symbol.asyncIterator]()

			const pending = stream.next()
			await vi.waitFor(() => expect(pulls).toHaveLength(1))
			controller.abort()
			expect(await pending).toEqual({ done: true, value: undefined })

			pulls[0].reject(new Error("socket reset after cancel"))
			await vi.waitFor(() => expect(closed()).toBe(1))
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})

	it("removes its abort listener once each pull settles", async () => {
		const { source, pulls } = manualSource<string>()
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, "addEventListener")
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		const stream = detachOnAbort(source, controller.signal)[Symbol.asyncIterator]()

		for (const [index, value] of ["a", "b"].entries()) {
			const next = stream.next()
			await vi.waitFor(() => expect(pulls).toHaveLength(index + 1))
			pulls[index].resolve({ done: false, value })
			expect(await next).toEqual({ done: false, value })
		}
		const end = stream.next()
		await vi.waitFor(() => expect(pulls).toHaveLength(3))
		pulls[2].resolve({ done: true, value: undefined })
		expect(await end).toEqual({ done: true, value: undefined })

		expect(add).toHaveBeenCalledTimes(3)
		expect(remove).toHaveBeenCalledTimes(3)
	})

	it("rethrows a source failure that arrives before any abort", async () => {
		const { source, pulls, closed } = manualSource<string>()
		const stream = detachOnAbort(source, new AbortController().signal)[Symbol.asyncIterator]()

		const next = stream.next()
		await vi.waitFor(() => expect(pulls).toHaveLength(1))
		pulls[0].reject(new Error("provider failed"))
		await expect(next).rejects.toThrow("provider failed")
		expect(closed()).toBe(1)
	})
})
