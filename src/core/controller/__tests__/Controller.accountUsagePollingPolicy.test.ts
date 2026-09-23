import { allowsAccountUsagePolling } from "@core/account-usage/provider-usage"
import type { ApiHandlerContext } from "@core/api"
import { ClaudeCodeHandler } from "@core/api/providers/claude-code"
import { describe, expect, it } from "vitest"

/** The handler only stores its context, so an unused Profile is enough here. */
function createClaudeCodeHandler(): ClaudeCodeHandler {
	const ctx = { profile: { id: "profile-under-test", provider: "claude-code" } } as unknown as ApiHandlerContext
	return new ClaudeCodeHandler(ctx)
}

/**
 * The polling opt-out is a contract between the provider and the Controller:
 * the provider declares the policy, `allowsAccountUsagePolling` decides, and
 * `Controller.pollAccountUsage` is the only caller that acts on it. Testing the
 * shared decision plus the Claude Code declaration keeps a future edit to
 * either side from silently restoring a timer against a metered subscription.
 */
describe("account usage polling policy", () => {
	it("keeps Claude Code usage out of background polling while still exposing it", () => {
		const handler = createClaudeCodeHandler()

		expect(allowsAccountUsagePolling(handler)).toBe(false)
		// Opting out of the timer must not remove the capability itself; the
		// manual refresh RPC resolves the same method.
		expect(typeof handler.getAccountUsage).toBe("function")
	})

	it("polls a handler that exposes usage without opting out", () => {
		const handler = { getAccountUsage: async () => undefined }

		expect(allowsAccountUsagePolling(handler)).toBe(true)
	})

	it("skips a handler that cannot report usage at all", () => {
		expect(allowsAccountUsagePolling({})).toBe(false)
	})
})
