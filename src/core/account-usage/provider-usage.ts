import type { AccountUsage, ApiHandler } from "@core/api"
import type { ApiProfile } from "@shared/proto/dline/profile"
import type { TokenIncrement } from "./daily-token-ledger"

/** The handler surface the polling policy depends on. */
type AccountUsageSource = Pick<ApiHandler, "getAccountUsage" | "supportsAccountUsagePolling">

/**
 * Decide whether background polling may query this handler for account usage.
 *
 * A provider can expose usage and still refuse to be polled for it, because the
 * request is billed against the same subscription that serves conversations.
 * Opting out removes only the timer; an explicit user refresh still resolves
 * `getAccountUsage()`.
 */
export function allowsAccountUsagePolling(handler: AccountUsageSource): boolean {
	return Boolean(handler.getAccountUsage) && handler.supportsAccountUsagePolling !== false
}

/** What a scheduled tick should do with one Profile's usage capability. */
export type AccountUsageReadDecision = "skip" | "read"

/**
 * Decide whether this tick should read usage for `profileKey`.
 *
 * Refusing the timer is not the same as refusing to be read. The chat input bar
 * renders only from the snapshot the Controller publishes, so a provider that
 * was never read leaves it with nothing to show. An opted-out provider is
 * therefore read once per Profile and skipped afterwards, which keeps the bar
 * populated without spending the subscription budget that also serves
 * conversations.
 *
 * @param alreadyReadKey Profile key already read outside the timer, if any.
 */
export function decideAccountUsageRead(
	handler: AccountUsageSource,
	profileKey: string,
	alreadyReadKey: string | undefined,
): AccountUsageReadDecision {
	if (!handler.getAccountUsage) return "skip"
	if (allowsAccountUsagePolling(handler)) return "read"
	return alreadyReadKey === profileKey ? "skip" : "read"
}

/**
 * Attach the Profile identity and read time owned by the service boundary.
 *
 * The timestamp is stamped here because every read passes through this
 * function, and a snapshot that is held until the user refreshes it has to be
 * able to state its own age. A provider that reports its own retrieval time
 * keeps it.
 */
export function decorateProviderAccountUsage(
	profile: ApiProfile,
	usage: AccountUsage | undefined,
	localDailyTokens?: TokenIncrement,
): AccountUsage | undefined {
	if (!usage) return undefined
	return applyLocalDailyTokens(
		{
			...usage,
			profileId: profile.id,
			providerId: profile.provider,
			retrievedAt: usage.retrievedAt ?? new Date().toISOString(),
		},
		localDailyTokens,
	)
}

/** A subscription reports quota windows or a plan, never a balance-style token count. */
export function isSubscriptionUsage(usage: AccountUsage): boolean {
	return Boolean(usage.planType) || (usage.quotas?.length ?? 0) > 0
}

/**
 * Fill today's token counts for a subscription from Dline's own ledger.
 *
 * A subscription endpoint reports percentages only, so the counts come from
 * the requests Dline itself sent. A provider that reports its own daily
 * counts keeps them, and balance providers are left untouched.
 */
export function applyLocalDailyTokens(usage: AccountUsage, localDailyTokens: TokenIncrement | undefined): AccountUsage {
	if (!localDailyTokens || !isSubscriptionUsage(usage)) return usage
	if (usage.dailyInputTokens !== undefined || usage.dailyOutputTokens !== undefined) return usage
	return {
		...usage,
		dailyInputTokens: localDailyTokens.inputTokens,
		dailyOutputTokens: localDailyTokens.outputTokens,
	}
}
