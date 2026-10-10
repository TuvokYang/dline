import type { ApiHandler } from "@core/api"
import { describe, expect, it, vi } from "vitest"
import { ModeSwitchCompaction } from "../ModeSwitchCompaction"

interface DeferredValue<T> {
    promise: Promise<T>
    resolve: (value: T) => void
}

/** Create a manually controlled promise for barrier-order assertions. */
function createDeferred<T>(): DeferredValue<T> {
    let resolveValue: ((value: T) => void) | undefined
    const promise = new Promise<T>((resolve) => {
        resolveValue = resolve
    })
    return {
        promise,
        resolve: (value) => resolveValue?.(value),
    }
}

const TARGET_API = { getModel: vi.fn() } as unknown as ApiHandler

/** Verify forced compaction completion and release ordering. */
describe("ModeSwitchCompaction", () => {
    /** Freeze the pending target handler for every forced Pass until terminal cleanup. */
    it("exposes the target execution scope only while its operation is active", async () => {
        const compaction = new ModeSwitchCompaction()
        const completion = compaction.request("operation-1", TARGET_API, "act", async () => true)

        expect(compaction.getExecutionScope()).toEqual({ operationId: "operation-1", api: TARGET_API, mode: "act" })
        compaction.fail("operation-1", "failed")

        await expect(completion).resolves.toBe("failed")
        expect(compaction.getExecutionScope()).toBeUndefined()
    })

    /** Resolve completion only after the summarize tool applied its context changes. */
    it("resolves completion only after summary application", async () => {
        const compaction = new ModeSwitchCompaction()
        let result: string | undefined
        void compaction.request("operation-1", TARGET_API, "act", vi.fn()).then((value) => {
            result = value
        })

        await Promise.resolve()
        expect(result).toBeUndefined()
        const applied = compaction.markApplied()
        await Promise.resolve()
        expect(result).toBe("completed")

        compaction.release("operation-1")
        await applied
    })

    /** Hold the task loop until Coordinator releases the committed operation. */
    it("holds the task loop until coordinator release", async () => {
        const compaction = new ModeSwitchCompaction()
        void compaction.request("operation-1", TARGET_API, "act", vi.fn())
        let appliedDone = false
        const applied = compaction.markApplied().then(() => {
            appliedDone = true
        })

        await Promise.resolve()
        expect(appliedDone).toBe(false)
        compaction.release("operation-1")
        await applied
        expect(appliedDone).toBe(true)
    })

    /** Reject a second operation while one source-mode compaction is active. */
    it("rejects a second active operation", async () => {
        const compaction = new ModeSwitchCompaction()
        void compaction.request("operation-1", TARGET_API, "act", vi.fn())

        await expect(compaction.request("operation-2", TARGET_API, "act", vi.fn())).resolves.toBe("failed")
        expect(compaction.getOperationId()).toBe("operation-1")
    })

    /** Ignore stale release and failure commands from older operations. */
    it("ignores stale operation commands", async () => {
        const compaction = new ModeSwitchCompaction()
        const result = compaction.request("operation-1", TARGET_API, "act", vi.fn())
        compaction.release("stale-operation")
        compaction.fail("stale-operation", "stale")

        expect(compaction.shouldForce()).toBe(true)
        compaction.fail("operation-1", "failed")
        await expect(result).resolves.toBe("failed")
    })

    /** Return cancelled and release the barrier when task lifecycle aborts. */
    it("returns cancelled after task abort", async () => {
        const compaction = new ModeSwitchCompaction()
        const result = compaction.request("operation-1", TARGET_API, "act", vi.fn())

        compaction.abort()

        await expect(result).resolves.toBe("cancelled")
        expect(compaction.shouldForce()).toBe(false)
    })

    /** Wake a pending conversational ask exactly once without owning UI projection. */
    it("wakes the current ask without feedback callbacks", async () => {
        const compaction = new ModeSwitchCompaction()
        const wakeAsk = vi.fn()
        const unrelatedFeedback = vi.fn()
        const result = compaction.request("operation-1", TARGET_API, "act", wakeAsk)

        expect(wakeAsk).toHaveBeenCalledOnce()
        expect(unrelatedFeedback).not.toHaveBeenCalled()
        compaction.fail("operation-1", "failed")
        await expect(result).resolves.toBe("failed")
    })

    /** Fail promptly when the active interaction cannot safely carry the compact signal. */
    it("fails when no compatible interaction can be continued", async () => {
        const compaction = new ModeSwitchCompaction()

        await expect(compaction.request("operation-1", TARGET_API, "act", async () => false)).resolves.toBe("failed")
        expect(compaction.getOperationId()).toBeUndefined()
    })

    /** Transfer confirmation-owned draft content only after the target commit barrier releases. */
    it("retains draft content until successful summary application", async () => {
        const compaction = new ModeSwitchCompaction()
        const completion = compaction.request("operation-1", TARGET_API, "act", async () => true, {
            message: "pending draft",
            images: ["image-1"],
            files: ["file-1"],
        })
        const applied = compaction.markApplied()
        await expect(completion).resolves.toBe("completed")
        expect(compaction.takeChatContent()).toBeUndefined()

        compaction.release("operation-1")
        await applied
        expect(compaction.takeChatContent()).toEqual({
            message: "pending draft",
            images: ["image-1"],
            files: ["file-1"],
        })
        expect(compaction.takeChatContent()).toBeUndefined()
    })

    /** Do not allow release before summary application to lose the barrier signal. */
    it("remembers early release until summary application", async () => {
        const compaction = new ModeSwitchCompaction()
        const completion = compaction.request("operation-1", TARGET_API, "act", vi.fn())
        compaction.release("operation-1")

        await compaction.markApplied()
        await expect(completion).resolves.toBe("completed")
        expect(compaction.getOperationId()).toBeUndefined()
    })

    /** Keep the test helper type exercised without arbitrary timers. */
    it("supports deterministic external coordination", async () => {
        const deferred = createDeferred<string>()
        deferred.resolve("ready")
        await expect(deferred.promise).resolves.toBe("ready")
    })
})
