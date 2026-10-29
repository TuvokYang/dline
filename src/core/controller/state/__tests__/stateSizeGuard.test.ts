import { describe, expect, it } from "vitest"
import type { ExtensionState } from "@/shared/ExtensionMessage"
import { degradeOversizedState, STATE_SIZE_DEGRADE_THRESHOLD_BYTES } from "../stateSizeGuard"

/**
 * Bounding the field that was found does not prevent the next unbounded one
 * from appearing. Serializing a multi-megabyte payload occupies the extension
 * host main thread, and field logs show it repeating several times a second
 * across concurrent tasks.
 *
 * Degrading is preferred to dropping: a webview that receives nothing renders
 * exactly the blank panel this workstream exists to remove.
 */

function buildState(overrides: Partial<ExtensionState> = {}): ExtensionState {
    return {
        stateRevision: 7,
        focusChainHistory: "history",
        taskHistory: [{ id: "task-1", ts: 1, task: "do a thing" }],
        ...overrides,
    } as ExtensionState
}

const OVER_THRESHOLD = STATE_SIZE_DEGRADE_THRESHOLD_BYTES + 1

describe("state size guard", () => {
    it("leaves a normal payload untouched", () => {
        const state = buildState()

        const result = degradeOversizedState(state, 1024)

        expect(result.state).toBe(state)
        expect(result.droppedFields).toEqual([])
        expect(result.state.stateDegraded).toBeUndefined()
    })

    it("marks a degraded payload so absent data is not read as empty data", () => {
        const result = degradeOversizedState(buildState(), OVER_THRESHOLD)

        expect(result.state.stateDegraded).toBe(true)
        expect(result.droppedFields.length).toBeGreaterThan(0)
    })

    /**
     * The caller keeps this object for later pushes. Degrading it in place
     * would make one oversized push permanently lose the data.
     */
    it("does not mutate the caller's state", () => {
        const state = buildState()

        degradeOversizedState(state, OVER_THRESHOLD)

        expect(state.focusChainHistory).toBe("history")
        expect(state.taskHistory).toHaveLength(1)
        expect(state.stateDegraded).toBeUndefined()
    })

    it("gives up bulk display data before anything else", () => {
        const result = degradeOversizedState(buildState(), OVER_THRESHOLD)

        expect(result.droppedFields[0]).toBe("focusChainHistory")
        expect(result.state.focusChainHistory).toBeNull()
    })

    /**
     * Identity and revision are how the webview decides whether a payload is
     * current. Degrading must not touch them, or a reduced push would be
     * indistinguishable from a stale one.
     */
    it("preserves the fields the webview needs to accept the payload", () => {
        const result = degradeOversizedState(buildState({ stateRevision: 42 }), OVER_THRESHOLD)

        expect(result.state.stateRevision).toBe(42)
    })

    /**
     * A payload only slightly over the limit should keep as much as it can, so
     * dropping stops once the payload fits.
     */
    it("stops dropping as soon as the payload fits", () => {
        const state = buildState({ focusChainHistory: "x".repeat(200) })

        // Threshold small enough that dropping the first field is sufficient.
        const result = degradeOversizedState(state, 300, 150)

        expect(result.droppedFields).toEqual(["focusChainHistory"])
        expect(result.state.taskHistory).toHaveLength(1)
    })

    it("keeps dropping while the payload is still too large", () => {
        const state = buildState({
            focusChainHistory: "x".repeat(500),
            taskHistory: Array.from({ length: 50 }, (_, index) => ({
                id: `task-${index}`,
                ts: index,
                task: "y".repeat(50),
            })),
        } as Partial<ExtensionState>)

        const result = degradeOversizedState(state, 10_000, 200)

        expect(result.droppedFields).toEqual(["focusChainHistory", "taskHistory"])
        expect(result.state.taskHistory).toEqual([])
    })

    it("empties a list field rather than replacing it with null", () => {
        // The webview iterates task history; a null would throw where an empty
        // list simply renders nothing.
        const result = degradeOversizedState(buildState(), OVER_THRESHOLD, 1)

        expect(Array.isArray(result.state.taskHistory)).toBe(true)
    })

    it("skips fields that are already absent", () => {
        const result = degradeOversizedState(buildState({ focusChainHistory: undefined }), OVER_THRESHOLD)

        expect(result.droppedFields).not.toContain("focusChainHistory")
    })

    /**
     * This runs on the delivery path. A guard that threw would take down the
     * state stream it exists to protect.
     */
    it("does not throw on a state that cannot be serialized", () => {
        const cyclic = buildState() as ExtensionState & { self?: unknown }
        cyclic.self = cyclic

        expect(() => degradeOversizedState(cyclic, OVER_THRESHOLD)).not.toThrow()
    })
})
