import {
	allowsAccountUsagePolling,
	applyLocalDailyTokens,
	decideAccountUsageRead,
	decorateProviderAccountUsage,
} from "@core/account-usage/provider-usage"
import type { ApiHandlerContext } from "@core/api"
import { ClaudeCodeHandler } from "@core/api/providers/claude-code"
import type { ApiProfile } from "@shared/proto/dline/profile"
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

/**
 * Refusing the timer is not the same as refusing to read.
 *
 * The chat input bar renders only from the snapshot the Controller publishes,
 * so a provider that opted out of polling and was therefore never read left the
 * bar with nothing to show. These cases pin the scheduling rule itself, because
 * the decision function above answers correctly either way and cannot catch a
 * caller that turns "do not repeat" into "never read".
 */
describe("account usage read scheduling", () => {
	it("reads an opted-out provider on the first tick so the chat bar has a snapshot", () => {
		const handler = createClaudeCodeHandler()

		expect(decideAccountUsageRead(handler, "profile-a", undefined)).toBe("read")
	})

	it("skips the repeat once that Profile has been read", () => {
		const handler = createClaudeCodeHandler()

		// The repeats are what would spend the subscription budget that also
		// serves conversations; the first reading stays published.
		expect(decideAccountUsageRead(handler, "profile-a", "profile-a")).toBe("skip")
	})

	it("reads again when the Profile or credential changed", () => {
		const handler = createClaudeCodeHandler()

		// A restart clears the marker, and a different Profile never matched it.
		expect(decideAccountUsageRead(handler, "profile-b", "profile-a")).toBe("read")
		expect(decideAccountUsageRead(handler, "profile-a", undefined)).toBe("read")
	})

	it("keeps reading on every tick for a provider that allows polling", () => {
		const handler = { getAccountUsage: async () => undefined }

		expect(decideAccountUsageRead(handler, "profile-a", "profile-a")).toBe("read")
	})

	it("skips a handler that cannot report usage even on the first tick", () => {
		expect(decideAccountUsageRead({}, "profile-a", undefined)).toBe("skip")
	})

	it("still allows a read after one that produced nothing", () => {
		const handler = createClaudeCodeHandler()

		// The Controller marks the Profile only once a reading arrives, so a
		// failed or cancelled first attempt must not retire the one read this
		// Profile is owed. Passing `undefined` is what that unmarked state
		// looks like on the next tick.
		expect(decideAccountUsageRead(handler, "profile-a", undefined)).toBe("read")
	})
})

/**
 * The snapshot is held until the user refreshes it, so it has to carry the time
 * it was read. Stamping it at this shared boundary is what lets the chat bar,
 * its tooltip, and the settings panel agree on the age of one reading.
 */
describe("account usage read time", () => {
	const profile = { id: "profile-a", provider: "claude-code" } as ApiProfile

	it("stamps the read time onto a provider snapshot", () => {
		const before = Date.now()

		const usage = decorateProviderAccountUsage(profile, { currency: "USD" })

		expect(Date.parse(usage?.retrievedAt ?? "")).toBeGreaterThanOrEqual(before)
	})

	it("keeps a retrieval time the provider reported itself", () => {
		const usage = decorateProviderAccountUsage(profile, { currency: "USD", retrievedAt: "2026-01-01T00:00:00.000Z" })

		expect(usage?.retrievedAt).toBe("2026-01-01T00:00:00.000Z")
	})

	it("reports nothing for an absent snapshot", () => {
		expect(decorateProviderAccountUsage(profile, undefined)).toBeUndefined()
	})
})

/**
 * Subscription endpoints report percentages only, so today's token counts for
 * them come from Dline's own ledger. Balance providers report their own.
 */
describe("local daily tokens", () => {
	const today = { inputTokens: 1_500, outputTokens: 80 }
	const quota = { type: "5hour", label: "5 hour", used: 10, limit: 100 }

	it("fills a subscription snapshot from the local ledger", () => {
		const usage = applyLocalDailyTokens({ currency: "USD", quotas: [quota] }, today)

		expect(usage).toMatchObject({ dailyInputTokens: 1_500, dailyOutputTokens: 80 })
	})

	it("leaves a balance snapshot's own daily counts untouched", () => {
		const balance = { currency: "CNY", remainingBalance: 10, dailyInputTokens: 9, dailyOutputTokens: 1 }

		expect(applyLocalDailyTokens(balance, today)).toBe(balance)
	})

	it("does not invent counts for a balance provider that reports none", () => {
		const balance = { currency: "CNY", remainingBalance: 10 }

		expect(applyLocalDailyTokens(balance, today)).toBe(balance)
	})
})
