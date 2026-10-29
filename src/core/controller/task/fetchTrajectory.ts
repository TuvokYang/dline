import { TrajectorySource, taskTrajectoryMaintainers } from "@core/trajectory/TrajectorySource"
import type { TrajectoryRequest, TrajectoryUpdate } from "@shared/proto/dline/task"
import { trajectoryFrameToProto, UNAVAILABLE_TRAJECTORY_FRAME } from "@shared/proto-conversions/trajectory"
import type { Controller } from ".."
import { currentOpening } from "./opened-task"

/** One full trajectory snapshot of the visible task opening, caught up to its committed messages first. */
export async function fetchTrajectory(controller: Controller, request: TrajectoryRequest): Promise<TrajectoryUpdate> {
    const owner = currentOpening(controller, request)
    if (!owner) {
        return trajectoryFrameToProto(UNAVAILABLE_TRAJECTORY_FRAME, {
            taskId: request.taskId,
            taskInstanceId: request.taskInstanceId,
        })
    }
    const access = controller.trajectoryAccess(owner)
    await access.refresh()
    const frame = await new TrajectorySource(access, await taskTrajectoryMaintainers(owner.taskId)).snapshot()
    // A snapshot read across a reopen belongs to the opening that is gone.
    return trajectoryFrameToProto(controller.currentOpening() === owner ? frame : UNAVAILABLE_TRAJECTORY_FRAME, owner)
}
