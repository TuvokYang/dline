import { describe, expect, it } from "vitest"
import { createMessageWindowGeneration } from "./messageWindowGeneration"

describe("messageWindowGeneration", () => {
    it("lets every page captured for one window apply until navigation moves on", () => {
        const generation = createMessageWindowGeneration()
        const leading = generation.capture()
        const trailing = generation.capture()

        expect(generation.isCurrent(leading)).toBe(true)
        expect(generation.isCurrent(trailing)).toBe(true)

        generation.advance()
        expect(generation.isCurrent(leading)).toBe(false)
        expect(generation.isCurrent(trailing)).toBe(false)
    })

    it("holds paging back while a replacement is in flight and resumes once it settles", () => {
        const generation = createMessageWindowGeneration()
        const jump = generation.replace()
        expect(generation.replacementPending).toBe(true)

        generation.settle(jump)
        expect(generation.replacementPending).toBe(false)
    })

    it("lets only the latest replacement settle, and lets a later navigation cancel a pending one", () => {
        const generation = createMessageWindowGeneration()
        const first = generation.replace()
        const second = generation.replace()

        generation.settle(first)
        expect(generation.replacementPending).toBe(true)
        expect(generation.isCurrent(first)).toBe(false)

        // A loaded-turn click after an unloaded jump: the pending page must never replace the window.
        generation.advance()
        expect(generation.isCurrent(second)).toBe(false)
        expect(generation.replacementPending).toBe(false)
        generation.settle(second)
        expect(generation.replacementPending).toBe(false)
    })
})
