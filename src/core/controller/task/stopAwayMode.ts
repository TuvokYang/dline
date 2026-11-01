import { type StopAwayModeRequest, StopAwayModeResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { currentOpening } from "./opened-task"

/** Exit only the current opening's mode, through its existing Runtime writer. */
export async function stopAwayMode(controller: Controller, request: StopAwayModeRequest): Promise<StopAwayModeResponse> {
    const opening = currentOpening(controller, request)
    if (!opening) return StopAwayModeResponse.create({ accepted: false, result: "stale_task" })
    if (!controller.task && !(await controller.promoteHistoryDisplayForActivityControl(request.taskId, opening))) {
        return StopAwayModeResponse.create({ accepted: false, result: "not_available" })
    }
    const session = controller.task
    if (!session || currentOpening(controller, request) !== session) {
        return StopAwayModeResponse.create({ accepted: false, result: "stale_task" })
    }
    if (!session.writable) return StopAwayModeResponse.create({ accepted: false, result: "task_read_only" })
    const result = await session.assembly.runtime.submit({ type: "away.stopped", generation: session.state().generation })
    if (result.kind === "rejected") return StopAwayModeResponse.create({ accepted: false, result: result.reason })
    await result.receipt.durable
    return StopAwayModeResponse.create({ accepted: true, result: "accepted" })
}
