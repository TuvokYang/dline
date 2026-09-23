import type { AccountUsageData, AccountUsageQuotaData } from "@/shared/ExtensionMessage"
import { fetch as proxyFetch } from "@/shared/net"
import { CLAUDE_CODE_OAUTH_BETA } from "./beta-headers"
import { buildClaudeCodeClientHeaders } from "./client-headers"
import { resolveClaudeCodeRuntimeConfig } from "./runtime-config"

/**
 * Subscription usage endpoint used by the Claude Code client.
 *
 * Note the path is not under `/v1`: it is an account endpoint rather than an
 * inference one, and prefixing it returns 404.
 */
export const CLAUDE_CODE_USAGE_URL = resolveClaudeCodeRuntimeConfig().usageUrl

/** Utilization is reported as a percentage of the window's allowance. */
const UTILIZATION_LIMIT = 100

const FIVE_HOUR_SECONDS = 5 * 60 * 60
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60

/**
 * Quota identities the shared usage surfaces branch on.
 *
 * The chat usage bar abbreviates `5hour` and `weekly` and prefers the five-hour
 * window when several are active, so a window spelled any other way renders
 * under its raw label and never participates in that selection. These strings
 * are therefore a contract with the UI, not a copy of the upstream key.
 */
const FIVE_HOUR_QUOTA_TYPE = "5hour"
const WEEKLY_QUOTA_TYPE = "weekly"
const WEEKLY_OVERAGE_QUOTA_TYPE = "weekly_overage_included"
/**
 * The weekly allowance reserved for the most capable model family.
 *
 * Upstream still keys it `seven_day_opus`, but it is the window a Fable
 * conversation spends, and it runs out well before the general weekly one. It
 * is a separate identity because exhausting it blocks that family while the
 * other windows still have room.
 */
const WEEKLY_FABLE_QUOTA_TYPE = "weekly_fable"

export interface ClaudeCodeUsageWindow {
	/** Percentage of the window already consumed. */
	readonly utilization: number
	/** ISO timestamp at which the window resets, when upstream reports one. */
	readonly resetsAt?: string
}

export interface ClaudeCodeUsageSnapshot {
	readonly fiveHour?: ClaudeCodeUsageWindow
	readonly sevenDay?: ClaudeCodeUsageWindow
	readonly sevenDayOverageIncluded?: ClaudeCodeUsageWindow
	/** Weekly allowance for the most capable family, keyed `seven_day_opus`. */
	readonly sevenDayFable?: ClaudeCodeUsageWindow
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseWindow(value: unknown): ClaudeCodeUsageWindow | undefined {
	if (!isRecord(value)) return undefined
	const utilization = value.utilization
	if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined
	const resetsAt = value.resets_at
	return {
		utilization,
		...(typeof resetsAt === "string" && resetsAt.length > 0 ? { resetsAt } : {}),
	}
}

export function parseClaudeCodeUsage(value: unknown): ClaudeCodeUsageSnapshot {
	if (!isRecord(value)) return {}
	const fiveHour = parseWindow(value.five_hour)
	const sevenDay = parseWindow(value.seven_day)
	const sevenDayOverageIncluded = parseWindow(value.seven_day_overage_included)
	const sevenDayFable = parseWindow(value.seven_day_opus)
	return {
		...(fiveHour ? { fiveHour } : {}),
		...(sevenDay ? { sevenDay } : {}),
		...(sevenDayOverageIncluded ? { sevenDayOverageIncluded } : {}),
		...(sevenDayFable ? { sevenDayFable } : {}),
	}
}

function toQuota(
	type: string,
	label: string,
	windowSeconds: number,
	window: ClaudeCodeUsageWindow | undefined,
): AccountUsageQuotaData | undefined {
	if (!window) return undefined
	return {
		type,
		label,
		// The shared quota shape is used/limit, and upstream reports only a
		// percentage, so the limit is the full percentage scale.
		used: window.utilization,
		limit: UTILIZATION_LIMIT,
		windowSeconds,
		...(window.resetsAt ? { resetAt: window.resetsAt } : {}),
	}
}

/**
 * Project the subscription snapshot onto the shared usage contract.
 *
 * `resetCredits` is deliberately absent: this subscription exposes no
 * reset-credit API, and the shared UI treats an absent field as "the provider
 * has no such capability" rather than "none remaining".
 */
export function toAccountUsage(snapshot: ClaudeCodeUsageSnapshot): AccountUsageData {
	const quotas = [
		toQuota(FIVE_HOUR_QUOTA_TYPE, "5 hour", FIVE_HOUR_SECONDS, snapshot.fiveHour),
		toQuota(WEEKLY_QUOTA_TYPE, "7 day", SEVEN_DAY_SECONDS, snapshot.sevenDay),
		// The overage window is what actually gates a subscription that has one,
		// so parsing it and then dropping it would hide the binding limit.
		toQuota(WEEKLY_OVERAGE_QUOTA_TYPE, "7 day (overage)", SEVEN_DAY_SECONDS, snapshot.sevenDayOverageIncluded),
		toQuota(WEEKLY_FABLE_QUOTA_TYPE, "Fable this week", SEVEN_DAY_SECONDS, snapshot.sevenDayFable),
	].filter((quota): quota is AccountUsageQuotaData => quota !== undefined)

	const limitReached = quotas.some((quota) => quota.used >= quota.limit)
	return {
		// A subscription has no per-request balance, so no currency amount applies.
		currency: "USD",
		isAvailable: quotas.length > 0,
		allowed: !limitReached,
		limitReached,
		...(quotas.length > 0 ? { quotas } : {}),
	}
}

export interface ClaudeCodeUsageClientOptions {
	fetchImpl?: typeof proxyFetch
	usageUrl?: string
}

export class ClaudeCodeUsageError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message)
		this.name = "ClaudeCodeUsageError"
	}
}

/** Reads the subscription usage snapshot for one access token. */
export class ClaudeCodeUsageClient {
	private readonly fetchImpl: typeof proxyFetch
	private readonly usageUrl: string

	constructor(options: ClaudeCodeUsageClientOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? proxyFetch
		this.usageUrl = options.usageUrl ?? CLAUDE_CODE_USAGE_URL
	}

	async fetchUsage(accessToken: string, clientVersion: string, signal?: AbortSignal): Promise<ClaudeCodeUsageSnapshot> {
		let response: Response
		try {
			response = await this.fetchImpl(this.usageUrl, {
				method: "GET",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
					"anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
					...buildClaudeCodeClientHeaders(clientVersion),
				},
				...(signal ? { signal } : { signal: AbortSignal.timeout(15_000) }),
			})
		} catch {
			throw new ClaudeCodeUsageError("The Claude Code usage snapshot could not be retrieved.")
		}
		if (!response.ok) {
			// The body may echo account details, so only the status is surfaced.
			throw new ClaudeCodeUsageError("The Claude Code usage snapshot could not be retrieved.", response.status)
		}
		try {
			return parseClaudeCodeUsage(await response.json())
		} catch {
			throw new ClaudeCodeUsageError("The Claude Code usage response could not be read.", response.status)
		}
	}
}
