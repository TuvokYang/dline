import { beforeEach, describe, expect, it, vi } from "vitest"
import { ControllerTaskSpawnLauncher } from "./ControllerTaskSpawnLauncher"

const mocks = vi.hoisted(() => ({
	createPanel: vi.fn(async () => undefined),
	disposePanel: vi.fn(async () => undefined),
	initTask: vi.fn(),
	recordSpawn: vi.fn(),
}))

vi.mock("@/hosts/vscode/VscodeWebviewPanelProvider", () => ({
	VscodeWebviewPanelProvider: class {
		readonly controller = { initTask: mocks.initTask }
		createPanel = mocks.createPanel
		dispose = mocks.disposePanel
	},
}))

vi.mock("@core/orchestrator/OrchestratorController", () => ({
	OrchestratorController: {
		getInstance: () => ({ recordSpawn: mocks.recordSpawn }),
	},
}))

describe("ControllerTaskSpawnLauncher peer-task port", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("creates and starts a background panel through the host boundary", async () => {
		mocks.initTask.mockImplementationOnce(async (...args: unknown[]) => {
			const options = args[5] as { beforeStart?: (taskId: string) => void }
			options.beforeStart?.("child-1")
			return "child-1"
		})
		const launcher = new ControllerTaskSpawnLauncher({ context: {} as never, parentTaskId: "parent-1" })
		const signal = new AbortController().signal

		await expect(
			launcher.spawn({
				task: "A peer task with a long title",
				mode: "plan",
				profile: "parent-profile",
				context: "Inherited context",
				signal,
			}),
		).resolves.toEqual({ childTaskId: "child-1" })

		expect(mocks.createPanel).toHaveBeenCalledWith("A peer task with")
		expect(mocks.initTask).toHaveBeenCalledWith(
			"A peer task with a long title",
			undefined,
			undefined,
			undefined,
			{ planModeProfile: "parent-profile", actModeProfile: "parent-profile", mode: "plan" },
			{
				context: ["Inherited context"],
				taskKind: "spawned",
				startInBackground: true,
				beforeStart: expect.any(Function),
			},
		)
		expect(mocks.recordSpawn).toHaveBeenCalledWith("parent-1", "child-1")
		expect(mocks.disposePanel).not.toHaveBeenCalled()
	})

	it("keeps an initialized peer task when cancellation arrives at the admission boundary", async () => {
		const controller = new AbortController()
		mocks.initTask.mockImplementationOnce(async (...args: unknown[]) => {
			const options = args[5] as { beforeStart?: (taskId: string) => void }
			options.beforeStart?.("child-1")
			controller.abort("late cancellation")
			return "child-1"
		})
		const launcher = new ControllerTaskSpawnLauncher({ context: {} as never, parentTaskId: "parent-1" })

		await expect(
			launcher.spawn({
				task: "Admitted peer",
				mode: "act",
				profile: "parent-profile",
				signal: controller.signal,
			}),
		).resolves.toEqual({ childTaskId: "child-1" })
		expect(mocks.disposePanel).not.toHaveBeenCalled()
	})

	it("disposes the provisional panel when child initialization fails", async () => {
		mocks.initTask.mockRejectedValueOnce(new Error("init failed"))
		const launcher = new ControllerTaskSpawnLauncher({ context: {} as never, parentTaskId: "parent-1" })

		await expect(
			launcher.spawn({
				task: "Failing child",
				mode: "act",
				profile: "parent-profile",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("init failed")
		expect(mocks.disposePanel).toHaveBeenCalledOnce()
	})

	it("does not allocate a panel when the task was already cancelled", async () => {
		const controller = new AbortController()
		controller.abort("cancelled")
		const launcher = new ControllerTaskSpawnLauncher({ context: {} as never, parentTaskId: "parent-1" })

		await expect(
			launcher.spawn({
				task: "Cancelled child",
				mode: "act",
				profile: "parent-profile",
				signal: controller.signal,
			}),
		).rejects.toBe("cancelled")
		expect(mocks.createPanel).not.toHaveBeenCalled()
	})
})
