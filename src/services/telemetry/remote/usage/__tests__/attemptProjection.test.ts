import { describe, expect, it } from "vitest"
import { validateTaskAttempts } from "../../contracts/usageExecution"
import { createAttemptAccumulator, isEmptyAttempts, mergeAttempts, observeAttempt, sealAttempts } from "../attemptProjection"

describe("attempt distribution", () => {
    it("samples taskAttempt plus one so a first-try request counts one attempt", () => {
        const accumulator = createAttemptAccumulator()
        observeAttempt(accumulator, 0)
        observeAttempt(accumulator, 2)

        expect(sealAttempts(accumulator, 2)).toEqual({ count: 2, sum: 4, min: 1, max: 3 })
    })

    it("rejects an attempts sample that cannot describe a request", () => {
        const accumulator = createAttemptAccumulator()

        expect(() => observeAttempt(accumulator, -1)).toThrow()
        expect(() => observeAttempt(accumulator, 1.5)).toThrow()
    })

    it("refuses to seal a distribution that disagrees with the fact request total", () => {
        const accumulator = createAttemptAccumulator()
        observeAttempt(accumulator, 0)

        expect(() => sealAttempts(accumulator, 2)).toThrow()
    })

    it("produces a distribution the wire validator accepts", () => {
        const accumulator = createAttemptAccumulator()
        for (const attempt of [0, 0, 1, 3]) observeAttempt(accumulator, attempt)

        const sealed = sealAttempts(accumulator, 4)

        expect(sealed).toEqual({ count: 4, sum: 8, min: 1, max: 4 })
        expect(validateTaskAttempts(sealed)).toEqual([])
    })

    it("stays empty when no logical request settled", () => {
        const accumulator = createAttemptAccumulator()

        expect(isEmptyAttempts(accumulator)).toBe(true)
        expect(sealAttempts(accumulator, 0)).toEqual({ count: 0, sum: 0, min: 0, max: 0 })
    })

    it("merges two minutes without losing the extremes", () => {
        const first = createAttemptAccumulator()
        observeAttempt(first, 0)
        observeAttempt(first, 4)
        const second = createAttemptAccumulator()
        observeAttempt(second, 2)

        const merged = mergeAttempts(first, second)

        expect(merged).toEqual({ count: 3, sum: 1 + 5 + 3, min: 1, max: 5 })
        expect(validateTaskAttempts(merged)).toEqual([])
    })
})
