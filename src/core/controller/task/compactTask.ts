import { requestTaskCompaction } from "@core/task/compaction/TaskCompactionRequest"
import { type CompactTaskRequest, CompactTaskResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."

/** Handle one task-local context compaction request without consuming an interaction response. */
export async function compactTask(controller: Controller, request: CompactTaskRequest): Promise<CompactTaskResponse> {
    // Header controls remain available on the lightweight history display. A
    // state-changing compaction first promotes that display into the writable
    // runtime, exactly as its Retry and retained-activity controls do.
    let promoted = false
    if (controller.task?.taskId !== request.taskId) {
        promoted = await controller.promoteHistoryDisplayForActivityControl(request.taskId)
        if (!promoted) return CompactTaskResponse.create({ accepted: false, result: "missing_task" })
    }
    const session = controller.task
    if (!session || session.taskId !== request.taskId) {
        return CompactTaskResponse.create({ accepted: false, result: "missing_task" })
    }
    if (!session.writable) return CompactTaskResponse.create({ accepted: false, result: "task_read_only" })

    // The header control is the user asking, so the run is recorded as manual.
    const result = await requestTaskCompaction(session, {
        // Promotion hydrates a fresh active runtime from the same durable snapshot
        // and may advance its revision before this RPC resumes. The history
        // display's revision is therefore stale by construction only on this path;
        // an already-active task must still match the revision the UI rendered.
        stateRevision: promoted ? session.state().revision : request.stateRevision,
        mode: request.forceTruncate ? "force_truncate" : "summarize",
        trigger: "manual",
    })
    return CompactTaskResponse.create({ accepted: result.accepted, result: result.result })
}
