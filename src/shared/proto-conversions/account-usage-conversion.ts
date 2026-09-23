import type { AccountUsageData, AccountUsageQuotaData, AccountUsageResetCreditData } from "@shared/ExtensionMessage"
import type {
	AccountUsage as ProtoAccountUsage,
	AccountUsageResetCredit as ProtoAccountUsageResetCredit,
	UsageQuota as ProtoUsageQuota,
} from "@shared/proto/dline/state"

/**
 * Convert a single proto UsageQuota to shared AccountUsageQuotaData.
 */
function protoToQuota(proto?: ProtoUsageQuota): AccountUsageQuotaData | undefined {
	if (!proto) {
		return undefined
	}
	return {
		type: proto.type,
		label: proto.label,
		used: proto.used,
		limit: proto.limit,
		windowSeconds: proto.windowSeconds ?? undefined,
		resetAt: proto.resetAt ?? undefined,
		resetLabel: proto.resetLabel ?? undefined,
	}
}

/**
 * Convert shared AccountUsageQuotaData to proto UsageQuota.
 */
function quotaToProto(data?: AccountUsageQuotaData): ProtoUsageQuota | undefined {
	if (!data) {
		return undefined
	}
	return {
		type: data.type,
		label: data.label,
		used: data.used,
		limit: data.limit,
		windowSeconds: data.windowSeconds,
		resetAt: data.resetAt,
		resetLabel: data.resetLabel,
	}
}

function protoToResetCredit(proto?: ProtoAccountUsageResetCredit): AccountUsageResetCreditData | undefined {
	if (!proto?.id) return undefined
	return {
		id: proto.id,
		grantedAt: proto.grantedAt ?? undefined,
		expiresAt: proto.expiresAt ?? undefined,
	}
}

function resetCreditToProto(data?: AccountUsageResetCreditData): ProtoAccountUsageResetCredit | undefined {
	if (!data?.id) return undefined
	return {
		id: data.id,
		grantedAt: data.grantedAt,
		expiresAt: data.expiresAt,
	}
}

/**
 * Convert proto AccountUsage to shared AccountUsageData.
 * Returns undefined when proto is undefined (not fetched yet).
 */
export function protoToAccountUsage(proto?: ProtoAccountUsage): AccountUsageData | undefined {
	if (!proto) {
		return undefined
	}
	return {
		profileId: proto.profileId ?? undefined,
		providerId: proto.providerId ?? undefined,
		currency: proto.currency,
		remainingBalance: proto.remainingBalance ?? undefined,
		toppedUpBalance: proto.toppedUpBalance ?? undefined,
		grantedBalance: proto.grantedBalance ?? undefined,
		planType: proto.planType ?? undefined,
		allowed: proto.allowed ?? undefined,
		limitReached: proto.limitReached ?? undefined,
		quotas: proto.quotas?.map(protoToQuota).filter(Boolean) as AccountUsageQuotaData[] | undefined,
		...decodeResetCreditSupport(proto),
		isAvailable: proto.isAvailable ?? undefined,
		dailyInputTokens: proto.dailyInputTokens ?? undefined,
		dailyOutputTokens: proto.dailyOutputTokens ?? undefined,
		dailyCacheHitTokens: proto.dailyCacheHitTokens ?? undefined,
		dailyCacheMissTokens: proto.dailyCacheMissTokens ?? undefined,
	}
}

/**
 * Restore reset-credit presence, which Proto3 scalars and repeated fields drop.
 *
 * A repeated field always decodes to `[]` and an `int32` always decodes to `0`,
 * so a provider that never reports reset credits is indistinguishable from one
 * that reports zero of them. Consumers use `undefined` to mean "this provider
 * has no reset-credit capability" and hide the section entirely, so collapsing
 * the empty encoding back to `undefined` keeps that distinction intact.
 *
 * A provider that genuinely supports reset credits but currently has none still
 * sends a positive count or a non-empty list at least once, and an explicit zero
 * alongside a known credit list stays visible through the list itself.
 */
function decodeResetCreditSupport(proto: ProtoAccountUsage): {
	resetCredits?: AccountUsageResetCreditData[]
	resetCreditsAvailableCount?: number
} {
	const credits = proto.resetCredits?.map(protoToResetCredit).filter(Boolean) as AccountUsageResetCreditData[] | undefined
	const count = proto.resetCreditsAvailableCount
	if (!credits?.length && !count) return {}
	return { resetCredits: credits, resetCreditsAvailableCount: count }
}

/**
 * Convert proto AccountUsage to shared AccountUsageData.
 * Returns undefined when proto is undefined (not fetched yet).
 */
export function accountUsageToProto(data?: AccountUsageData): ProtoAccountUsage | undefined {
	if (!data) {
		return undefined
	}
	return {
		profileId: data.profileId,
		providerId: data.providerId,
		currency: data.currency,
		remainingBalance: data.remainingBalance,
		toppedUpBalance: data.toppedUpBalance,
		grantedBalance: data.grantedBalance,
		planType: data.planType,
		allowed: data.allowed,
		limitReached: data.limitReached,
		quotas: (data.quotas?.map(quotaToProto).filter(Boolean) as ProtoUsageQuota[] | undefined) ?? [],
		resetCredits:
			(data.resetCredits?.map(resetCreditToProto).filter(Boolean) as ProtoAccountUsageResetCredit[] | undefined) ?? [],
		resetCreditsAvailableCount: data.resetCreditsAvailableCount,
		retrievedAt: data.retrievedAt,
		isAvailable: data.isAvailable,
		dailyInputTokens: data.dailyInputTokens,
		dailyOutputTokens: data.dailyOutputTokens,
		dailyCacheHitTokens: data.dailyCacheHitTokens,
		dailyCacheMissTokens: data.dailyCacheMissTokens,
	}
}
