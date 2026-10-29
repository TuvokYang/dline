import { describe, expect, it } from "vitest"
import { isExecutionAbort } from "./contracts"

describe("executor cancellation classification", () => {
    it("requires an abort causally owned by the signal", () => {
        const controller = new AbortController()
        const namedAbort = Object.assign(new Error("transport abort"), { name: "AbortError" })
        expect(isExecutionAbort(namedAbort, controller.signal)).toBe(false)

        controller.abort("cancelled")
        expect(isExecutionAbort(new Error("any failure"), controller.signal)).toBe(false)
        expect(isExecutionAbort(controller.signal.reason, controller.signal)).toBe(true)
        expect(isExecutionAbort(namedAbort, controller.signal)).toBe(true)
    })
})
