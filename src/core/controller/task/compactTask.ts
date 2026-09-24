import { requestTaskCompaction } from "@core/task/compaction/TaskCompactionRequest"
import { type CompactTaskRequest, CompactTaskResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."

/** Handle one task-local context compaction request without consuming an interaction response. */
export async function compactTask(controller: Controller, request: CompactTaskRequest): Promise<CompactTaskResponse> {
	const session = controller.task
	if (!session || session.taskId !== request.taskId) {
		return CompactTaskResponse.create({ accepted: false, result: "missing_task" })
	}

	// The header control is the user asking, so the summary is theirs to review.
	const result = await requestTaskCompaction(session, {
		stateRevision: request.stateRevision,
		mode: request.forceTruncate ? "force_truncate" : "summarize",
		trigger: "manual",
	})
	return CompactTaskResponse.create({ accepted: result.accepted, result: result.result })
}
