import type { AccountUsageData } from "@shared/ExtensionMessage"

/**
 * Storybook fixtures for the three usage shapes Dline renders.
 *
 * Kept in one place so the chat bar and the usage card stories show the same
 * accounts; otherwise the two surfaces drift and a review compares unrelated
 * numbers.
 */

/** A reading taken a few minutes ago, so the "Updated" line renders. */
const recentlyRetrievedAt = new Date(Date.now() - 12 * 60_000).toISOString()

/** Balance account (DeepSeek): no plan, so the balance and daily tokens are shown. */
export const balanceUsageFixture: AccountUsageData = {
	profileId: "profile-story",
	providerId: "deepseek",
	currency: "CNY",
	remainingBalance: 86.42,
	toppedUpBalance: 80,
	grantedBalance: 6.42,
	isAvailable: true,
	dailyInputTokens: 1_284_300,
	dailyOutputTokens: 96_512,
	retrievedAt: recentlyRetrievedAt,
}

/** Codex windows are rolling durations, so its weekly window reads "7 day". */
export const codexUsageFixture: AccountUsageData = {
	profileId: "profile-story",
	providerId: "openai-codex",
	currency: "",
	planType: "plus",
	isAvailable: true,
	retrievedAt: recentlyRetrievedAt,
	// Counted by Dline from its own requests; the subscription reports none.
	dailyInputTokens: 2_486_120,
	dailyOutputTokens: 41_380,
	quotas: [
		{ type: "5hour", label: "5 hour", shortLabel: "5h", used: 20, limit: 100, resetAt: "2030-01-01T12:00:00.000Z" },
		{ type: "weekly", label: "7 day", shortLabel: "7d", used: 83, limit: 100, resetAt: "2030-01-07T12:00:00.000Z" },
	],
	resetCreditsAvailableCount: 2,
	resetCredits: [
		{ id: "credit-story-1", expiresAt: "2030-03-25T00:00:00.000Z" },
		{ id: "credit-story-2", expiresAt: "2030-04-02T00:00:00.000Z" },
	],
}

/**
 * Claude counts calendar weeks and adds a weekly cap per model family, so its
 * windows read "This week" and "Fable this week" rather than "7 day".
 */
export const claudeUsageFixture: AccountUsageData = {
	profileId: "profile-story",
	providerId: "claude-code",
	currency: "USD",
	isAvailable: true,
	retrievedAt: recentlyRetrievedAt,
	dailyInputTokens: 18_734_902,
	dailyOutputTokens: 212_455,
	quotas: [
		// Unused, so the chat bar does not prefer it: an active five-hour
		// window wins the bar, and these stories are meant to show "week".
		{ type: "5hour", label: "5 hour", shortLabel: "5h", used: 0, limit: 100, resetAt: "2030-01-01T12:00:00.000Z" },
		{
			type: "weekly",
			label: "This week",
			shortLabel: "week",
			used: 80,
			limit: 100,
			resetAt: "2030-01-07T12:00:00.000Z",
		},
		{
			type: "weekly_scoped",
			label: "Fable this week",
			shortLabel: "Fable week",
			used: 43,
			limit: 100,
			resetAt: "2030-01-07T12:00:00.000Z",
		},
	],
}

/** The same Claude account after its Fable cap ran out. */
export const claudeFableExhaustedUsageFixture: AccountUsageData = {
	...claudeUsageFixture,
	quotas: claudeUsageFixture.quotas?.map((quota) => (quota.type === "weekly_scoped" ? { ...quota, used: 100 } : quota)),
}
