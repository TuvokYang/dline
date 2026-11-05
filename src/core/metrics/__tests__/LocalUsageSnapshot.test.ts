import fs from "node:fs"
import type { UsageRow } from "@shared/metrics/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readLocalUsageSnapshot } from "../LocalUsageSnapshot"
import { MetricsRepository } from "../MetricsRepository"

const now = new Date(2026, 10, 5, 12)

function row(overrides: Partial<UsageRow> = {}): UsageRow {
    return {
        scopeId: "",
        resolution: "minute",
        bucketStartMs: now.getTime(),
        modelId: "model-a",
        taskId: "task-a",
        profileId: "profile-a",
        providerId: "deepseek",
        keyFingerprint: "key-a",
        inputTokens: 0,
        outputTokens: 20,
        thoughtsTokens: 0,
        cacheWriteTokens: 1_000,
        cacheReadTokens: 0,
        cacheNumerator: 0,
        cacheDenominator: 1_000,
        usageAvailable: true,
        cacheUsageAvailable: true,
        currencyMixed: false,
        costAvailable: false,
        usageQuality: "exact",
        respondingRequests: 1,
        aggregatedAt: now.toISOString(),
        ...overrides,
    }
}

describe("readLocalUsageSnapshot", () => {
    let rows: UsageRow[]

    beforeEach(() => {
        rows = []
        vi.spyOn(fs, "existsSync").mockReturnValue(true)
        vi.spyOn(MetricsRepository, "open").mockResolvedValue({
            usage: async () => rows,
            close: async () => undefined,
        } as unknown as MetricsRepository)
    })

    afterEach(() => vi.restoreAllMocks())

    it("preserves an explicitly reported zero cache hit rate", async () => {
        rows = [row()]

        expect(await readLocalUsageSnapshot("profile-a", now)).toMatchObject({
            cacheHitTokens: 0,
            cacheMissTokens: 1_000,
            cacheWriteTokens: 1_000,
            cacheReadTokens: 0,
        })
    })

    it("uses only cache-reporting rows in the weighted denominator", async () => {
        rows = [
            row({ cacheWriteTokens: 100, cacheReadTokens: 900, cacheNumerator: 900, cacheDenominator: 1_000 }),
            row({
                inputTokens: 9_000,
                cacheWriteTokens: 0,
                cacheNumerator: 0,
                cacheDenominator: 0,
                cacheUsageAvailable: false,
            }),
        ]

        expect(await readLocalUsageSnapshot("profile-a", now)).toMatchObject({
            inputTokens: 9_000,
            cacheHitTokens: 900,
            cacheMissTokens: 100,
        })
    })

    it("does not invent cache hit or miss counts when cache was not reported", async () => {
        rows = [
            row({
                inputTokens: 1_000,
                cacheWriteTokens: 0,
                cacheNumerator: 0,
                cacheDenominator: 0,
                cacheUsageAvailable: false,
            }),
        ]

        const snapshot = await readLocalUsageSnapshot("profile-a", now)
        expect(snapshot?.inputTokens).toBe(1_000)
        expect(snapshot?.cacheHitTokens).toBeUndefined()
        expect(snapshot?.cacheMissTokens).toBeUndefined()
    })
})
