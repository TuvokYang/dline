import { strict as assert } from "node:assert"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { refreshPrompt } from "../refreshPrompt"

describe("refreshPrompt", () => {
	it("logs and refreshes the active task prompt cache immediately", async () => {
		const debugSpy = vi.spyOn(Logger, "debug").mockImplementation(() => {})
		const session = createSessionFixture({ taskId: "task-1" })
		const controller = { task: session }

		const response = await refreshPrompt(controller as never, { taskId: "task-1" })

		assert.equal(response.success, true)
		expect(session.owners.prompt.refreshManual).toHaveBeenCalledTimes(1)
		expect(debugSpy).toHaveBeenCalledWith("[RefreshPrompt] requested taskId=task-1")
		expect(debugSpy).toHaveBeenCalledWith("[RefreshPrompt] refreshed taskId=task-1")
	})

	it("logs and rejects refresh when the requested task is not active", async () => {
		const debugSpy = vi.spyOn(Logger, "debug").mockImplementation(() => {})
		const session = createSessionFixture({ taskId: "task-1" })
		const controller = { task: session }

		const response = await refreshPrompt(controller as never, { taskId: "task-2" })

		assert.equal(response.success, false)
		expect(session.owners.prompt.refreshManual).not.toHaveBeenCalled()
		expect(debugSpy).toHaveBeenCalledWith("[RefreshPrompt] requested taskId=task-2")
		expect(debugSpy).toHaveBeenCalledWith("[RefreshPrompt] rejected taskId=task-2 activeTaskId=task-1")
	})
})
