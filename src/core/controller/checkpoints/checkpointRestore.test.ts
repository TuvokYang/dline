import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { describe, expect, it, vi } from "vitest"
import { checkpointRestore } from "./checkpointRestore"

/** The checkpoint owner, not the RPC boundary, owns validation and runtime fencing. */
function createController() {
    const cancel = vi.fn(async () => ({ kind: "accepted" as const }))
    const restoreCheckpoint = vi.fn().mockResolvedValue({})
    const completeTaskCheckpointRestore = vi.fn(async () => undefined)
    const task = createSessionFixture({
        taskInstanceId: "open-1",
        session: { task: { cancel } },
        owners: { checkpoints: { restoreCheckpoint } },
    })
    const controller = {
        task,
        currentOpening: () => ({ taskId: task.taskId, taskInstanceId: task.taskInstanceId }),
        completeTaskCheckpointRestore,
    }

    return { controller, cancel, restoreCheckpoint, completeTaskCheckpointRestore }
}

const request = (fields: Partial<CheckpointRestoreRequest> = {}) =>
    CheckpointRestoreRequest.create({
        number: 42,
        checkpointRowTs: 42,
        restoreType: "task",
        taskId: "task-1",
        taskInstanceId: "open-1",
        ...fields,
    })

describe("checkpointRestore controller", () => {
    it("restores files without interrupting the active chat runtime", async () => {
        const { controller, cancel, restoreCheckpoint, completeTaskCheckpointRestore } = createController()

        await checkpointRestore(controller as never, request({ restoreType: "workspace" }))

        expect(cancel).not.toHaveBeenCalled()
        expect(restoreCheckpoint).toHaveBeenCalledWith(42, "workspace", undefined, undefined)
        expect(completeTaskCheckpointRestore).toHaveBeenCalledWith(controller.task.taskId)
    })

    it("ignores deprecated compaction restore identity and uses the ordinary task restore transaction", async () => {
        const { controller, cancel, restoreCheckpoint } = createController()

        await checkpointRestore(
            controller as never,
            request({
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

        await checkpointRestore(controller as never, request({ restoreType }))

        expect(cancel).not.toHaveBeenCalled()
        expect(restoreCheckpoint).toHaveBeenCalledWith(42, restoreType, undefined, undefined)
    })

    it("rejects a restore from an earlier opening of the same task", async () => {
        const { controller, restoreCheckpoint, completeTaskCheckpointRestore } = createController()

        await checkpointRestore(controller as never, request({ taskInstanceId: "open-stale" }))

        expect(restoreCheckpoint).not.toHaveBeenCalled()
        expect(completeTaskCheckpointRestore).not.toHaveBeenCalled()
    })

    it("passes edited historical input to the restore transaction for immediate continuation", async () => {
        const { controller, restoreCheckpoint } = createController()

        await checkpointRestore(
            controller as never,
            request({
                restoreType: "task",
                offset: 7,
                editedText: "continue from the edited request",
            }),
        )

        expect(restoreCheckpoint).toHaveBeenCalledWith(42, "task", 7, "continue from the edited request")
    })
})
