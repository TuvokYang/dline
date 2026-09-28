import type CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"

vi.unmock("@integrations/checkpoints")

import { createTaskCheckpointManager } from "../index"

function createManager(messages: ClineMessage[], changedFileCount: number) {
	const tracker = {
		getDiffCount: vi.fn(),
		getTaskDiffCount: vi.fn().mockResolvedValue(changedFileCount),
	} as unknown as CheckpointTracker
	const manager = createTaskCheckpointManager(
		{ taskId: "task-1", controller: {} } as never,
		{ enableCheckpoints: true },
		{
			messageStateHandler: { clineMessages: messages },
			taskState: {},
			workspaceManager: { getPrimaryRoot: () => ({ path: "C:/workspace" }) },
		} as never,
		{} as never,
		{ checkpointTracker: tracker },
	)
	return { manager, tracker }
}

describe("TaskCheckpointManager completion change verdict", () => {
	it("uses the previous ask-form completion and task-owned diff count", async () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "checkpoint_created", lastCheckpointHash: ["task-start"] },
			{ ts: 2, type: "ask", ask: "completion_result", lastCheckpointHash: ["previous"] },
			{ ts: 3, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]
		const { manager, tracker } = createManager(messages, 0)

		await expect(manager.doesLatestTaskCompletionHaveNewChanges()).resolves.toBe(false)
		expect(tracker.getTaskDiffCount).toHaveBeenCalledWith("previous", "current")
		expect(tracker.getDiffCount).not.toHaveBeenCalled()
	})

	it("uses the task-start checkpoint for the first completion", async () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "checkpoint_created", lastCheckpointHash: ["task-start"] },
			{ ts: 2, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]
		const { manager, tracker } = createManager(messages, 2)

		await expect(manager.doesLatestTaskCompletionHaveNewChanges()).resolves.toBe(true)
		expect(tracker.getTaskDiffCount).toHaveBeenCalledWith("task-start", "current")
	})
})
