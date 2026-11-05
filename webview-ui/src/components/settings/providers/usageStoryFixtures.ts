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

/** Balance account with committed local usage and a reported 75% cache hit rate. */
export const balanceUsageFixture: AccountUsageData = {
    profileId: "profile-story",
    providerId: "deepseek",
    currency: "CNY",
    remainingBalance: 86.42,
    toppedUpBalance: 80,
    grantedBalance: 6.42,
    isAvailable: true,
    local: {
        inputTokens: 321_075,
        outputTokens: 96_512,
        cacheWriteTokens: 0,
        cacheReadTokens: 963_225,
        cacheHitTokens: 963_225,
        cacheMissTokens: 321_075,
        usageReported: true,
        retrievedAt: recentlyRetrievedAt,
    },
    retrievedAt: recentlyRetrievedAt,
}

/** Cache was reported, but every input token missed. This is a measured 0%. */
export const zeroCacheHitUsageFixture: AccountUsageData = {
    ...balanceUsageFixture,
    local: {
        inputTokens: 1_284_300,
        outputTokens: 96_512,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 1_284_300,
        usageReported: true,
        retrievedAt: recentlyRetrievedAt,
    },
}

/** Tokens were reported without a cache split, so the rate must remain absent. */
export const unreportedCacheUsageFixture: AccountUsageData = {
    ...balanceUsageFixture,
    local: {
        inputTokens: 1_284_300,
        outputTokens: 96_512,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        usageReported: true,
        retrievedAt: recentlyRetrievedAt,
    },
}

/** Codex windows are rolling durations, so its weekly window reads "7 day". */
export const codexUsageFixture: AccountUsageData = {
    profileId: "profile-story",
    providerId: "openai-codex",
    currency: "",
    planType: "plus",
    isAvailable: true,
    retrievedAt: recentlyRetrievedAt,
    local: {
        inputTokens: 2_486_120,
        outputTokens: 41_380,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        usageReported: true,
        retrievedAt: recentlyRetrievedAt,
    },
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
    local: {
        inputTokens: 18_734_902,
        outputTokens: 212_455,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        usageReported: true,
        retrievedAt: recentlyRetrievedAt,
    },
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

/**
 * OpenCode quota figures are US dollars scaled to micro-dollars, because
 * `UsageQuota.used` and `limit` are `int64` and one gateway request costs cents
 * or less. Rounding to whole cents would report every small request as zero and
 * leave every window looking untouched.
 */
const OPEN_CODE_MONTHLY_LIMIT = {
    /** Go: GLM-5.3 counts $15 of the plan's monthly limit. */
    go: 15_000_000,
    /** Go Plus: the same model counts $120. */
    goPlus: 120_000_000,
    /**
     * Go Teams: the same model counts $20 per member. It is neither the Go nor
     * the Go Plus figure, so a card that derived the limit from
     * `opencode.billing_source` alone would misreport this account.
     */
    goTeams: 20_000_000,
} as const

/**
 * Build the three Go windows a subscription reports.
 *
 * The gateway documents the split rather than the windows themselves: a 5-hour
 * window counts 20% of the model's monthly limit, a week counts 50%, and the
 * month counts 100%. The used amounts below keep each window at a different
 * pressure so the three bars are distinguishable at a glance.
 */
function openCodeGoQuotas(monthlyLimit: number): NonNullable<AccountUsageData["quotas"]> {
    return [
        {
            type: "5hour",
            label: "5 hour",
            shortLabel: "5h",
            used: Math.round(monthlyLimit * 0.2 * 0.22),
            limit: Math.round(monthlyLimit * 0.2),
            resetAt: "2030-01-01T12:00:00.000Z",
        },
        {
            type: "weekly",
            label: "This week",
            shortLabel: "week",
            used: Math.round(monthlyLimit * 0.5 * 0.39),
            limit: Math.round(monthlyLimit * 0.5),
            resetAt: "2030-01-07T12:00:00.000Z",
        },
        {
            type: "monthly",
            label: "This month",
            shortLabel: "month",
            used: Math.round(monthlyLimit * 0.48),
            limit: monthlyLimit,
            resetAt: "2030-02-01T00:00:00.000Z",
        },
    ]
}

/**
 * OpenCode pay-as-you-go: Dline accumulates the `opencode.cost` each response
 * reports, and never shows a remaining balance because Console publishes no
 * balance endpoint. A balance figure here would be Dline's invention.
 */
export const openCodeBalanceUsageFixture: AccountUsageData = {
    profileId: "profile-story",
    providerId: "opencode",
    currency: "USD",
    planType: "Pay-as-you-go",
    isAvailable: true,
    retrievedAt: recentlyRetrievedAt,
    local: unreportedCacheUsageFixture.local,
}

/** OpenCode Go ($10/month): the lowest per-model monthly limit. */
export const openCodeGoUsageFixture: AccountUsageData = {
    profileId: "profile-story",
    providerId: "opencode",
    currency: "USD",
    planType: "OpenCode Go",
    isAvailable: true,
    retrievedAt: recentlyRetrievedAt,
    quotas: openCodeGoQuotas(OPEN_CODE_MONTHLY_LIMIT.go),
}

/** OpenCode Go Plus ($40/month): the same windows against a higher limit. */
export const openCodeGoPlusUsageFixture: AccountUsageData = {
    profileId: "profile-story",
    providerId: "opencode",
    currency: "USD",
    planType: "OpenCode Go Plus",
    isAvailable: true,
    retrievedAt: recentlyRetrievedAt,
    quotas: openCodeGoQuotas(OPEN_CODE_MONTHLY_LIMIT.goPlus),
}

/**
 * OpenCode Go Teams ($20/member/month): each member carries their own limits,
 * and those limits are a third set of figures. Rendered beside `Go` this story
 * is what makes a limit table chosen from `billing_source` visibly wrong.
 */
export const openCodeGoTeamsUsageFixture: AccountUsageData = {
    profileId: "profile-story",
    providerId: "opencode",
    currency: "USD",
    planType: "OpenCode Go Teams",
    isAvailable: true,
    retrievedAt: recentlyRetrievedAt,
    quotas: openCodeGoQuotas(OPEN_CODE_MONTHLY_LIMIT.goTeams),
}

/**
 * Before the first request: no response has reported a cost, so there is
 * nothing to accumulate yet. `isAvailable` stays false rather than claiming a
 * zero reading, which would render as a real "0% used" window.
 */
export const openCodeNoDataUsageFixture: AccountUsageData = {
    profileId: "profile-story",
    providerId: "opencode",
    currency: "USD",
    isAvailable: false,
}
