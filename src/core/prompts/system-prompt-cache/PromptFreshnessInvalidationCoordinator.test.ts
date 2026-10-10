import { describe, expect, it, vi } from "vitest"
import { PromptFreshnessInvalidationCoordinator } from "./PromptFreshnessInvalidationCoordinator"

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

describe("PromptFreshnessInvalidationCoordinator", () => {
    it("debounces rapid invalidations into one reevaluation and one state publish", async () => {
        vi.useFakeTimers()
        const reevaluate = vi.fn().mockResolvedValue(undefined)
        const publishState = vi.fn().mockResolvedValue(undefined)
        const coordinator = new PromptFreshnessInvalidationCoordinator({ reevaluate, publishState, debounceMs: 100 })

        coordinator.invalidate("prompt_input_file")
        coordinator.invalidate("prompt_input_file")
        coordinator.invalidate("prompt_input_file")
        await vi.advanceTimersByTimeAsync(100)

        expect(reevaluate).toHaveBeenCalledOnce()
        expect(publishState).toHaveBeenCalledOnce()
        vi.useRealTimers()
    })

    it("runs one follow-up pass when a new invalidation arrives during reevaluation", async () => {
        const firstPass = deferred()
        const reevaluate = vi
            .fn()
            .mockImplementationOnce(() => firstPass.promise)
            .mockResolvedValue(undefined)
        const publishState = vi.fn().mockResolvedValue(undefined)
        const coordinator = new PromptFreshnessInvalidationCoordinator({ reevaluate, publishState })

        const flush = coordinator.flush("task_capability_toggle")
        await Promise.resolve()
        coordinator.invalidate("prompt_input_file")
        firstPass.resolve()
        await flush

        expect(reevaluate).toHaveBeenCalledTimes(2)
        expect(publishState).toHaveBeenCalledTimes(2)
    })

    it("recovers after reevaluation or state publication fails", async () => {
        const reevaluate = vi.fn().mockRejectedValueOnce(new Error("reevaluation failed")).mockResolvedValue(undefined)
        const publishState = vi.fn().mockRejectedValueOnce(new Error("publication failed")).mockResolvedValue(undefined)
        const coordinator = new PromptFreshnessInvalidationCoordinator({ reevaluate, publishState })

        await expect(coordinator.flush("settings")).rejects.toThrow("reevaluation failed")
        await expect(coordinator.flush("settings")).rejects.toThrow("publication failed")
        await expect(coordinator.flush("settings")).resolves.toBeUndefined()

        expect(reevaluate).toHaveBeenCalledTimes(3)
        expect(publishState).toHaveBeenCalledTimes(2)
    })

    it("does not publish an in-flight result after disposal", async () => {
        const pass = deferred()
        const publishState = vi.fn().mockResolvedValue(undefined)
        const coordinator = new PromptFreshnessInvalidationCoordinator({
            reevaluate: () => pass.promise,
            publishState,
        })

        const flush = coordinator.flush("prompt_input_file")
        await Promise.resolve()
        coordinator.dispose()
        pass.resolve()
        await flush

        expect(publishState).not.toHaveBeenCalled()
    })

    it("cancels a pending debounce when disposed", async () => {
        vi.useFakeTimers()
        try {
            const reevaluate = vi.fn().mockResolvedValue(undefined)
            const publishState = vi.fn().mockResolvedValue(undefined)
            const coordinator = new PromptFreshnessInvalidationCoordinator({ reevaluate, publishState, debounceMs: 100 })

            coordinator.invalidate("prompt_input_file")
            coordinator.dispose()
            await vi.advanceTimersByTimeAsync(100)

            expect(reevaluate).not.toHaveBeenCalled()
            expect(publishState).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
