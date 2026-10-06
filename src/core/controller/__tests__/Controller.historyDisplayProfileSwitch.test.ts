import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller } from "@core/controller"
import * as profileCatalog from "@core/controller/file/getApiProfiles"
import { createStorageContext } from "@shared/storage/storage-context"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"

/**
 * A task reopened from History is shown by a read-only display session, so the
 * panel has no live Task. Selecting a Profile there must still bind the task
 * the panel shows, as dev does by resuming that task, and must not move the
 * Profile every other window falls back to.
 */

const TASK_ID = "task-history"
const CHAT_PROFILE = { id: "chat-id", name: "chat" }
const RESPONSES_PROFILE = { id: "resp-id", name: "resp" }

describe("Controller Profile switch on a history display", () => {
	let temporaryDirectory: string
	let state: StateManager

	beforeEach(async () => {
		vi.restoreAllMocks()
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-history-display-profile-"))
		vi.stubEnv("DLINE_DOCS_DIR", temporaryDirectory)
		state = await StateManager.initialize(createStorageContext({ clineDir: temporaryDirectory }))
		vi.spyOn(profileCatalog, "readApiProfiles").mockReturnValue([
			{ ...CHAT_PROFILE, enabled: true } as never,
			{ ...RESPONSES_PROFILE, enabled: true } as never,
		])

		state.setGlobalState("actModeProfileId", CHAT_PROFILE.id)
		state.setGlobalState("actModeProfile", CHAT_PROFILE.name)
		state.setTaskSettings(TASK_ID, "actModeProfileId", CHAT_PROFILE.id)
		state.setTaskSettings(TASK_ID, "actModeProfile", CHAT_PROFILE.name)
		state.setTaskSettings(TASK_ID, "actModeReasoningOverrideKind", "effort")
		await state.flushPendingState()
	})

	afterEach(async () => {
		await StateManager.resetForTest()
		vi.unstubAllEnvs()
		await fs.rm(temporaryDirectory, { recursive: true, force: true })
	})

	function createDisplayController(locked: boolean) {
		return {
			task: undefined,
			historyDisplaySession: { taskId: TASK_ID, isLocked: () => locked },
			stateManager: state,
			profileSwitchCoordinator: { request: vi.fn() },
			postStateToWebview: vi.fn(async () => undefined),
			restartAccountUsagePolling: vi.fn(),
			commitHistoryDisplayProfile: Reflect.get(Controller.prototype, "commitHistoryDisplayProfile"),
		}
	}

	it("binds the displayed task durably and leaves the global Profile alone", async () => {
		const controller = createDisplayController(false)

		const result = await Controller.prototype.requestProfileSwitch.call(controller, RESPONSES_PROFILE.id, ["act"])

		expect(result.status).toBe("switched")
		expect(state.getApiConfigurationForTask(TASK_ID).actModeProfileId).toBe(RESPONSES_PROFILE.id)
		expect(state.getApiConfigurationForTask(TASK_ID).actModeProfile).toBe(RESPONSES_PROFILE.name)
		expect(state.getCanonicalSettingsKey("actModeProfileId")).toBe(CHAT_PROFILE.id)
		expect(state.getTaskCacheRef(TASK_ID).actModeReasoningOverrideKind).toBeUndefined()
		expect(controller.profileSwitchCoordinator.request).not.toHaveBeenCalled()
		expect(controller.restartAccountUsagePolling).toHaveBeenCalledOnce()
		expect(controller.postStateToWebview).toHaveBeenCalledWith({ immediate: true })

		// Sending from the panel promotes the task, which reloads its settings from disk.
		await state.clearTaskSettings(TASK_ID)
		await state.loadTaskSettings(TASK_ID)
		expect(state.getApiConfigurationForTask(TASK_ID).actModeProfileId).toBe(RESPONSES_PROFILE.id)
	})

	it("rejects the switch while another window owns the displayed task", async () => {
		const controller = createDisplayController(true)

		const result = await Controller.prototype.requestProfileSwitch.call(controller, RESPONSES_PROFILE.id, ["act"])

		expect(result.status).toBe("rejected")
		expect(state.getApiConfigurationForTask(TASK_ID).actModeProfileId).toBe(CHAT_PROFILE.id)
		expect(state.getTaskCacheRef(TASK_ID).actModeReasoningOverrideKind).toBe("effort")
		expect(controller.postStateToWebview).not.toHaveBeenCalled()
	})
})
