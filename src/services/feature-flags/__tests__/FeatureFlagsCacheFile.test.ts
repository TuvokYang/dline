import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FEATURES_REQUEST_SETTLE_MS, FeatureFlagsCacheFile } from "../remote/FeatureFlagsCacheFile"

const NOW = 1_800_000_000_000
const INTERVAL = 30 * 60_000

describe("FeatureFlagsCacheFile request gate", () => {
    let dir: string
    let cachePath: string

    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), "dline-feature-flags-"))
        cachePath = path.join(dir, "feature-flags.json")
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it("grants one request per interval across windows, failed or not", async () => {
        const firstWindow = new FeatureFlagsCacheFile(cachePath)
        const secondWindow = new FeatureFlagsCacheFile(cachePath)

        const first = await firstWindow.claimRequest(NOW, INTERVAL)
        const whileAsking = await secondWindow.claimRequest(NOW + 1_000, INTERVAL)
        // The first request failed: nothing was cached, and the interval still holds.
        const afterFailure = await secondWindow.claimRequest(NOW + FEATURES_REQUEST_SETTLE_MS + 1, INTERVAL)
        const nextInterval = await secondWindow.claimRequest(NOW + INTERVAL, INTERVAL)

        expect(first).toMatchObject({ granted: true })
        expect(whileAsking).toEqual({ granted: false, recheckAt: NOW + FEATURES_REQUEST_SETTLE_MS })
        expect(afterFailure).toEqual({ granted: false, recheckAt: NOW + INTERVAL })
        expect(nextInterval).toMatchObject({ granted: true })
        expect(nextInterval.granted && first.granted && nextInterval.requestId !== first.requestId).toBe(true)
    })

    it("grants nothing while the shared answers are fresh, even after the gate expired", async () => {
        const cache = new FeatureFlagsCacheFile(cachePath)
        await cache.write({ document: { flags: { account: true }, ttlSeconds: 3_600 }, fetchedAt: NOW })

        expect(await cache.claimRequest(NOW + 60_000, INTERVAL)).toEqual({ granted: false, recheckAt: NOW + INTERVAL })
        expect(await cache.claimRequest(NOW + INTERVAL, INTERVAL)).toMatchObject({ granted: true })
    })

    it("keeps the gate when the answers are forgotten, so withdrawing does not allow an extra request", async () => {
        const cache = new FeatureFlagsCacheFile(cachePath)
        await cache.claimRequest(NOW, INTERVAL)
        await cache.clear()

        expect(await cache.claimRequest(NOW + FEATURES_REQUEST_SETTLE_MS, INTERVAL)).toEqual({
            granted: false,
            recheckAt: NOW + INTERVAL,
        })
    })

    it("does not let a clock moved back block requests", async () => {
        const cache = new FeatureFlagsCacheFile(cachePath)
        await cache.claimRequest(NOW, INTERVAL)

        expect(await cache.claimRequest(NOW - 60 * 60_000, INTERVAL)).toMatchObject({ granted: true })
    })
})
