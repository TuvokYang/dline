import { describe, expect, it } from "vitest"
import {
    afterAcknowledged,
    afterRateLimited,
    DEFAULT_INTERVAL_MS,
    GATE_MARGIN_MS,
    INITIAL_PACING,
    isWaiting,
    MAX_WAIT_MS,
    mayStartBatch,
    rateLimitWaitMs,
    replayBudgetExhausted,
    replayDelayMs,
    reserveInterval,
} from "../pacing"

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60_000
const noJitter = () => 0
const fullJitter = () => 0.999_999

describe("429 and pause waits (contract v2 §1.7, §1.8)", () => {
    it("waits for the service's delay when it names one, from the body or from Retry-After", () => {
        // The classifier already prefers retry_after_ms over Retry-After; either arrives here as one number.
        expect(rateLimitWaitMs(45_000, 1, noJitter)).toBe(45_000)
        expect(rateLimitWaitMs(30_000, 5, noJitter)).toBe(30_000)
    })

    it("doubles from 60 seconds per 429 in a row when the service names no delay, up to 30 minutes", () => {
        expect([1, 2, 3, 4, 5, 6, 7].map((n) => rateLimitWaitMs(undefined, n, noJitter))).toEqual([
            60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000,
        ])
    })

    it("adds a jitter of at most 10 percent", () => {
        const samples = [0, 0.25, 0.5, 0.999_999].map((value) => rateLimitWaitMs(100_000, 1, () => value))

        expect(samples[0]).toBe(100_000)
        expect(samples.every((wait) => wait >= 100_000 && wait <= 110_000)).toBe(true)
        expect(new Set(samples).size).toBe(samples.length)
    })

    it("waits between 1 and 1.1 days for a one-day pause", () => {
        expect(rateLimitWaitMs(DAY, 1, noJitter)).toBe(DAY)
        expect(rateLimitWaitMs(DAY, 1, fullJitter)).toBeLessThanOrEqual(1.1 * DAY)
        expect(rateLimitWaitMs(DAY, 1, fullJitter)).toBeGreaterThan(DAY)
    })

    it("never waits longer than 7 days, whatever the service asks", () => {
        expect(rateLimitWaitMs(30 * DAY, 1, noJitter)).toBe(MAX_WAIT_MS)
        expect(rateLimitWaitMs(7 * DAY, 1, fullJitter)).toBe(MAX_WAIT_MS)
    })

    it("holds every send, replays included, until the wait ends, and counts 429s in a row", () => {
        const first = afterRateLimited(INITIAL_PACING, undefined, NOW, noJitter)
        const second = afterRateLimited(first, undefined, NOW + 60_000, noJitter)

        expect(first).toEqual({ ...INITIAL_PACING, waitUntil: NOW + 60_000, consecutiveWaits: 1 })
        expect(second.waitUntil).toBe(NOW + 60_000 + 120_000)
        expect(isWaiting(second, second.waitUntil - 1)).toBe(true)
        expect(mayStartBatch(second, second.waitUntil - 1)).toBe(false)
        expect(isWaiting(second, second.waitUntil)).toBe(false)
    })

    it("rebuilds the refused batch as soon as a short wait ends, not after the interval it reserved", () => {
        const reserved = reserveInterval(INITIAL_PACING, "usage", NOW)
        const waiting = afterRateLimited(reserved, 60_000, NOW, noJitter)

        expect(mayStartBatch(waiting, NOW + 60_000 - 1)).toBe(false)
        expect(mayStartBatch(waiting, NOW + 60_000)).toBe(true)
    })

    it("keeps a server gate that ends before the wait", () => {
        const gated = { ...INITIAL_PACING, nextEligibleAt: NOW + 30_000 }

        expect(afterRateLimited(gated, 60_000, NOW, noJitter).nextEligibleAt).toBe(NOW + 30_000)
    })
})

describe("server gate (contract v2 §1.6)", () => {
    it("starts no new batch before the gate the acknowledgement named, and resets the 429 count", () => {
        const waited = { ...INITIAL_PACING, consecutiveWaits: 3 }
        const pacing = afterAcknowledged(waited, "usage", NOW + 6 * 60 * 60_000, NOW)

        expect(pacing.consecutiveWaits).toBe(0)
        expect(mayStartBatch(pacing, NOW + 6 * 60 * 60_000)).toBe(false)
        expect(mayStartBatch(pacing, NOW + 6 * 60 * 60_000 + GATE_MARGIN_MS)).toBe(true)
    })

    it("lets the service shorten the gate the batch reserved", () => {
        const reserved = reserveInterval(INITIAL_PACING, "usage", NOW)
        const acknowledged = afterAcknowledged(reserved, "usage", NOW + 120_000, NOW + 1_000)

        expect(reserved.nextEligibleAt).toBe(NOW + DEFAULT_INTERVAL_MS.usage)
        expect(acknowledged.nextEligibleAt).toBe(NOW + 120_000 + GATE_MARGIN_MS)
    })

    it("uses the default interval of each channel when the service names no gate", () => {
        expect(afterAcknowledged(INITIAL_PACING, "usage", undefined, NOW).nextEligibleAt).toBe(NOW + 10 * 60_000)
        expect(afterAcknowledged(INITIAL_PACING, "logs", undefined, NOW).nextEligibleAt).toBe(NOW + 5 * 60_000)
    })

    it("caps an absurd gate at the 7-day wait limit", () => {
        expect(afterAcknowledged(INITIAL_PACING, "logs", NOW + 365 * DAY, NOW).nextEligibleAt).toBe(NOW + MAX_WAIT_MS)
    })
})

describe("replays (contract v2 §1.5)", () => {
    it("backs off 30 seconds doubling to 30 minutes, or longer when the service asks", () => {
        expect([1, 2, 3, 7, 8, 12].map((attempts) => replayDelayMs(attempts, undefined))).toEqual([
            30_000, 60_000, 120_000, 1_800_000, 1_800_000, 1_800_000,
        ])
        expect(replayDelayMs(1, 90_000)).toBe(90_000)
    })

    it("gives a batch up after 12 attempts or 24 hours", () => {
        expect(replayBudgetExhausted(11, NOW, NOW + DAY - 1)).toBe(false)
        expect(replayBudgetExhausted(12, NOW, NOW)).toBe(true)
        expect(replayBudgetExhausted(1, NOW, NOW + DAY)).toBe(true)
    })
})
