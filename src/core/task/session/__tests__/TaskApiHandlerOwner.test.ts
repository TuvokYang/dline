import type { ApiHandler } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskStateManager } from "../../TaskStateManager"
import { TaskApiHandlerOwner } from "../TaskApiHandlerOwner"

const built: ApiHandler[] = []

vi.mock("@core/api", () => ({
	buildApiHandler: vi.fn(() => {
		const handler = { abort: vi.fn() } as unknown as ApiHandler
		built.push(handler)
		return handler
	}),
}))

function createOwner() {
	const stateManager = { getApiConfigurationForTask: vi.fn(() => ({})) } as unknown as StateManager
	const settings = { mode: "act" } as TaskStateManager
	return new TaskApiHandlerOwner({ taskId: "task-1", taskIncarnationId: "incarnation-1", stateManager, settings })
}

describe("TaskApiHandlerOwner", () => {
	beforeEach(() => {
		built.length = 0
	})

	it("tells observers about the handler that now serves the task", async () => {
		const owner = createOwner()
		const observed: ApiHandler[] = []
		owner.onRebuilt((handler) => observed.push(handler))

		const next = await owner.rebuild({ abortPrevious: true })

		expect(observed).toEqual([next])
		expect(owner.current()).toBe(next)
		expect(built[0]?.abort).toHaveBeenCalledTimes(1)
	})

	it("keeps the switch when an observer fails", async () => {
		const owner = createOwner()
		const later = vi.fn()
		owner.onRebuilt(() => {
			throw new Error("view gone")
		})
		owner.onRebuilt(later)

		const next = await owner.rebuild()

		expect(owner.current()).toBe(next)
		expect(later).toHaveBeenCalledWith(next)
	})

	it("stops informing an observer that unsubscribed", async () => {
		const owner = createOwner()
		const observer = vi.fn()
		const unsubscribe = owner.onRebuilt(observer)

		unsubscribe()
		await owner.rebuild()

		expect(observer).not.toHaveBeenCalled()
	})
})
