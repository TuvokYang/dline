import { type ConsumeOpenAiCodexRateLimitResetCreditRequest, OpenAiCodexRateLimitResetResult } from "@shared/proto/dline/account"
import type { OpenAiCodexResetOutcome } from "@/integrations/openai-codex/usage"
import type { Controller } from ".."
import { consumeAccountUsageResetCredit } from "./consumeAccountUsageResetCredit"
import {
    logOpenAiCodexAccountRequestFailure,
    requireOpenAiCodexProfile,
    toOpenAiCodexRateLimitResetResult,
} from "./openAiCodexProfileTarget"

/** Consumes one user-selected reset credit for an explicit OpenAI Codex Profile. */
export async function consumeOpenAiCodexRateLimitResetCredit(
    controller: Controller,
    request: ConsumeOpenAiCodexRateLimitResetCreditRequest,
): Promise<OpenAiCodexRateLimitResetResult> {
    const profile = await requireOpenAiCodexProfile(request.profileId)
    const creditId = request.creditId.trim()
    if (creditId.length === 0) throw new Error("An OpenAI Codex reset-credit ID is required.")
    try {
        const result = await consumeAccountUsageResetCredit(controller, { profileId: profile.id, creditId })
        return toOpenAiCodexRateLimitResetResult(profile.id, {
            outcome: result.outcome as OpenAiCodexResetOutcome,
            windowsReset: result.quotaTypesReset,
        })
    } catch (error) {
        logOpenAiCodexAccountRequestFailure("consume rate-limit reset credit", error)
        throw new Error("OpenAI Codex rate-limit reset could not be completed.")
    }
}
