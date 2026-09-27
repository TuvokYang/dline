import { describe, expect, it } from "vitest"
import { toAccountUsage as toClaudeAccountUsage } from "../usage"

/**
 * A per-model weekly cap stops that model family only; the shared five-hour and
 * weekly windows are what block the whole subscription.
 */
describe("Claude Code subscription blocking", () => {
	const shared = { fiveHour: { utilization: 20 }, sevenDay: { utilization: 3 } }

	it("keeps the subscription usable when only a model-scoped cap is exhausted", () => {
		const usage = toClaudeAccountUsage({ ...shared, scopedWeekly: [{ modelName: "Fable", utilization: 100 }] })

		expect(usage.limitReached).toBe(false)
		expect(usage.allowed).toBe(true)
	})

	it("blocks the subscription when a shared window is exhausted", () => {
		const usage = toClaudeAccountUsage({ ...shared, sevenDay: { utilization: 100 } })

		expect(usage.limitReached).toBe(true)
		expect(usage.allowed).toBe(false)
	})
})

import { ClaudeCodeUsageClient, ClaudeCodeUsageError, parseClaudeCodeUsage, toAccountUsage } from "../usage"

/**
 * The subscription usage snapshot, shaped like the upstream account endpoint.
 *
 * Utilization is a percentage of the window's allowance, and each window
 * reports its own reset instant.
 */
const UPSTREAM_SNAPSHOT = {
	five_hour: { utilization: 12.5, resets_at: "2026-07-03T10:00:00Z" },
	seven_day: { utilization: 34, resets_at: "2026-07-08T00:00:00Z" },
	// The legacy per-family fields are always null now; the caps live in limits[].
	seven_day_opus: null,
	seven_day_sonnet: null,
	limits: [
		{ kind: "session", percent: 12, resets_at: "2026-07-03T10:00:00Z", scope: null, is_active: false },
		{ kind: "weekly_all", percent: 34, resets_at: "2026-07-08T00:00:00Z", scope: null, is_active: false },
		{
			kind: "weekly_scoped",
			percent: 43,
			resets_at: "2026-07-08T00:00:00Z",
			scope: { model: { id: null, display_name: "Fable" } },
			is_active: true,
		},
	],
}

describe("parseClaudeCodeUsage", () => {
	it("reads every window the account endpoint reports", () => {
		const snapshot = parseClaudeCodeUsage(UPSTREAM_SNAPSHOT)

		expect(snapshot.fiveHour).toEqual({ utilization: 12.5, resetsAt: "2026-07-03T10:00:00Z" })
		expect(snapshot.sevenDay).toEqual({ utilization: 34, resetsAt: "2026-07-08T00:00:00Z" })
		expect(snapshot.scopedWeekly).toEqual([{ modelName: "Fable", utilization: 43, resetsAt: "2026-07-08T00:00:00Z" }])
	})

	it("skips a scoped cap that names no model or carries no usable percentage", () => {
		const snapshot = parseClaudeCodeUsage({
			limits: [
				{ kind: "weekly_scoped", percent: 10, scope: null },
				{ kind: "weekly_scoped", percent: "10", scope: { model: { display_name: "Fable" } } },
			],
		})

		expect(snapshot.scopedWeekly).toBeUndefined()
	})

	it("keeps a window that reports no reset instant", () => {
		expect(parseClaudeCodeUsage({ five_hour: { utilization: 4 } }).fiveHour).toEqual({ utilization: 4 })
	})

	it("drops a window whose utilization is not a finite number", () => {
		const snapshot = parseClaudeCodeUsage({
			five_hour: { utilization: "12.5" },
			seven_day: { utilization: Number.NaN },
		})

		expect(snapshot.fiveHour).toBeUndefined()
		expect(snapshot.sevenDay).toBeUndefined()
	})

	it("returns an empty snapshot for a response that is not an object", () => {
		expect(parseClaudeCodeUsage("nope")).toEqual({})
		expect(parseClaudeCodeUsage(null)).toEqual({})
		expect(parseClaudeCodeUsage([{ five_hour: { utilization: 1 } }])).toEqual({})
	})
})

describe("toAccountUsage", () => {
	it("projects each window onto the quota type the shared usage UI selects on", () => {
		const quotas = toAccountUsage(parseClaudeCodeUsage(UPSTREAM_SNAPSHOT)).quotas ?? []

		// The chat usage bar and the settings summary both branch on these exact
		// type strings, so a differently spelled type renders as an unnamed
		// window and never wins the "most constrained" selection.
		expect(quotas.map((quota) => quota.type)).toEqual(["5hour", "weekly", "weekly_scoped"])
		// Claude counts calendar weeks, so it says "week" where Codex says "7 day".
		expect(quotas.map((quota) => quota.label)).toEqual(["5 hour", "This week", "Fable this week"])
		expect(quotas.map((quota) => quota.shortLabel)).toEqual(["5h", "week", "Fable week"])
	})

	it("reports utilization against the full percentage scale with the window length", () => {
		const quotas = toAccountUsage(parseClaudeCodeUsage(UPSTREAM_SNAPSHOT)).quotas ?? []

		expect(quotas[0]).toEqual({
			type: "5hour",
			label: "5 hour",
			shortLabel: "5h",
			used: 12.5,
			limit: 100,
			windowSeconds: 18_000,
			resetAt: "2026-07-03T10:00:00Z",
		})
		expect(quotas[1]?.windowSeconds).toBe(604_800)
	})

	it("marks the account unavailable when no window was reported", () => {
		const usage = toAccountUsage({})

		expect(usage.isAvailable).toBe(false)
		expect(usage.quotas).toBeUndefined()
		expect(usage.limitReached).toBe(false)
		expect(usage.allowed).toBe(true)
	})

	it("reports an exhausted subscription once any window reaches its allowance", () => {
		const usage = toAccountUsage(parseClaudeCodeUsage({ five_hour: { utilization: 100 }, seven_day: { utilization: 3 } }))

		expect(usage.limitReached).toBe(true)
		expect(usage.allowed).toBe(false)
	})

	it("omits reset credits entirely, which the shared UI reads as an unsupported capability", () => {
		const usage = toAccountUsage(parseClaudeCodeUsage(UPSTREAM_SNAPSHOT))

		// An empty list would render as "Reset cards: none" and imply the
		// subscription has a reset capability that is currently exhausted.
		expect(usage.resetCredits).toBeUndefined()
		expect(usage.resetCreditsAvailableCount).toBeUndefined()
	})
})

describe("ClaudeCodeUsageClient", () => {
	const clientVersion = "2.1.280"

	it("authenticates with the subscription token and the Claude Code client identity", async () => {
		let observed: { url: string; init: RequestInit } | undefined
		const client = new ClaudeCodeUsageClient({
			usageUrl: "https://example.invalid/api/usage",
			fetchImpl: (async (url: string, init: RequestInit) => {
				observed = { url, init }
				return new Response(JSON.stringify(UPSTREAM_SNAPSHOT), { status: 200 })
			}) as never,
		})

		await client.fetchUsage("token-abc", clientVersion)

		expect(observed?.url).toBe("https://example.invalid/api/usage")
		const headers = observed?.init.headers as Record<string, string>
		expect(headers.Authorization).toBe("Bearer token-abc")
		expect(headers["anthropic-beta"]).toContain("oauth")
		expect(headers["User-Agent"]).toContain(clientVersion)
	})

	it("surfaces only the status when upstream rejects the request", async () => {
		const client = new ClaudeCodeUsageClient({
			usageUrl: "https://example.invalid/api/usage",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ account: { email: "user@example.com" } }), { status: 401 })) as never,
		})

		const error = await client.fetchUsage("token-abc", clientVersion).catch((caught) => caught)

		expect(error).toBeInstanceOf(ClaudeCodeUsageError)
		expect((error as ClaudeCodeUsageError).status).toBe(401)
		// The body may echo account details, so it must not reach the message.
		expect((error as ClaudeCodeUsageError).message).not.toContain("user@example.com")
	})

	it("reports a transport failure without leaking the underlying cause", async () => {
		const client = new ClaudeCodeUsageClient({
			usageUrl: "https://example.invalid/api/usage",
			fetchImpl: (async () => {
				throw new Error("connect ECONNREFUSED 10.0.0.1:443")
			}) as never,
		})

		const error = await client.fetchUsage("token-abc", clientVersion).catch((caught) => caught)

		expect(error).toBeInstanceOf(ClaudeCodeUsageError)
		// A transport failure carries no upstream status, and the raw cause can
		// name internal hosts, so it is reported as an unavailable snapshot.
		expect((error as ClaudeCodeUsageError).status).toBeUndefined()
		expect((error as ClaudeCodeUsageError).message).not.toContain("ECONNREFUSED")
	})

	it("bounds the request when the caller supplies no abort signal", async () => {
		let observedSignal: AbortSignal | undefined
		const client = new ClaudeCodeUsageClient({
			usageUrl: "https://example.invalid/api/usage",
			fetchImpl: (async (_url: string, init: RequestInit) => {
				observedSignal = init.signal ?? undefined
				return new Response(JSON.stringify(UPSTREAM_SNAPSHOT), { status: 200 })
			}) as never,
		})

		await client.fetchUsage("token-abc", clientVersion)

		// Without a deadline a stalled account endpoint would hold the panel in
		// its loading state indefinitely.
		expect(observedSignal).toBeInstanceOf(AbortSignal)
	})

	it("passes the caller's abort signal through so a closing panel cancels the read", async () => {
		const controller = new AbortController()
		let observedSignal: AbortSignal | undefined
		const client = new ClaudeCodeUsageClient({
			usageUrl: "https://example.invalid/api/usage",
			fetchImpl: (async (_url: string, init: RequestInit) => {
				observedSignal = init.signal ?? undefined
				return new Response(JSON.stringify(UPSTREAM_SNAPSHOT), { status: 200 })
			}) as never,
		})

		await client.fetchUsage("token-abc", clientVersion, controller.signal)

		expect(observedSignal).toBe(controller.signal)
	})
})
