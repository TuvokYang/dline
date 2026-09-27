import type { AccountUsageData, AccountUsageQuotaData } from "@/shared/ExtensionMessage"
import { fetch } from "@/shared/net"
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
/**
 * A weekly cap that applies to one model family, such as Fable.
 *
 * Upstream reports these only inside `limits[]` as `weekly_scoped` entries; the
 * legacy `seven_day_opus` and `seven_day_sonnet` fields are now always null.
 * Exhausting one blocks that family while the other windows still have room.
 */
const WEEKLY_SCOPED_QUOTA_TYPE = "weekly_scoped"
const WEEKLY_SCOPED_LIMIT_KIND = "weekly_scoped"

export interface ClaudeCodeUsageWindow {
	/** Percentage of the window already consumed. */
	readonly utilization: number
	/** ISO timestamp at which the window resets, when upstream reports one. */
	readonly resetsAt?: string
}

/** A weekly cap scoped to one model family, named as upstream displays it. */
export interface ClaudeCodeScopedWindow extends ClaudeCodeUsageWindow {
	readonly modelName: string
}

export interface ClaudeCodeUsageSnapshot {
	readonly fiveHour?: ClaudeCodeUsageWindow
	readonly sevenDay?: ClaudeCodeUsageWindow
	readonly scopedWeekly?: readonly ClaudeCodeScopedWindow[]
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
	const scopedWeekly = parseScopedWeekly(value.limits)
	return {
		...(fiveHour ? { fiveHour } : {}),
		...(sevenDay ? { sevenDay } : {}),
		...(scopedWeekly.length > 0 ? { scopedWeekly } : {}),
	}
}

/**
 * Read the per-family weekly caps from `limits[]`.
 *
 * Each entry is `{ kind, percent, resets_at, scope: { model: { display_name } } }`.
 * An entry without a usable percentage or model name says nothing a user can
 * act on, so it is skipped rather than rendered as a nameless window.
 */
function parseScopedWeekly(value: unknown): ClaudeCodeScopedWindow[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((entry) => {
		if (!isRecord(entry) || entry.kind !== WEEKLY_SCOPED_LIMIT_KIND) return []
		const percent = entry.percent
		if (typeof percent !== "number" || !Number.isFinite(percent)) return []
		const scope = isRecord(entry.scope) ? entry.scope : undefined
		const model = isRecord(scope?.model) ? scope.model : undefined
		const modelName = typeof model?.display_name === "string" ? model.display_name.trim() : ""
		if (modelName.length === 0) return []
		const resetsAt = entry.resets_at
		return [
			{
				modelName,
				utilization: percent,
				...(typeof resetsAt === "string" && resetsAt.length > 0 ? { resetsAt } : {}),
			},
		]
	})
}

/**
 * Claude counts calendar weeks, so its weekly windows read "week" rather than
 * the rolling "7 day" a Codex window uses.
 */
function toQuota(
	type: string,
	label: string,
	shortLabel: string,
	windowSeconds: number,
	window: ClaudeCodeUsageWindow | undefined,
): AccountUsageQuotaData | undefined {
	if (!window) return undefined
	return {
		type,
		label,
		shortLabel,
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
		toQuota(FIVE_HOUR_QUOTA_TYPE, "5 hour", "5h", FIVE_HOUR_SECONDS, snapshot.fiveHour),
		toQuota(WEEKLY_QUOTA_TYPE, "This week", "week", SEVEN_DAY_SECONDS, snapshot.sevenDay),
		...(snapshot.scopedWeekly ?? []).map((window) =>
			toQuota(
				WEEKLY_SCOPED_QUOTA_TYPE,
				`${window.modelName} this week`,
				`${window.modelName} week`,
				SEVEN_DAY_SECONDS,
				window,
			),
		),
	].filter((quota): quota is AccountUsageQuotaData => quota !== undefined)

	// Only the shared windows block the whole subscription. A per-model weekly
	// cap stops that model family alone, the way sub2api records it as a model
	// rate limit rather than an account limit, so it stays a visible bar.
	const limitReached = quotas.some((quota) => quota.type !== WEEKLY_SCOPED_QUOTA_TYPE && quota.used >= quota.limit)
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
	fetchImpl?: typeof fetch
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
	private readonly fetchImpl: typeof fetch
	private readonly usageUrl: string

	constructor(options: ClaudeCodeUsageClientOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? fetch
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
