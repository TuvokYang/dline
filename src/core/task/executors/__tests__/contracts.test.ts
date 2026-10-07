import { Logger } from "@shared/services/Logger"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProfileNotValidError } from "../../profile-admission"
import { executorFailure } from "../contracts"

describe("executorFailure", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("reports a fault of the execution as an error", () => {
		const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)

		expect(executorFailure("provider", new TypeError("boom"))).toBe("provider execution failed (TypeError)")

		expect(error).toHaveBeenCalledOnce()
		expect(warn).not.toHaveBeenCalled()
	})

	// The user is shown a Profile refusal and fixes it there; logging it as an
	// error would report a user-correctable state as a runtime fault.
	it("reports a Profile that cannot admit the request as a warning", () => {
		const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		const refusal = new ProfileNotValidError("Profile not valid: credentials are missing")

		expect(executorFailure("provider", refusal)).toBe(`provider execution failed (${refusal.name})`)

		expect(warn).toHaveBeenCalledOnce()
		expect(error).not.toHaveBeenCalled()
	})
})
