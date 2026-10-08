import { Controller } from "@core/controller"
import { describe, expect, it, vi } from "vitest"

/** Verify Controller mode-switch entrypoints delegate to the task-local coordinator. */
describe("Controller mode switch integration", () => {
	/** Preserve task identity and draft payload when requesting a switch. */
	it("delegates requests to the coordinator", async () => {
		const request = vi.fn(async () => ({ status: "confirmation_required", operationId: "operation-1" }))
		const fakeController = {
			task: { taskId: "task-1", writable: true },
			modeSwitchCoordinator: { request },
		}
		const draft = { message: "draft", images: ["image"], files: ["file"] }

		const result = await Controller.prototype.requestModeSwitch.call(fakeController, "act", draft)

		expect(result).toEqual({ status: "confirmation_required", operationId: "operation-1" })
		expect(request).toHaveBeenCalledWith({ taskId: "task-1", targetMode: "act", chatContent: draft })
	})

	/** A window that does not own the task must not start a transaction that writes it. */
	it("rejects a switch while another window owns the task", async () => {
		const request = vi.fn()
		const fakeController = { task: { taskId: "task-1", writable: false }, modeSwitchCoordinator: { request } }

		const result = await Controller.prototype.requestModeSwitch.call(fakeController, "act")

		expect(result).toEqual({ status: "rejected", error: "Task is read-only in this window." })
		expect(request).not.toHaveBeenCalled()
	})

	/** Preserve welcome-screen mode selection when no task-local transaction exists. */
	it("switches the global mode directly without an active task", async () => {
		const setGlobalState = vi.fn()
		const postStateToWebview = vi.fn(async () => undefined)
		const fakeController = {
			task: undefined,
			stateManager: { setGlobalState },
			postStateToWebview,
		}

		const result = await Controller.prototype.requestModeSwitch.call(fakeController, "plan")

		expect(result.status).toBe("switched")
		expect(result.operationId).toEqual(expect.any(String))
		expect(setGlobalState).toHaveBeenCalledWith("mode", "plan")
		expect(postStateToWebview).toHaveBeenCalledWith({ immediate: true })
	})

	/** Keep the legacy Boolean wrapper false until the backend transaction commits. */
	it("maps only switched results to true", async () => {
		const requestModeSwitch = vi
			.fn()
			.mockResolvedValueOnce({ status: "confirmation_required", operationId: "operation-1" })
			.mockResolvedValueOnce({ status: "switched", operationId: "operation-2" })
		const fakeController = { requestModeSwitch }

		await expect(Controller.prototype.togglePlanActMode.call(fakeController, "act")).resolves.toBe(false)
		await expect(Controller.prototype.togglePlanActMode.call(fakeController, "plan")).resolves.toBe(true)
	})

	/** Delegate operation commands without duplicating transaction logic. */
	it("delegates confirm and cancel commands", async () => {
		const confirm = vi.fn(async () => ({ status: "switched", operationId: "operation-1" }))
		const cancel = vi.fn(async () => ({ status: "rejected", operationId: "operation-2" }))
		const fakeController = { modeSwitchCoordinator: { confirm, cancel } }

		await Controller.prototype.confirmModeSwitch.call(fakeController, "operation-1")
		await Controller.prototype.cancelModeSwitch.call(fakeController, "operation-2")

		expect(confirm).toHaveBeenCalledWith("operation-1")
		expect(cancel).toHaveBeenCalledWith("operation-2")
	})
})
