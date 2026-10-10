import { describe, expect, it } from "vitest"
import { shouldAcceptState } from "./ExtensionStateContext"

/** Verify Webview full-state snapshots advance monotonically. */
describe("shouldAcceptState", () => {
    /** Accept a strictly newer versioned state. */
    it("accepts a higher state revision", () => {
        expect(shouldAcceptState(4, 5)).toBe(true)
    })

    /** Reject duplicate and stale versioned states. */
    it("rejects equal and lower revisions", () => {
        expect(shouldAcceptState(5, 5)).toBe(false)
        expect(shouldAcceptState(5, 4)).toBe(false)
    })

    /** Accept legacy unversioned state only before any versioned state. */
    it("accepts legacy unversioned state only before a versioned state", () => {
        expect(shouldAcceptState(0, undefined)).toBe(true)
        expect(shouldAcceptState(5, undefined)).toBe(false)
    })
})
