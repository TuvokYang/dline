import { describe, expect, it, vi } from "vitest"
import { SessionResourceScope } from "./SessionResourceScope"

describe("SessionResourceScope", () => {
	it("rolls back every acquisition once, in reverse order, despite synchronous or async failures", async () => {
		const scope = new SessionResourceScope()
		const order: string[] = []
		const firstFailure = new Error("first close failed")
		const lastFailure = new Error("last close failed")
		scope.add({
			release: async () => {
				order.push("first")
				throw firstFailure
			},
		})
		scope.add({ release: async () => void order.push("middle") })
		scope.add({
			release: () => {
				order.push("last")
				throw lastFailure
			},
		})

		const firstRelease = scope.release()
		expect(scope.release()).toBe(firstRelease)
		const failure = await firstRelease.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(AggregateError)
		expect((failure as AggregateError).errors).toEqual([lastFailure, firstFailure])
		expect(order).toEqual(["last", "middle", "first"])
		await expect(scope.release()).rejects.toBe(failure)
		expect(order).toHaveLength(3)
	})

	it("refuses new acquisitions once rollback has started", async () => {
		const scope = new SessionResourceScope()
		const release = vi.fn(async () => undefined)
		scope.add({ release })
		const closing = scope.release()
		expect(() => scope.add({ release })).toThrow("already closing")
		await closing
		expect(release).toHaveBeenCalledOnce()
	})
})
