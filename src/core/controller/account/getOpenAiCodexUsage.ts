import { type OpenAiCodexProfileRequest, OpenAiCodexUsageResponse } from "@shared/proto/dline/account"
import type { Controller } from ".."
import { getProviderUsage } from "./getProviderUsage"
import { logOpenAiCodexAccountRequestFailure, requireOpenAiCodexProfile } from "./openAiCodexProfileTarget"

/** Returns account usage for one explicit OpenAI Codex Profile. */
export async function getOpenAiCodexUsage(
    controller: Controller,
    request: OpenAiCodexProfileRequest,
): Promise<OpenAiCodexUsageResponse> {
    const profile = await requireOpenAiCodexProfile(request.profileId)
    try {
        const usage = await getProviderUsage(controller, { profileId: profile.id })
        return OpenAiCodexUsageResponse.create({
            profileId: profile.id,
            planType: usage.planType,
            windows: usage.quotas.map((quota) => {
                const usedPercent = quota.limit > 0 ? Math.max(0, Math.min(100, (quota.used / quota.limit) * 100)) : 0
                const resetAtMs = quota.resetAt ? Date.parse(quota.resetAt) : Number.NaN
                return {
                    type: quota.type,
                    label: quota.label,
                    usedPercent,
                    remainingPercent: 100 - usedPercent,
                    limitWindowSeconds: quota.windowSeconds ?? 0,
                    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : undefined,
                }
            }),
            creditsBalance: usage.remainingBalance,
            resetCreditsAvailableCount: usage.resetCreditsAvailableCount ?? 0,
            resetCredits: usage.resetCredits.map((credit) => {
                const grantedAtMs = credit.grantedAt ? Date.parse(credit.grantedAt) : Number.NaN
                const expiresAtMs = credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN
                return {
                    id: credit.id,
                    grantedAtMs: Number.isFinite(grantedAtMs) ? grantedAtMs : undefined,
                    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
                }
            }),
            allowed: usage.allowed,
            limitReached: usage.limitReached,
            isAvailable: usage.isAvailable ?? false,
        })
    } catch (error) {
        logOpenAiCodexAccountRequestFailure("read usage", error)
        throw new Error("OpenAI Codex usage could not be read.")
    }
}
