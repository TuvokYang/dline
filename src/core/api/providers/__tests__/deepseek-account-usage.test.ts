import { mockFetchForTesting } from "@shared/net"
import { ApiProfile } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DeepSeekHandler } from "../deepseek"

const mocks = vi.hoisted(() => ({ readLocalUsageSnapshot: vi.fn() }))
vi.mock("@core/metrics/LocalUsageSnapshot", () => mocks)

function handler(apiKey = "test-key") {
    return new DeepSeekHandler({
        profile: ApiProfile.create({ id: "deepseek-a", provider: "deepseek", apiKey }),
        mode: "act",
    })
}

describe("DeepSeek account usage", () => {
    beforeEach(() => vi.clearAllMocks())

    it("combines the reported balance with this Profile's committed usage", async () => {
        const local = { inputTokens: 1200, outputTokens: 80, cacheHitTokens: 0, cacheMissTokens: 1200, usageReported: true }
        mocks.readLocalUsageSnapshot.mockResolvedValue(local)
        const transport = vi.fn(async () =>
            Response.json({
                is_available: true,
                balance_infos: [{ currency: "CNY", total_balance: "12.5", granted_balance: "2.5", topped_up_balance: "10" }],
            }),
        )

        const usage = await mockFetchForTesting(transport, () => handler().getAccountUsage())

        expect(usage).toMatchObject({ currency: "CNY", remainingBalance: 12.5, grantedBalance: 2.5, toppedUpBalance: 10 })
        expect(usage?.local).toBe(local)
        expect(usage?.dailyInputTokens).toBeUndefined()
        expect(mocks.readLocalUsageSnapshot).toHaveBeenCalledExactlyOnceWith("deepseek-a")
        expect(transport).toHaveBeenCalledTimes(1)
    })

    it.each([401, 503])("does not replace a failed balance read (%s) with local statistics", async (status) => {
        const usage = await mockFetchForTesting(
            vi.fn(async () => new Response(null, { status })),
            () => handler().getAccountUsage(),
        )

        expect(usage).toBeUndefined()
        expect(mocks.readLocalUsageSnapshot).not.toHaveBeenCalled()
    })

    it("does not read account or local usage without credentials", async () => {
        const transport = vi.fn()
        const usage = await mockFetchForTesting(transport, () => handler("").getAccountUsage())

        expect(usage).toBeUndefined()
        expect(transport).not.toHaveBeenCalled()
        expect(mocks.readLocalUsageSnapshot).not.toHaveBeenCalled()
    })
})
