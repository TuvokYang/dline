import { describe, expect, it, vi } from "vitest"
import { ExtensionRegistryInfo } from "@/registry"
import {
    OpenAiCodexUsageClient,
    parseOpenAiCodexResetCreditResult,
    parseOpenAiCodexResetCredits,
    parseOpenAiCodexUsage,
    toAccountUsage,
} from "./usage"

const runtimeConfig = {
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    responsesWebsocketUrl: "wss://chatgpt.example.test/backend-api/codex/responses",
    usageUrl: "https://chatgpt.example.test/backend-api/wham/usage",
    resetCreditsUrl: "https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits",
    consumeResetCreditUrl: "https://chatgpt.example.test/backend-api/wham/rate-limit-reset-credits/consume",
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
    })
}

describe("OpenAiCodex usage protocol", () => {
    it("parses plan type, 5-hour and 7-day windows, balance, and reset-card availability", () => {
        const usage = parseOpenAiCodexUsage({
            plan_type: "pro",
            rate_limit: {
                allowed: true,
                limit_reached: false,
                primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
                secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
            },
            credits: { balance: "7.50" },
            rate_limit_reset_credits: { available_count: 2 },
        })

        expect(usage).toEqual({
            planType: "pro",
            allowed: true,
            limitReached: false,
            windows: [
                {
                    type: "5hour",
                    label: "5 hour",
                    usedPercent: 25,
                    remainingPercent: 75,
                    limitWindowSeconds: 18_000,
                    resetAtMs: 1_800_000_000_000,
                },
                {
                    type: "weekly",
                    label: "7 day",
                    usedPercent: 60,
                    remainingPercent: 40,
                    limitWindowSeconds: 604_800,
                    resetAtMs: 1_800_500_000_000,
                },
            ],
            creditsBalance: 7.5,
            resetCreditsAvailableCount: 2,
            resetCredits: [],
        })
        expect(toAccountUsage(usage)?.quotas?.map((quota) => quota.label)).toEqual(["5 hour", "7 day"])
        expect(
            parseOpenAiCodexResetCredits({
                credits: [
                    {
                        id: "credit-a",
                        granted_at: "2026-09-01T00:00:00Z",
                        expires_at: "2026-10-01T00:00:00Z",
                    },
                ],
                total_count: 1,
            }),
        ).toEqual({
            credits: [
                {
                    id: "credit-a",
                    grantedAtMs: Date.parse("2026-09-01T00:00:00Z"),
                    expiresAtMs: Date.parse("2026-10-01T00:00:00Z"),
                },
            ],
            totalCount: 1,
        })
    })

    it("sends the Dline identity and refreshes the complete credential snapshot after one 401", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
            .mockResolvedValueOnce(jsonResponse({ rate_limit: { primary_window: { used_percent: 5 } } }))
            .mockResolvedValueOnce(jsonResponse({ credits: [], total_count: 0 }))
        const credentialProvider = {
            getCredentialContext: vi.fn().mockResolvedValue({ accessToken: "old-token", accountId: "old-account", expires: 1 }),
            forceRefreshCredentialContext: vi
                .fn()
                .mockResolvedValue({ accessToken: "new-token", accountId: "new-account", expires: 2 }),
        }
        const client = new OpenAiCodexUsageClient({
            fetchImpl: request as unknown as typeof fetch,
            credentialProvider,
            runtimeConfig,
        })

        await expect(client.getUsage("profile-a")).resolves.toMatchObject({ resetCreditsAvailableCount: 0 })
        expect(request).toHaveBeenCalledTimes(3)
        const firstHeaders = new Headers(request.mock.calls[0][1].headers)
        const secondHeaders = new Headers(request.mock.calls[1][1].headers)
        expect(firstHeaders.get("Authorization")).toBe("Bearer old-token")
        expect(firstHeaders.get("ChatGPT-Account-Id")).toBe("old-account")
        expect(firstHeaders.get("User-Agent")).toBe(`Dline/${ExtensionRegistryInfo.version}`)
        expect(secondHeaders.get("Authorization")).toBe("Bearer new-token")
        expect(secondHeaders.get("ChatGPT-Account-Id")).toBe("new-account")
    })

    it("consumes a reset card with the official snake-case body and parses the outcome", async () => {
        const request = vi.fn().mockResolvedValue(jsonResponse({ result: "reset", windows_reset: ["primary", "secondary"] }))
        const client = new OpenAiCodexUsageClient({
            fetchImpl: request as unknown as typeof fetch,
            credentialProvider: {
                getCredentialContext: vi.fn().mockResolvedValue({ accessToken: "token", accountId: "account", expires: 1 }),
                forceRefreshCredentialContext: vi.fn(),
            },
            runtimeConfig,
        })

        await expect(client.consumeRateLimitResetCredit("profile-a", "credit-a", "redeem-id")).resolves.toEqual({
            outcome: "reset",
            windowsReset: ["primary", "secondary"],
        })
        expect(request).toHaveBeenCalledWith(
            runtimeConfig.consumeResetCreditUrl,
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ credit_id: "credit-a", redeem_request_id: "redeem-id" }),
            }),
        )
        expect(parseOpenAiCodexResetCreditResult({ result: "no_credit" })).toEqual({ outcome: "no_credit", windowsReset: [] })
    })
})
