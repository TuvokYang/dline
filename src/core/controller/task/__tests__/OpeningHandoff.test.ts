import { describe, expect, it, vi } from "vitest"
import { OpeningHandoff } from "../OpeningHandoff"

/** A promise the test settles by hand, standing in for the handoff's async work. */
function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((settle, fail) => {
        resolve = settle
        reject = fail
    })
    return { promise, resolve, reject }
}

describe("OpeningHandoff", () => {
    it("holds nothing outside a handoff", () => {
        const handoff = new OpeningHandoff()

        expect(handoff.holds(false)).toBe(false)
        expect(handoff.holds(true)).toBe(false)
    })

    it("holds a publication while no opening exists and publishes it once the handoff settles", async () => {
        const handoff = new OpeningHandoff()
        const work = deferred()
        const publish = vi.fn(async () => {})

        const running = handoff.run(() => work.promise, publish)
        expect(handoff.holds(false)).toBe(true)
        expect(handoff.holds(false)).toBe(true)
        expect(publish).not.toHaveBeenCalled()

        work.resolve()
        await running
        expect(publish).toHaveBeenCalledTimes(1)
        expect(handoff.holds(false)).toBe(false)
    })

    it("lets a publication through once the new opening is installed", async () => {
        const handoff = new OpeningHandoff()
        const work = deferred()
        const publish = vi.fn(async () => {})

        const running = handoff.run(() => work.promise, publish)
        expect(handoff.holds(true)).toBe(false)
        work.resolve()
        await running

        expect(publish).not.toHaveBeenCalled()
    })

    // A failure leaves the old opening torn down; the Webview must learn it
    // even when nothing asked to publish during the handoff.
    it("publishes once when the handoff fails although nothing was held, and reports the failure", async () => {
        const handoff = new OpeningHandoff()
        const publish = vi.fn(async () => {})

        await expect(handoff.run(async () => Promise.reject(new Error("task open failed")), publish)).rejects.toThrow(
            "task open failed",
        )
        expect(publish).toHaveBeenCalledTimes(1)
    })

    it("reports the handoff's own failure when the publication after it fails too", async () => {
        const handoff = new OpeningHandoff()
        const opening = new Error("task open failed")

        const running = handoff.run(
            async () => Promise.reject(opening),
            async () => Promise.reject(new Error("state build failed")),
        )

        await expect(running).rejects.toBe(opening)
    })

    it("reports a failed publication after a successful handoff", async () => {
        const handoff = new OpeningHandoff()
        const work = deferred()

        const running = handoff.run(
            () => work.promise,
            async () => Promise.reject(new Error("state build failed")),
        )
        handoff.holds(false)
        work.resolve()

        await expect(running).rejects.toThrow("state build failed")
    })
})
