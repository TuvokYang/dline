import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { Empty } from "@shared/proto/dline/common"
import pWaitFor from "p-wait-for"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { ClineCheckpointRestore } from "../../../shared/WebviewMessage"
import { Controller } from ".."

export async function checkpointRestore(controller: Controller, request: CheckpointRestoreRequest): Promise<Empty> {
    if (request.number) {
        // wait for messages to be loaded
        await pWaitFor(() => controller.task !== undefined, {
            timeout: 3_000,
        }).catch((error) => {
            Logger.log("Failed to init new Dline instance to restore checkpoint", error)
            HostProvider.window.showMessage({
                type: ShowMessageType.ERROR,
                message: "Failed to restore checkpoint",
            })
            throw error
        })

        // Restoring rewrites the workspace and the conversation, which only the
        // window owning the task may do.
        if (controller.task && !controller.task.writable) {
            HostProvider.window.showMessage({
                type: ShowMessageType.WARNING,
                message: "This task is open in another window. Take it over before restoring a checkpoint.",
            })
            return Empty.create({})
        }
        // The checkpoint owner owns validation, stop/fence and reopen as one transaction.
        // Pre-cancelling here used the ordinary cancel path, which rearmed executors and
        // offered a cancelled-resume dialog before the restore had even been validated.
        const task = controller.task
        await task?.owners.checkpoints?.restoreCheckpoint(
            request.number,
            request.restoreType as ClineCheckpointRestore,
            request.offset,
            request.editedText || undefined,
        )
        if (task) await controller.completeTaskCheckpointRestore(task.taskId)
    }
    return Empty.create({})
}
