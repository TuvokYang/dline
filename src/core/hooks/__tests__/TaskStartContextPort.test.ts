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

function port(hooksEnabled = true): HookTaskStartContext {
	return new HookTaskStartContext({
		stateManager: { getGlobalSettingsKey: () => hooksEnabled } as unknown as StateManager,
		messages: {} as MessageStateHandler,
		say: async () => undefined,
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
})
