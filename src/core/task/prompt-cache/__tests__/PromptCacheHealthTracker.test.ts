import type { PromptCacheHealthResetReason } from "@shared/PromptCacheHealth"
import { describe, expect, it, vi } from "vitest"
import { PromptCacheHealthTracker, type PromptCacheRequestResult } from "../PromptCacheHealthTracker"

function request(overrides: Partial<PromptCacheRequestResult> = {}): PromptCacheRequestResult {
    return {
        completed: true,
        isCompactionRequest: false,
        supportsPromptCache: true,
        cacheUsageReported: true,
        inputTokens: 9_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 1_000,
        contextTokens: 10_000,
        contextWindow: 100_000,
        compactTriggerTokens: 80_000,
        ...overrides,
    }
}

describe("PromptCacheHealthTracker", () => {
    it("samples one completed ordinary request and emits Task-scoped debug output", () => {
        const debug = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug, warn: vi.fn() })

        const changed = tracker.recordRequest(request())

        expect(changed).toBe(true)
        expect(tracker.getSnapshot()).toMatchObject({ status: "warming", sampleCount: 1, warmingRound: 1 })
        expect(debug).toHaveBeenCalledOnce()
        expect(debug).toHaveBeenCalledWith(
            expect.stringMatching(
                /^\[Task task-123\] Prompt cache health: status=warming sample=1 hitRate=10 cacheRead=1000 promptTokens=10000 nearContext=false$/,
            ),
        )
    })

    it.each([
        ["incomplete", { completed: false }],
        ["compaction", { isCompactionRequest: true }],
    ] as const)("does not sample a %s request", (_label, overrides) => {
        const debug = vi.fn()
        const warn = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug, warn })

        const changed = tracker.recordRequest(request(overrides))

        expect(changed).toBe(false)
        expect(tracker.getSnapshot().sampleCount).toBe(0)
        expect(debug).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
    })

    it.each([
        ["unsupported", { supportsPromptCache: false }, "disabled"],
        ["unreported", { cacheUsageReported: false }, "waiting"],
    ] as const)("projects %s requests without sampling or logging", (_label, overrides, expectedStatus) => {
        const debug = vi.fn()
        const warn = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug, warn })
        for (let index = 0; index < 3; index++) tracker.recordRequest(request())
        debug.mockClear()
        warn.mockClear()

        const changed = tracker.recordRequest(request(overrides))

        expect(changed).toBe(false)
        expect(tracker.getSnapshot()).toMatchObject({
            status: expectedStatus,
            sampleCount: 0,
        })
        expect(tracker.getSnapshot().warningReason).toBeUndefined()
        expect(debug).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
    })

    it("emits one warning while the same cache warning persists", () => {
        const warn = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug: vi.fn(), warn })

        tracker.recordRequest(request())
        tracker.recordRequest(request())
        tracker.recordRequest(request())
        tracker.recordRequest(request())

        expect(tracker.getSnapshot().warningReason).toBe("cache_not_improving")
        expect(warn).toHaveBeenCalledOnce()
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(
                /^\[Task task-123\] Prompt cache warning: reason=cache_not_improving hitRate=10 cacheRead=1000 promptTokens=10000 nearContext=false$/,
            ),
        )
    })

    it("allows the same warning to be logged again after recovery", () => {
        const warn = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug: vi.fn(), warn })

        for (let index = 0; index < 3; index++) tracker.recordRequest(request())
        tracker.recordRequest(request({ cacheReadTokens: 3_000, inputTokens: 7_000 }))
        for (let index = 0; index < 3; index++) tracker.recordRequest(request({ cacheReadTokens: 3_000, inputTokens: 17_000 }))

        expect(warn).toHaveBeenCalledTimes(2)
    })

    it.each<PromptCacheHealthResetReason>(["profile_changed", "compaction_completed"])("resets and logs after %s", (reason) => {
        const debug = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug, warn: vi.fn() })
        for (let index = 0; index < 3; index++) tracker.recordRequest(request())
        debug.mockClear()

        const changed = tracker.reset(reason)
        tracker.recordRequest(request())

        expect(changed).toBe(true)
        expect(debug).toHaveBeenNthCalledWith(1, `[Task task-123] Prompt cache health reset: reason=${reason}`)
        expect(tracker.getSnapshot()).toMatchObject({ status: "warming", sampleCount: 1, warmingRound: 1 })
    })

    it("does not reset evidence when compaction fails", () => {
        const debug = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug, warn: vi.fn() })
        for (let index = 0; index < 3; index++) tracker.recordRequest(request())
        debug.mockClear()

        const changed = tracker.recordCompactionResult(false)

        expect(changed).toBe(false)
        expect(tracker.getSnapshot().warningReason).toBe("cache_not_improving")
        expect(debug).not.toHaveBeenCalled()
    })

    it("resets evidence only after successful compaction", () => {
        const debug = vi.fn()
        const tracker = new PromptCacheHealthTracker("task-123", { debug, warn: vi.fn() })
        for (let index = 0; index < 3; index++) tracker.recordRequest(request())
        debug.mockClear()

        const changed = tracker.recordCompactionResult(true)

        expect(changed).toBe(true)
        expect(tracker.getSnapshot()).toMatchObject({ status: "waiting", sampleCount: 0 })
        expect(debug).toHaveBeenCalledWith("[Task task-123] Prompt cache health reset: reason=compaction_completed")
    })
})
