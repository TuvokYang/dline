import { describe, expect, it, vi } from "vitest"
import { DlineUiPresence } from "../DlineUiPresence"

describe("DlineUiPresence", () => {
    it("runs waiting work once, when a Dline view is first shown", () => {
        const presence = new DlineUiPresence()
        const listener = vi.fn()
        presence.onFirstShown(listener)

        expect(presence.isShown).toBe(false)
        expect(listener).not.toHaveBeenCalled()

        presence.markShown()
        presence.markShown()

        expect(presence.isShown).toBe(true)
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it("runs work registered after a view was shown right away", () => {
        const presence = new DlineUiPresence()
        presence.markShown()
        const listener = vi.fn()

        presence.onFirstShown(listener)

        expect(listener).toHaveBeenCalledTimes(1)
    })

    it("does not run unsubscribed work and keeps running the rest when one listener throws", () => {
        const presence = new DlineUiPresence()
        const dropped = vi.fn()
        const later = vi.fn()
        presence.onFirstShown(dropped)()
        presence.onFirstShown(() => {
            throw new Error("boom")
        })
        presence.onFirstShown(later)

        presence.markShown()

        expect(dropped).not.toHaveBeenCalled()
        expect(later).toHaveBeenCalledTimes(1)
    })
})
