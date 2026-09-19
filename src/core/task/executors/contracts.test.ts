import { describe, expect, it } from "vitest"
import { isExecutionAbort } from "./contracts"

describe("executor cancellation classification", () => {
	it("requires the owned signal to be aborted", () => {
		const controller = new AbortController()
		const namedAbort = Object.assign(new Error("transport abort"), { name: "AbortError" })
		expect(isExecutionAbort(namedAbort, controller.signal)).toBe(false)
		controller.abort("cancelled")
		expect(isExecutionAbort(new Error("any failure"), controller.signal)).toBe(true)
	})
})
