import { describe, expect, it } from "vitest"
import { ContextTransitionLease } from "../ContextTransitionLease"

/** Verify Profile and Mode transitions share one task-local ownership fence. */
describe("ContextTransitionLease", () => {
    it("allows only one transition owner until the matching operation releases", () => {
        const lease = new ContextTransitionLease()
        const modeOwner = { kind: "mode" as const, operationId: "mode-1", taskId: "task-1" }
        const profileOwner = { kind: "profile" as const, operationId: "profile-1", taskId: "task-1" }

        expect(lease.acquire(modeOwner)).toBe(true)
        expect(lease.acquire(profileOwner)).toBe(false)
        expect(lease.getActive()).toEqual(modeOwner)

        lease.release("stale-operation")
        expect(lease.getActive()).toEqual(modeOwner)

        lease.release("mode-1")
        expect(lease.acquire(profileOwner)).toBe(true)
        expect(lease.getActive()).toEqual(profileOwner)
    })
})
