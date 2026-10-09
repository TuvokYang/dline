import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { describe, expect, it, vi } from "vitest"
import { checkpointRestore } from "./checkpointRestore"

/** The checkpoint owner, not the RPC boundary, owns validation and runtime fencing. */
function createController() {
	const cancel = vi.fn(async () => ({ kind: "accepted" as const }))
	const restoreCheckpoint = vi.fn().mockResolvedValue({})
	const completeTaskCheckpointRestore = vi.fn(async () => undefined)
	const controller = {
		task: createSessionFixture({
			session: { task: { cancel } },
			owners: { checkpoints: { restoreCheckpoint } },
		}),
		completeTaskCheckpointRestore,
	}

	return { controller, cancel, restoreCheckpoint, completeTaskCheckpointRestore }
}

describe("checkpointRestore controller", () => {
	it("restores files without interrupting the active chat runtime", async () => {
		const { controller, cancel, restoreCheckpoint, completeTaskCheckpointRestore } = createController()

		await checkpointRestore(controller as never, CheckpointRestoreRequest.create({ number: 42, restoreType: "workspace" }))

		expect(cancel).not.toHaveBeenCalled()
		expect(restoreCheckpoint).toHaveBeenCalledWith(42, "workspace", undefined, undefined)
		expect(completeTaskCheckpointRestore).toHaveBeenCalledWith(controller.task.taskId)
	})

	it("ignores deprecated compaction restore identity and uses the ordinary task restore transaction", async () => {
		const { controller, cancel, restoreCheckpoint } = createController()

		await checkpointRestore(
			controller as never,
			CheckpointRestoreRequest.create({
				number: 42,
				restoreType: "task",
				compactionOperationId: "operation-1",
				compactionCheckpointId: "sha256:pre-pass",
				compactionExpectedHeadCheckpointId: "sha256:post-pass",
				compactionExpectedChainRevision: 2,
			}),
		)

		expect(cancel).not.toHaveBeenCalled()
		expect(restoreCheckpoint).toHaveBeenCalledWith(42, "task", undefined, undefined)
	})

	it.each([
		"task",
		"taskAndWorkspace",
	] as const)("delegates %s restore without a separate cancel lifecycle", async (restoreType) => {
		const { controller, cancel, restoreCheckpoint } = createController()

		await checkpointRestore(controller as never, CheckpointRestoreRequest.create({ number: 42, restoreType }))

		expect(cancel).not.toHaveBeenCalled()
		expect(restoreCheckpoint).toHaveBeenCalledWith(42, restoreType, undefined, undefined)
	})

	it("passes edited historical input to the restore transaction for immediate continuation", async () => {
		const { controller, restoreCheckpoint } = createController()

		await checkpointRestore(
			controller as never,
			CheckpointRestoreRequest.create({
				number: 42,
				restoreType: "task",
				offset: 7,
				editedText: "continue from the edited request",
			}),
		)

		expect(restoreCheckpoint).toHaveBeenCalledWith(42, "task", 7, "continue from the edited request")
	})
})
