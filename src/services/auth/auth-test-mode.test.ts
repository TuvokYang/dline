import { describe, expect, it } from "vitest"
import { isE2EAuthMockEnabled } from "./auth-test-mode"

describe("isE2EAuthMockEnabled", () => {
	it("allows explicit E2E mode for a production-built extension", () => {
		expect(isE2EAuthMockEnabled({ E2E_TEST: "true", DLINE_ENVIRONMENT: "production" })).toBe(true)
	})

	it.each([undefined, "", "false", "1"])("rejects non-explicit E2E_TEST value %s", (value) => {
		expect(isE2EAuthMockEnabled({ E2E_TEST: value, DLINE_ENVIRONMENT: "local" })).toBe(false)
	})
})
