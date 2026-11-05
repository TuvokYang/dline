import type { AccountUsage, ApiHandler } from "@core/api"
import type { AccountUsageLocalData } from "@shared/ExtensionMessage"
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
    localSnapshot?: AccountUsageLocalData,
): AccountUsage | undefined {
    const returnedAt = usage?.retrievedAt ?? new Date().toISOString()
    // A failed or skipped provider read must not hide numbers this installation
    // measured itself: the local ledger is independent of the remote endpoint, so it
    // still publishes a snapshot that says exactly that.
    // `currency` is required by the DTO but has no meaning without a remote balance
    // figure; an empty string keeps it present while claiming no amount.
    const decorated: AccountUsage = {
        ...usage,
        profileId: profile.id,
        providerId: profile.provider,
        currency: usage?.currency ?? "",
        retrievedAt: returnedAt,
    }
    if (!usage && localSnapshot === undefined) return undefined
    // The local snapshot describes this installation's own record, so it is attached
    // for every provider. A balance-style provider reports no daily token counts at
    // all, and that is exactly the case where a locally measured total is the only
    // number the user can see. It is passed through whole: the ledger reports cache
    // segments and a legacy baseline as well, and rebuilding the snapshot from two
    // fields here would silently drop them.
    const withLocal = localSnapshot === undefined ? decorated : { ...decorated, local: localSnapshot }
    return applyLocalDailyTokens(withLocal, localSnapshot)
}

/**
 * Attach this installation's own committed usage to a snapshot.
 *
 * Every provider gets `local`, including the balance-style ones that report no daily
 * token counts at all: the numbers come from Dline's ledger, not from the provider, so a
 * balance read and a local total are independent facts that a surface shows side by
 * side. A provider that never reported usage still gets a snapshot whose
 * `usageReported` is false, which is what keeps "nothing measured" distinguishable
 * from "measured zero".
 */
export function attachLocalUsageSnapshot(
    usage: AccountUsage,
    snapshot: {
        readonly inputTokens: number
        readonly outputTokens: number
        readonly cacheWriteTokens?: number
        readonly cacheReadTokens?: number
        readonly cacheHitTokens?: number
        readonly cacheMissTokens?: number
        readonly returnedAt: string
    },
): AccountUsage {
    return {
        ...usage,
        local: {
            inputTokens: snapshot.inputTokens,
            outputTokens: snapshot.outputTokens,
            ...(snapshot.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: snapshot.cacheWriteTokens }),
            ...(snapshot.cacheReadTokens === undefined ? {} : { cacheReadTokens: snapshot.cacheReadTokens }),
            ...(snapshot.cacheHitTokens === undefined ? {} : { cacheHitTokens: snapshot.cacheHitTokens }),
            ...(snapshot.cacheMissTokens === undefined ? {} : { cacheMissTokens: snapshot.cacheMissTokens }),
            // A snapshot exists only because the ledger was actually read, so a real
            // zero is a report of zero rather than an absent measurement. Deriving the
            // flag from a positive count conflated "reported 0" with "never reported",
            // and the UI then hid a genuinely quiet day.
            usageReported: true,
            retrievedAt: snapshot.returnedAt,
        },
    }
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
export function applyLocalDailyTokens(
    usage: AccountUsage,
    localDailyTokens: Pick<AccountUsageLocalData, "inputTokens" | "outputTokens"> | undefined,
): AccountUsage {
    if (!localDailyTokens || !isSubscriptionUsage(usage)) return usage
    // Zero is not a report, it is the absence of one. A provider whose model
    // matching fails returns a defined zero for the day, and treating that as
    // authoritative hid the ledger's real totals behind "Today In: 0". A day
    // that reported any non-zero count is left exactly as the provider said.
    const reportedInput = usage.dailyInputTokens ?? 0
    const reportedOutput = usage.dailyOutputTokens ?? 0
    if (reportedInput > 0 || reportedOutput > 0) return usage
    return {
        ...usage,
        dailyInputTokens: localDailyTokens.inputTokens,
        dailyOutputTokens: localDailyTokens.outputTokens,
    }
}
