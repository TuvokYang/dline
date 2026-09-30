import { Controller } from "@core/controller"
import type { Task } from "@core/task"
import { describe, expect, it, vi } from "vitest"

describe("Controller New Task successor ownership", () => {
	it("starts the successor only while the source Task still owns the surface", async () => {
		const controller = Object.create(Controller.prototype) as Controller
		const source = { taskId: "task-old" } as Task
		Object.assign(controller as unknown as Record<string, unknown>, { task: source })
		const clearTask = vi.fn(async () => undefined)
		vi.spyOn(controller, "runTaskLifecycleOperation").mockImplementation(async (operation) => operation({ clearTask }))
		const initTask = vi.spyOn(controller, "initTask").mockResolvedValue("task-new")
		const initialUserContent = [{ type: "text" as const, text: "<feedback>\nContinue narrowly\n</feedback>" }]

		const taskId = await controller.startSuccessorTask(
			source,
			"Successor context",
			{ mode: "act", planModeProfile: "plan-old", actModeProfile: "act-old" },
			initialUserContent,
		)

		expect(taskId).toBe("task-new")
		expect(clearTask).toHaveBeenCalledWith({ suppressPostState: true })
		expect(initTask).toHaveBeenCalledWith(
			"Successor context",
			undefined,
			undefined,
			undefined,
			{ mode: "act", planModeProfile: "plan-old", actModeProfile: "act-old" },
			{
				startInBackground: true,
				initialUserContent,
				skipInitialClear: true,
			},
		)
	})

	it.each([
		"task-user-opened",
		"task-old",
	])("does not clear replacement opening %s before a deferred successor", async (replacementId) => {
		const controller = Object.create(Controller.prototype) as Controller
		const source = { taskId: "task-old" } as Task
		const replacement = { taskId: replacementId } as Task
		Object.assign(controller as unknown as Record<string, unknown>, { task: replacement })
		const clearTask = vi.fn(async () => undefined)
		vi.spyOn(controller, "runTaskLifecycleOperation").mockImplementation(async (operation) => operation({ clearTask }))
		const initTask = vi.spyOn(controller, "initTask").mockResolvedValue("task-new")

		const taskId = await controller.startSuccessorTask(source, "Successor context", { mode: "plan" }, [])

		expect(taskId).toBeUndefined()
		expect(clearTask).not.toHaveBeenCalled()
		expect(initTask).not.toHaveBeenCalled()
		expect(controller.task).toBe(replacement)
	})

	it("checks the source opening inside the lifecycle lane before a delayed footer close", async () => {
		const controller = Object.create(Controller.prototype) as Controller
		const source = { taskId: "task-old" } as Task
		const replacement = { taskId: "task-old" } as Task
		controller.task = source
		const clearTask = vi.fn(async () => undefined)
		vi.spyOn(controller, "runTaskLifecycleOperation").mockImplementation(async (operation) => {
			controller.task = replacement
			return operation({ clearTask })
		})

		await controller.clearTask({ expectedTask: source, preserveCompletedState: true })
		expect(clearTask).not.toHaveBeenCalled()
		expect(controller.task).toBe(replacement)
	})
})
