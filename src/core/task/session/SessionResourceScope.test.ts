import { describe, expect, it, vi } from "vitest"
import { SessionResourceScope } from "./SessionResourceScope"

describe("SessionResourceScope", () => {
    it("retries only failed releases in reverse acquisition order", async () => {
        const scope = new SessionResourceScope()
        const order: string[] = []
        const firstFailure = new Error("first close failed")
        const lastFailure = new Error("last close failed")
        let firstAttempts = 0
        let lastAttempts = 0
        scope.add({
            release: async () => {
                order.push("first")
                if (firstAttempts++ === 0) throw firstFailure
            },
        })
        scope.add({ release: async () => void order.push("middle") })
        scope.add({
            release: async () => {
                order.push("last")
                if (lastAttempts++ === 0) throw lastFailure
            },
        })

        const firstRelease = scope.release()
        expect(scope.release()).toBe(firstRelease)
        const failure = await firstRelease.catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([lastFailure, firstFailure])
        expect(order).toEqual(["last", "middle", "first"])

        await expect(scope.release()).resolves.toBeUndefined()
        expect(order).toEqual(["last", "middle", "first", "last", "first"])
        await expect(scope.release()).resolves.toBeUndefined()
        expect(order).toHaveLength(5)
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
