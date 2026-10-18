import type { StateManager } from "@core/storage/StateManager"
import type { MessageStateHandler } from "@core/task/message-state"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { HookTaskStartContext } from "../TaskStartContextPort"

/**
 * TaskStart is the only hook whose context has to reach the first turn, so the
 * port is asserted against the executor contract rather than a live hook script.
 */
const executeHook = vi.hoisted(() => vi.fn())

vi.mock("../hook-executor", () => ({ executeHook }))

const IDENTITY = { taskId: "task-1", ulid: "ulid-1", initialTask: "do the thing" }

function port(
    hooksEnabled = true,
    discoverHooks: (waitMs: number) => Promise<readonly string[] | undefined> = async () => ["TaskStart.test"],
): HookTaskStartContext {
    return new HookTaskStartContext({
        stateManager: { getGlobalSettingsKey: () => hooksEnabled } as unknown as StateManager,
        messages: {} as MessageStateHandler,
        say: async () => undefined,
        discoverHooks,
    })
}

describe("HookTaskStartContext", () => {
    beforeEach(() => {
        executeHook.mockReset()
    })

    it("returns the context the hook contributed to the first turn", async () => {
        executeHook.mockResolvedValue({ wasCancelled: false, contextModification: "WORKSPACE_POLICY" })

        await expect(port().collect(IDENTITY)).resolves.toBe("WORKSPACE_POLICY")
        expect(executeHook).toHaveBeenCalledWith(
            expect.objectContaining({
                hookName: "TaskStart",
                taskId: "task-1",
                hooksEnabled: true,
                hookInput: { taskStart: { taskMetadata: IDENTITY } },
            }),
        )
    })

    it("contributes nothing when no hook is configured", async () => {
        executeHook.mockResolvedValue({ wasCancelled: false })

        await expect(port().collect(IDENTITY)).resolves.toBeUndefined()
    })

    it("refuses the start when the hook cancels it", async () => {
        executeHook.mockResolvedValue({ wasCancelled: false, cancel: true, errorMessage: "policy refused" })

        await expect(port().collect(IDENTITY)).rejects.toThrow("policy refused")
    })

    it("passes the hooks-enabled setting through to the executor", async () => {
        executeHook.mockResolvedValue({ wasCancelled: false })

        await port(false).collect(IDENTITY)

        expect(executeHook).toHaveBeenCalledWith(expect.objectContaining({ hooksEnabled: false }))
    })

    it("joins in-flight discovery with a finite wait instead of skipping the hook", async () => {
        executeHook.mockResolvedValue({ wasCancelled: false, contextModification: "REWARMED_POLICY" })
        const waits: number[] = []

        const context = await port(true, async (waitMs) => {
            waits.push(waitMs)
            return ["TaskStart.rewarmed"]
        }).collect(IDENTITY)

        expect(context).toBe("REWARMED_POLICY")
        expect(waits).toHaveLength(1)
        expect(waits[0]).toBeGreaterThan(0)
        expect(Number.isFinite(waits[0])).toBe(true)
    })

    it("starts without a hook when discovery does not settle within the wait", async () => {
        await expect(port(true, async () => undefined).collect(IDENTITY)).resolves.toBeUndefined()
        expect(executeHook).not.toHaveBeenCalled()
    })

    it("does not run the executor when discovery found no TaskStart hook", async () => {
        await expect(port(true, async () => []).collect(IDENTITY)).resolves.toBeUndefined()
        expect(executeHook).not.toHaveBeenCalled()
    })
})
