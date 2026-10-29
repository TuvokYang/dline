import { describe, expect, it } from "vitest"
import { selectFocusChainInstructionPolicy } from "../instruction-policy"

describe("focus-chain instruction policy", () => {
    it("requires progress only conditionally while work remains", () => {
        expect(selectFocusChainInstructionPolicy(2, 5)).toEqual({
            kind: "progress",
            requireTaskProgressWhenSupported: true,
        })
    })

    it("switches a complete checklist to terminal guidance without requiring task_progress", () => {
        expect(selectFocusChainInstructionPolicy(5, 5)).toEqual({
            kind: "terminal",
            requireTaskProgressWhenSupported: false,
        })
    })
})
