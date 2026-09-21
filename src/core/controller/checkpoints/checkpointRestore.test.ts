import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { describe, expect, it, vi } from "vitest"
import { checkpointRestore } from "./checkpointRestore"

/**
 * Chat restore cancels the live turn through the Task facade; the checkpoint
 * owner performs the file restore. Both are observed separately here.
 */
function createController() {
	const cancel = vi.fn(async () => ({ kind: "accepted" as const }))
	const restoreCheckpoint = vi.fn().mockResolvedValue({})
	const controller = {
		task: createSessionFixture({
			session: { task: { cancel } },
			owners: { checkpoints: { restoreCheckpoint } },
		}),
	}

	return { controller, cancel, restoreCheckpoint }
}

describe("checkpointRestore controller", () => {
	it("restores files without interrupting the active chat runtime", async () => {
		const { controller, cancel, restoreCheckpoint } = createController()

		await checkpointRestore(controller as never, CheckpointRestoreRequest.create({ number: 42, restoreType: "workspace" }))

		expect(cancel).not.toHaveBeenCalled()
		expect(restoreCheckpoint).toHaveBeenCalledWith(42, "workspace", undefined, undefined)
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

		expect(cancel).toHaveBeenCalledOnce()
		expect(restoreCheckpoint).toHaveBeenCalledWith(42, "task", undefined, undefined)
	})

	it.each(["task", "taskAndWorkspace"] as const)("interrupts runtime before %s restore", async (restoreType) => {
		const { controller, cancel, restoreCheckpoint } = createController()

		await checkpointRestore(controller as never, CheckpointRestoreRequest.create({ number: 42, restoreType }))

		expect(cancel).toHaveBeenCalledOnce()
		expect(restoreCheckpoint).toHaveBeenCalledWith(42, restoreType, undefined, undefined)
	})
})
