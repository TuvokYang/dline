import {
    OpenAiCodexAccount,
    OpenAiCodexAuthFlow,
    OpenAiCodexAuthStatus,
    OpenAiCodexBrowserOpenStatus,
    OpenAiCodexFlowOutcome,
    OpenAiCodexFlowStatus,
    OpenAiCodexRateLimitResetOutcome,
    OpenAiCodexRateLimitResetResult,
    OpenAiCodexUsageResponse,
} from "@shared/proto/dline/account"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { readApiProfilesFresh } from "@/core/controller/file/getApiProfiles"
import type {
    OpenAiCodexAccountIdentity,
    OpenAiCodexAuthorizationFlow,
    OpenAiCodexAuthorizationFlowOutcome,
    OpenAiCodexProfileAuthStatus,
} from "@/integrations/openai-codex/oauth"
import type { OpenAiCodexResetCreditResult, OpenAiCodexUsageSnapshot } from "@/integrations/openai-codex/usage"
import { OAuthFlowError } from "@/services/oauth"
import { Logger } from "@/shared/services/Logger"

export async function requireOpenAiCodexProfile(profileId: string): Promise<ApiProfile> {
    if (typeof profileId !== "string" || profileId.length === 0) {
        throw new Error("An OpenAI Codex Profile ID is required.")
    }
    const profile = (await readApiProfilesFresh()).find((candidate) => candidate.id === profileId)
    if (!profile || profile.provider !== "openai-codex") {
        throw new Error("The requested OpenAI Codex Profile does not exist.")
    }
    return profile
}

export function requireOpenAiCodexFlowId(flowId: string): string {
    if (typeof flowId !== "string" || flowId.length === 0) {
        throw new Error("An OpenAI Codex OAuth flow ID is required.")
    }
    return flowId
}

export function toOpenAiCodexAuthStatus(status: OpenAiCodexProfileAuthStatus): OpenAiCodexAuthStatus {
    switch (status) {
        case "missing":
            return OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING
        case "malformed":
            return OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MALFORMED
        case "legacy-shared":
            return OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_LEGACY_SHARED
        case "authenticated":
            return OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED
        case "refreshable-expired":
            return OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REFRESHABLE_EXPIRED
        case "reauthentication-required":
            return OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REAUTHENTICATION_REQUIRED
    }
}

export function toOpenAiCodexAccount(context: OpenAiCodexAccountIdentity | null): OpenAiCodexAccount | undefined {
    if (
        !context ||
        (!context.accountId && !context.displayName && !context.email && !context.accountType && !context.expiresAtMs)
    ) {
        return undefined
    }
    return OpenAiCodexAccount.create({
        accountId: context.accountId ?? "",
        displayName: context.displayName,
        email: context.email,
        accountType: context.accountType,
        expiresAtMs: context.expiresAtMs,
    })
}

export function toOpenAiCodexUsageResponse(
    profileId: string,
    usage: OpenAiCodexUsageSnapshot | undefined,
): OpenAiCodexUsageResponse {
    return OpenAiCodexUsageResponse.create({
        profileId,
        planType: usage?.planType,
        windows:
            usage?.windows.map((window) => ({
                type: window.type,
                label: window.label,
                usedPercent: window.usedPercent,
                remainingPercent: window.remainingPercent,
                limitWindowSeconds: window.limitWindowSeconds,
                resetAtMs: window.resetAtMs,
            })) ?? [],
        creditsBalance: usage?.creditsBalance,
        resetCreditsAvailableCount: usage?.resetCreditsAvailableCount ?? 0,
        resetCredits:
            usage?.resetCredits.map((credit) => ({
                id: credit.id,
                grantedAtMs: credit.grantedAtMs,
                expiresAtMs: credit.expiresAtMs,
            })) ?? [],
        allowed: usage?.allowed,
        limitReached: usage?.limitReached,
        isAvailable: usage !== undefined,
    })
}

export function toOpenAiCodexRateLimitResetResult(
    profileId: string,
    result: OpenAiCodexResetCreditResult,
): OpenAiCodexRateLimitResetResult {
    const outcome = {
        reset: OpenAiCodexRateLimitResetOutcome.OPEN_AI_CODEX_RATE_LIMIT_RESET_OUTCOME_RESET,
        nothing_to_reset: OpenAiCodexRateLimitResetOutcome.OPEN_AI_CODEX_RATE_LIMIT_RESET_OUTCOME_NOTHING_TO_RESET,
        no_credit: OpenAiCodexRateLimitResetOutcome.OPEN_AI_CODEX_RATE_LIMIT_RESET_OUTCOME_NO_CREDIT,
        already_redeemed: OpenAiCodexRateLimitResetOutcome.OPEN_AI_CODEX_RATE_LIMIT_RESET_OUTCOME_ALREADY_REDEEMED,
    }[result.outcome]
    return OpenAiCodexRateLimitResetResult.create({ profileId, outcome, windowsReset: [...result.windowsReset] })
}

export function toOpenAiCodexAuthFlow(flow: OpenAiCodexAuthorizationFlow): OpenAiCodexAuthFlow {
    return OpenAiCodexAuthFlow.create({
        profileId: flow.profileId,
        flowId: flow.flowId,
        authorizationUrl: flow.authorizationUrl,
        redirectUri: flow.redirectUri,
        expiresAtMs: flow.expiresAtMs,
        browserOpenStatus:
            flow.browserOpenStatus === "opened"
                ? OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_OPENED
                : OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_FAILED,
    })
}

export function toOpenAiCodexFlowOutcome(outcome: OpenAiCodexAuthorizationFlowOutcome): OpenAiCodexFlowOutcome {
    const status = {
        completed: OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_COMPLETED,
        cancelled: OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_CANCELLED,
        "timed-out": OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_TIMED_OUT,
        failed: OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_FAILED,
    }[outcome.status]
    return OpenAiCodexFlowOutcome.create({
        profileId: outcome.profileId,
        flowId: outcome.flowId,
        status,
        endedAtMs: outcome.endedAtMs,
    })
}

export function logOpenAiCodexOAuthFailure(action: string, error: unknown): void {
    const code = error instanceof OAuthFlowError ? error.code : "UNKNOWN"
    Logger.error(`[OpenAiCodexOAuth] ${action} failed (${code}).`)
}

export function logOpenAiCodexAccountRequestFailure(action: string, error: unknown): void {
    const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        Number.isInteger((error as { status?: unknown }).status)
            ? (error as { status: number }).status
            : undefined
    Logger.error(`[OpenAiCodexAccount] ${action} failed${status === undefined ? "" : ` with status ${status}`}.`)
}
