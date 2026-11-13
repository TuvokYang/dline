import { describe, expect, it } from "vitest"
import { countApiSeconds } from "./e2e/utils/rate-metric-oracle"

describe("stored API activity oracle", () => {
    it.each([
        "provider_active",
        "request_start",
        "stream_tokens",
        "exact_usage",
    ])("counts %s without requiring task or provider activity markers", (signal) => {
        expect(countApiSeconds([{ signals: [signal] }])).toBe(1)
        expect(countApiSeconds([{ signals: ["task_active", signal] }])).toBe(1)
    })

    it("excludes task-only, empty, missing, and unknown signals", () => {
        expect(countApiSeconds([{ signals: ["task_active"] }, { signals: [] }, {}, { signals: ["unknown"] }])).toBe(0)
    })

    it("counts overlapping API signals once per canonical second", () => {
        expect(
            countApiSeconds([{ signals: ["task_active", "provider_active", "request_start", "stream_tokens", "exact_usage"] }]),
        ).toBe(1)
    })

    it("includes late exact usage after the provider-active interval", () => {
        // The CI failure had six provider-active seconds, then one usage-only second.
        const records = [
            { signals: ["task_active", "provider_active", "request_start"] },
            ...Array.from({ length: 5 }, () => ({ signals: ["task_active", "provider_active"] })),
            { signals: ["task_active", "exact_usage"] },
        ]
        const seconds = countApiSeconds(records)
        expect(seconds).toBe(7)
        expect(Math.round((200 * 60) / seconds)).toBe(1_714)
        expect(Math.round(60 / seconds)).toBe(9)
    })
})
