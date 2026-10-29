import { CheckpointRestoreRequest } from "@shared/proto/dline/checkpoints"
import { Empty } from "@shared/proto/dline/common"
import { Controller } from ".."
import { currentOpening } from "../task/opened-task"

export async function checkpointDiff(controller: Controller, request: CheckpointRestoreRequest): Promise<Empty> {
    if (request.number && request.checkpointRowTs === request.number && currentOpening(controller, request)) {
        await controller.task?.owners.checkpoints?.presentMultifileDiff?.(request.number, false)
    }
    return Empty.create()
}
