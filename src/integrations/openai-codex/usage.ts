import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import type { AccountUsageData, AccountUsageQuotaData } from "@/shared/ExtensionMessage"
import { fetch as proxyFetch } from "@/shared/net"
import { type OpenAiCodexCredentialContext, openAiCodexOAuthManager } from "./oauth"
import { type OpenAiCodexRuntimeConfig, resolveOpenAiCodexRuntimeConfig } from "./runtime-config"

const DEFAULT_TIMEOUT_MS = 10_000
const RESET_OUTCOMES = new Set(["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const)

export type OpenAiCodexResetOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"

export interface OpenAiCodexUsageWindow {
	readonly type: "5hour" | "weekly" | "daily" | "monthly" | "custom"
	readonly label: string
	readonly usedPercent: number
	readonly remainingPercent: number
	readonly limitWindowSeconds: number
	readonly resetAtMs?: number
}

export interface OpenAiCodexResetCredit {
	readonly id: string
	readonly grantedAtMs?: number
	readonly expiresAtMs?: number
}

export interface OpenAiCodexResetCreditList {
	readonly credits: readonly OpenAiCodexResetCredit[]
	readonly totalCount: number
}

export interface OpenAiCodexUsageSnapshot {
	readonly planType?: string
	readonly allowed?: boolean
	readonly limitReached?: boolean
	readonly windows: readonly OpenAiCodexUsageWindow[]
	readonly creditsBalance?: number
	readonly resetCreditsAvailableCount: number
	readonly resetCredits: readonly OpenAiCodexResetCredit[]
}

export interface OpenAiCodexResetCreditResult {
	readonly outcome: OpenAiCodexResetOutcome
	readonly windowsReset: readonly string[]
}

interface OpenAiCodexUsageCredentialProvider {
	getCredentialContext(profileId: string): Promise<OpenAiCodexCredentialContext | null>
	forceRefreshCredentialContext(profileId: string): Promise<OpenAiCodexCredentialContext | null>
}

export interface OpenAiCodexUsageClientOptions {
	readonly fetchImpl?: typeof proxyFetch
	readonly credentialProvider?: OpenAiCodexUsageCredentialProvider
	readonly runtimeConfig?: OpenAiCodexRuntimeConfig
	readonly timeoutMs?: number
}

export interface OpenAiCodexUsageRequestOptions {
	readonly signal?: AbortSignal
}

interface RawUsageWindow {
	readonly used_percent?: unknown
	readonly limit_window_seconds?: unknown
	readonly reset_at?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value !== "string" || value.trim().length === 0) return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

function nonNegativeInteger(value: unknown): number {
	const parsed = optionalFiniteNumber(value)
	return parsed === undefined ? 0 : Math.max(0, Math.trunc(parsed))
}

function optionalTimestampMs(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

function windowPresentation(seconds: number): Pick<OpenAiCodexUsageWindow, "type" | "label"> {
	if (seconds >= 27 * 24 * 60 * 60) return { type: "monthly", label: "Monthly" }
	if (seconds >= 6 * 24 * 60 * 60) return { type: "weekly", label: "7 day" }
	if (seconds >= 20 * 60 * 60) return { type: "daily", label: "Daily" }
	if (seconds === 5 * 60 * 60) return { type: "5hour", label: "5 hour" }
	return {
		type: "custom",
		label: seconds >= 60 * 60 ? `${Math.round(seconds / (60 * 60))}h` : `${Math.max(1, Math.round(seconds / 60))}m`,
	}
}

function parseUsageWindow(value: unknown): OpenAiCodexUsageWindow | undefined {
	if (!isRecord(value)) return undefined
	const raw = value as RawUsageWindow
	const usedPercentValue = optionalFiniteNumber(raw.used_percent)
	if (usedPercentValue === undefined) return undefined
	const usedPercent = Math.max(0, Math.min(100, usedPercentValue))
	const limitWindowSeconds = nonNegativeInteger(raw.limit_window_seconds)
	const resetAtSeconds = optionalFiniteNumber(raw.reset_at)
	return {
		...windowPresentation(limitWindowSeconds),
		usedPercent,
		remainingPercent: 100 - usedPercent,
		limitWindowSeconds,
		...(resetAtSeconds !== undefined && resetAtSeconds > 0 ? { resetAtMs: Math.trunc(resetAtSeconds * 1_000) } : {}),
	}
}

export function parseOpenAiCodexResetCredits(value: unknown): OpenAiCodexResetCreditList {
	if (!isRecord(value)) throw new Error("OpenAI Codex reset-credit list response must be an object.")
	const credits = Array.isArray(value.credits)
		? value.credits.flatMap((candidate) => {
				if (!isRecord(candidate)) return []
				const id = optionalString(candidate.id)
				if (!id) return []
				const grantedAtMs = optionalTimestampMs(candidate.granted_at)
				const expiresAtMs = optionalTimestampMs(candidate.expires_at)
				return [
					{
						id,
						...(grantedAtMs !== undefined ? { grantedAtMs } : {}),
						...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
					},
				]
			})
		: []
	return { credits, totalCount: Math.max(nonNegativeInteger(value.total_count), credits.length) }
}

export function parseOpenAiCodexUsage(value: unknown): OpenAiCodexUsageSnapshot {
	if (!isRecord(value)) throw new Error("OpenAI Codex usage response must be an object.")
	const rateLimit = isRecord(value.rate_limit) ? value.rate_limit : undefined
	const credits = isRecord(value.credits) ? value.credits : undefined
	const resetCredits = isRecord(value.rate_limit_reset_credits) ? value.rate_limit_reset_credits : undefined
	const windows = [parseUsageWindow(rateLimit?.primary_window), parseUsageWindow(rateLimit?.secondary_window)].filter(
		(window): window is OpenAiCodexUsageWindow => window !== undefined,
	)
	const creditsBalance = optionalFiniteNumber(credits?.balance)
	return {
		planType: optionalString(value.plan_type),
		allowed: typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : undefined,
		limitReached: typeof rateLimit?.limit_reached === "boolean" ? rateLimit.limit_reached : undefined,
		windows,
		...(creditsBalance !== undefined ? { creditsBalance } : {}),
		resetCreditsAvailableCount: nonNegativeInteger(resetCredits?.available_count),
		resetCredits: [],
	}
}

export function parseOpenAiCodexResetCreditResult(value: unknown): OpenAiCodexResetCreditResult {
	if (!isRecord(value)) throw new Error("OpenAI Codex reset-credit response must be an object.")
	const outcome = optionalString(value.result)
	if (!outcome || !RESET_OUTCOMES.has(outcome as OpenAiCodexResetOutcome)) {
		throw new Error("OpenAI Codex reset-credit response has an unknown outcome.")
	}
	const windowsReset = Array.isArray(value.windows_reset)
		? value.windows_reset.filter((window): window is string => typeof window === "string" && window.length > 0)
		: []
	return { outcome: outcome as OpenAiCodexResetOutcome, windowsReset }
}

/**
 * Compact label for the chat input bar.
 *
 * Codex windows are rolling durations, so the weekly one is "7d" rather than a
 * calendar week. Windows without an established abbreviation fall back to
 * their full label in the UI.
 */
function windowShortLabel(type: OpenAiCodexUsageWindow["type"]): string | undefined {
	if (type === "5hour") return "5h"
	if (type === "weekly") return "7d"
	return undefined
}

export function toAccountUsage(snapshot: OpenAiCodexUsageSnapshot | undefined): AccountUsageData | undefined {
	if (!snapshot) return undefined
	const quotas: AccountUsageQuotaData[] = snapshot.windows.map((window) => ({
		type: window.type,
		label: window.label,
		...(windowShortLabel(window.type) ? { shortLabel: windowShortLabel(window.type) } : {}),
		used: window.usedPercent,
		limit: 100,
		windowSeconds: window.limitWindowSeconds,
		...(window.resetAtMs !== undefined ? { resetAt: new Date(window.resetAtMs).toISOString() } : {}),
	}))
	if (quotas.length === 0 && snapshot.creditsBalance === undefined && snapshot.resetCreditsAvailableCount === 0)
		return undefined
	return {
		currency: snapshot.creditsBalance === undefined ? "" : "USD",
		...(snapshot.creditsBalance !== undefined ? { remainingBalance: snapshot.creditsBalance } : {}),
		planType: snapshot.planType,
		allowed: snapshot.allowed,
		limitReached: snapshot.limitReached,
		quotas,
		resetCreditsAvailableCount: snapshot.resetCreditsAvailableCount,
		resetCredits: snapshot.resetCredits.map((credit) => ({
			id: credit.id,
			...(credit.grantedAtMs !== undefined ? { grantedAt: new Date(credit.grantedAtMs).toISOString() } : {}),
			...(credit.expiresAtMs !== undefined ? { expiresAt: new Date(credit.expiresAtMs).toISOString() } : {}),
		})),
		isAvailable: true,
	}
}

export class OpenAiCodexUsageClient {
	private readonly fetchImpl: typeof proxyFetch
	private readonly credentialProvider: OpenAiCodexUsageCredentialProvider
	private readonly runtimeConfig: OpenAiCodexRuntimeConfig
	private readonly timeoutMs: number

	constructor(options: OpenAiCodexUsageClientOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? proxyFetch
		this.credentialProvider = options.credentialProvider ?? openAiCodexOAuthManager
		this.runtimeConfig = options.runtimeConfig ?? resolveOpenAiCodexRuntimeConfig()
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async getUsage(
		profileId: string,
		options: OpenAiCodexUsageRequestOptions = {},
	): Promise<OpenAiCodexUsageSnapshot | undefined> {
		const usagePayload = await this.requestJson(profileId, this.runtimeConfig.usageUrl, { method: "GET" }, options.signal)
		if (usagePayload === undefined) return undefined
		const usage = parseOpenAiCodexUsage(usagePayload)
		const resetCreditsPayload = await this.requestJson(
			profileId,
			this.runtimeConfig.resetCreditsUrl,
			{ method: "GET" },
			options.signal,
		)
		if (resetCreditsPayload === undefined) return usage
		const resetCredits = parseOpenAiCodexResetCredits(resetCreditsPayload)
		return {
			...usage,
			resetCredits: resetCredits.credits,
			resetCreditsAvailableCount: Math.max(usage.resetCreditsAvailableCount, resetCredits.totalCount),
		}
	}

	async consumeRateLimitResetCredit(
		profileId: string,
		creditId: string,
		redeemRequestId: string,
		options: OpenAiCodexUsageRequestOptions = {},
	): Promise<OpenAiCodexResetCreditResult | undefined> {
		if (creditId.length === 0) throw new Error("A reset-credit ID is required.")
		if (redeemRequestId.length === 0) throw new Error("A reset-credit redeem request ID is required.")
		const payload = await this.requestJson(
			profileId,
			this.runtimeConfig.consumeResetCreditUrl,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
			},
			options.signal,
		)
		return payload === undefined ? undefined : parseOpenAiCodexResetCreditResult(payload)
	}

	private async requestJson(
		profileId: string,
		url: string,
		init: RequestInit,
		parentSignal: AbortSignal | undefined,
	): Promise<unknown | undefined> {
		let credential = await this.credentialProvider.getCredentialContext(profileId)
		if (!credential) return undefined
		const controller = new AbortController()
		const abortFromParent = () => controller.abort(parentSignal?.reason)
		if (parentSignal?.aborted) abortFromParent()
		else parentSignal?.addEventListener("abort", abortFromParent, { once: true })
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const response = await this.fetchImpl(url, {
					...init,
					headers: {
						...buildExternalBasicHeaders(),
						originator: "dline",
						Authorization: `Bearer ${credential.accessToken}`,
						...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
						...init.headers,
					},
					signal: controller.signal,
				})
				if (response.status === 401 && attempt === 0) {
					const refreshed = await this.credentialProvider.forceRefreshCredentialContext(profileId)
					if (!refreshed) return undefined
					credential = refreshed
					continue
				}
				if (!response.ok) throw new Error(`OpenAI Codex account request failed with status ${response.status}.`)
				return response.json()
			}
			return undefined
		} finally {
			clearTimeout(timeout)
			parentSignal?.removeEventListener("abort", abortFromParent)
		}
	}
}

export const openAiCodexUsageClient = new OpenAiCodexUsageClient()
