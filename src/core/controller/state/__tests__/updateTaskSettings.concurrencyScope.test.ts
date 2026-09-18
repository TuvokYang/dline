import { UpdateTaskSettingsRequest } from "@shared/proto/dline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { updateTaskSettings } from "../updateTaskSettings"

const { findEnabledProfileByName, getProfileModelInfo, readApiProfiles } = vi.hoisted(() => ({
	findEnabledProfileByName: vi.fn(),
	getProfileModelInfo: vi.fn(),
	readApiProfiles: vi.fn(),
}))

vi.mock("@core/controller/file/getApiProfiles", () => ({
	findEnabledProfileByName,
	readApiProfiles,
}))

vi.mock("@core/api/model-info", () => ({
	getProfileModelInfo,
}))

function createController() {
	const setTaskSettingsBatch = vi.fn()
	const setTaskSettings = vi.fn()
	const controller = {
		stateManager: {
			setTaskSettingsBatch,
			setTaskSettings,
			clearTaskSetting: vi.fn(),
			flushPendingState: vi.fn(async () => {}),
			getApiConfigurationForTask: vi.fn(() => ({})),
			getGlobalSettingsKey: vi.fn((key: string) => {
				if (key === "autoApprovalSettings") return { actions: {} }
				if (key === "browserSettings") return { viewport: { width: 900, height: 600 } }
				if (key === "mode") return "act"
				return undefined
			}),
		},
		task: undefined,
		restartAccountUsagePolling: vi.fn(),
		postStateToWebview: vi.fn(async () => {}),
	} as unknown as Controller

	return { controller, setTaskSettings, setTaskSettingsBatch }
}

describe("updateTaskSettings concurrency ceiling scope", () => {
	it("keeps the concurrency ceilings out of task settings", async () => {
		const fixture = createController()

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					maxConsecutiveMistakes: 5,
					maxParallelToolCalls: 9_000,
					maxParallelSubagents: 9_000,
				},
			}),
		)

		// The ceilings are global-only. Writing them here would both persist an
		// unclamped value and shadow the global document on read, so a slider
		// change made from Settings would appear to snap back while a task runs.
		expect(fixture.setTaskSettingsBatch).toHaveBeenCalledWith("task-1", { maxConsecutiveMistakes: 5 })
		expect(fixture.setTaskSettings).not.toHaveBeenCalledWith("task-1", "maxParallelToolCalls", expect.anything())
		expect(fixture.setTaskSettings).not.toHaveBeenCalledWith("task-1", "maxParallelSubagents", expect.anything())
	})

	it("writes nothing when a request carries only the concurrency ceilings", async () => {
		const fixture = createController()

		await updateTaskSettings(
			fixture.controller,
			UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					maxParallelToolCalls: 4,
					maxParallelSubagents: 8,
				},
			}),
		)

		expect(fixture.setTaskSettingsBatch).not.toHaveBeenCalled()
	})
})
