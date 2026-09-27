import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createStorageContext } from "@shared/storage/storage-context"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"

/**
 * Regression coverage for the Profile a task restored from History is bound to.
 *
 * Opening a task from History must resolve that task's own Profile, not
 * whichever Profile happens to be selected globally. The lightweight history
 * surface stopped loading task settings, so the model switcher reported the
 * global Profile for a task explicitly bound to another one.
 */

const GLOBAL_PROFILE_ID = "profile-global"
const TASK_PROFILE_ID = "profile-task-bound"
const TASK_ID = "history-profile-binding"

describe("StateManager task-bound Profile resolution", () => {
	let temporaryDirectory: string

	beforeEach(async () => {
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-history-profile-"))
		vi.stubEnv("DLINE_DOCS_DIR", temporaryDirectory)
	})

	afterEach(async () => {
		await StateManager.resetForTest()
		vi.unstubAllEnvs()
		await fs.rm(temporaryDirectory, { recursive: true, force: true })
	})

	it("resolves the task Profile only once task settings are loaded", async () => {
		const state = await StateManager.initialize(createStorageContext({ clineDir: temporaryDirectory }))

		// The switcher reads the Profile bound to the current mode, so the global
		// value and the task value have to be written to the same key.
		state.setGlobalState("actModeProfileId", GLOBAL_PROFILE_ID)
		state.setTaskSettings(TASK_ID, "actModeProfileId", TASK_PROFILE_ID)
		await state.flushPendingState()

		// A surface that never loads task settings falls back to the global
		// Profile. That fallback is exactly what the History display showed.
		await state.clearTaskSettings(TASK_ID)
		expect(state.getApiConfiguration().actModeProfileId).toBe(GLOBAL_PROFILE_ID)

		await state.loadTaskSettings(TASK_ID)

		expect(state.getApiConfiguration().actModeProfileId).toBe(TASK_PROFILE_ID)
		expect(state.getApiConfigurationForTask(TASK_ID).actModeProfileId).toBe(TASK_PROFILE_ID)
	})
})
