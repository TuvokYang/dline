import type { AccountUsage, ApiHandler } from "@core/api"
import type { ApiProfile } from "@shared/proto/dline/profile"

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

/** Attach the Profile identity owned by the service boundary to a provider snapshot. */
export function decorateProviderAccountUsage(profile: ApiProfile, usage: AccountUsage | undefined): AccountUsage | undefined {
	if (!usage) return undefined
	return {
		...usage,
		profileId: profile.id,
		providerId: profile.provider,
	}
}
