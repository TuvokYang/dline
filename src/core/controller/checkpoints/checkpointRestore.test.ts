import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host"
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

    afterEach(() => {
        vi.restoreAllMocks()
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

    it("promotes an unlocked history display session before restoring a checkpoint", async () => {
        const restoreCheckpoint = vi.fn().mockResolvedValue({})
        const completeTaskCheckpointRestore = vi.fn(async () => undefined)
        const promotedTask = createSessionFixture({
            taskId: "task-1",
            taskInstanceId: "open-1",
            owners: { checkpoints: { restoreCheckpoint } },
        })
        const historyDisplaySession = {
            taskId: "task-1",
            taskInstanceId: "open-1",
            isLocked: () => false,
        }
        let currentHistoryDisplay: typeof historyDisplaySession | undefined = historyDisplaySession
        const controller: {
            task: typeof promotedTask | undefined
            hasHistoryDisplaySession: () => boolean
            canPromoteHistoryDisplay: (taskId: string) => boolean
            currentOpening: () => { taskId: string; taskInstanceId: string } | undefined
            promoteHistoryDisplayForActivityControl: ReturnType<typeof vi.fn>
            completeTaskCheckpointRestore: typeof completeTaskCheckpointRestore
        } = {
            task: undefined,
            hasHistoryDisplaySession: () => currentHistoryDisplay !== undefined,
            canPromoteHistoryDisplay: (taskId) => currentHistoryDisplay?.taskId === taskId && !currentHistoryDisplay.isLocked(),
            currentOpening: () => controller.task ?? currentHistoryDisplay,
            promoteHistoryDisplayForActivityControl: vi.fn(async () => {
                currentHistoryDisplay = undefined
                controller.task = promotedTask
                return true
            }),
            completeTaskCheckpointRestore,
        }

        await checkpointRestore(controller as never, request({ restoreType: "task" }))

        expect(controller.promoteHistoryDisplayForActivityControl).toHaveBeenCalledWith("task-1", historyDisplaySession)
        expect(restoreCheckpoint).toHaveBeenCalledWith(42, "task", undefined, undefined)
        expect(completeTaskCheckpointRestore).toHaveBeenCalledWith("task-1")
    })

    it("warns immediately without timing out when restoring a locked history display session", async () => {
        const showMessage = vi.fn(async () => ({}))
        vi.spyOn(HostProvider, "window", "get").mockReturnValue({ showMessage } as never)
        const historyDisplaySession = {
            taskId: "task-1",
            taskInstanceId: "open-1",
            isLocked: () => true,
        }
        const promoteHistoryDisplayForActivityControl = vi.fn(async () => false)
        const completeTaskCheckpointRestore = vi.fn(async () => undefined)
        const controller = {
            task: undefined,
            hasHistoryDisplaySession: () => true,
            canPromoteHistoryDisplay: () => false,
            currentOpening: () => historyDisplaySession,
            promoteHistoryDisplayForActivityControl,
            completeTaskCheckpointRestore,
        }

        await checkpointRestore(controller as never, request({ restoreType: "task" }))

        expect(promoteHistoryDisplayForActivityControl).not.toHaveBeenCalled()
        expect(completeTaskCheckpointRestore).not.toHaveBeenCalled()
        expect(showMessage).toHaveBeenCalledWith({
            type: ShowMessageType.WARNING,
            message: "This task is open in another window. Take it over before restoring a checkpoint.",
        })
    })
})
