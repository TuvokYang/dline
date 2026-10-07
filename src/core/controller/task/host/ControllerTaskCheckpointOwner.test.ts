import type { CheckpointRestoreFence } from "@core/task/session/ActiveTaskSession"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	buildCheckpointManager: vi.fn(),
}))

vi.mock("@integrations/checkpoints/factory", () => ({
	buildCheckpointManager: mocks.buildCheckpointManager,
}))

import { ControllerTaskCheckpointOwner } from "./ControllerTaskCheckpointOwner"

function fixture(result: "restored" | "rejected" = "restored") {
	const fence = {} as CheckpointRestoreFence
	const capture = vi.fn(async () => undefined)
	const restore = vi.fn(async () =>
		result === "restored"
			? ({ result: { kind: "restored" as const, diagnostics: [] }, fence } as const)
			: ({
					result: {
						kind: "rejected" as const,
						diagnostics: [{ code: "missing", message: "missing checkpoint" }],
					},
				} as const),
	)
	const reopenTaskForCheckpointRestore = vi.fn(async () => undefined)
	const controller = {
		updateTaskHistory: vi.fn(async () => []),
		cancelTask: vi.fn(async () => undefined),
		postStateToWebview: vi.fn(async () => undefined),
		reopenTaskForCheckpointRestore,
		task: { taskId: "task-1", inputs: { materialize: vi.fn() }, task: { submitInput: vi.fn() } },
	}
	const manager = { restoreCheckpoint: vi.fn() }
	mocks.buildCheckpointManager.mockReturnValue(manager)
	const owner = new ControllerTaskCheckpointOwner({
		controller,
		taskId: "task-1",
		taskInstanceId: "open-1",
		stateManager: { getGlobalSettingsKey: vi.fn(() => true) },
		messages: {},
		toolState: {},
		contextManager: {},
		fileContextTracker: {},
		taskFileTracker: {},
		diffViewProvider: {},
		say: vi.fn(),
		checkpoints: { capture, restore },
	} as never)
	const args = mocks.buildCheckpointManager.mock.calls.at(-1)?.[0]
	if (!args) throw new Error("checkpoint manager was not built")
	return { owner, manager, args, capture, restore, fence, reopenTaskForCheckpointRestore }
}

describe("ControllerTaskCheckpointOwner", () => {
	it("adapts the task checkpoint port and carries its fence into lifecycle reopen", async () => {
		const subject = fixture()
		const restoreWorkspace = vi.fn()

		await subject.args.canonicalCheckpoint.capture({ messageTs: 42, workspaceRef: "hash-1" })
		const result = await subject.args.canonicalCheckpoint.restore({
			messageTs: 42,
			mode: "chat_only",
			restoreWorkspace,
		})
		await subject.args.restoreChatRuntime({ apiIndex: 1 })

		expect(subject.owner.manager).toBe(subject.manager)
		expect(subject.capture).toHaveBeenCalledWith({ messageTs: 42, workspaceRef: "hash-1" })
		expect(result).toEqual({ kind: "restored", diagnostics: [] })
		expect(subject.reopenTaskForCheckpointRestore).toHaveBeenCalledExactlyOnceWith("task-1", subject.fence)
	})

	it("does not manufacture a fence for a rejected canonical restore", async () => {
		const subject = fixture("rejected")
		const result = await subject.args.canonicalCheckpoint.restore({
			messageTs: 42,
			mode: "chat_only",
			restoreWorkspace: vi.fn(),
		})

		expect(result).toMatchObject({ kind: "rejected" })
		await expect(subject.args.restoreChatRuntime({ apiIndex: 1 })).rejects.toThrow("has no canonical session fence")
		expect(subject.reopenTaskForCheckpointRestore).not.toHaveBeenCalled()
	})
})
