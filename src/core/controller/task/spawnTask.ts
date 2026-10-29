import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import { SpawnTaskRequest, SpawnTaskResponse } from "@shared/proto/dline/task"
import { Controller } from ".."

/**
 * Spawns a new sub-task from the parent task's context.
 * This RPC is called from the webview after the user has approved
 * a spawn_task tool request. It registers the child controller and
 * records the spawn relationship via OrchestratorController.
 *
 * The caller (webview) is responsible for creating the panel
 * and initializing the task before calling this RPC.
 *
 * @param controller The current controller (may be parent or child)
 * @param request The spawn task request with task description and IDs
 * @returns SpawnTaskResponse with the child taskId
 */
export async function spawnTask(controller: Controller, request: SpawnTaskRequest): Promise<SpawnTaskResponse> {
    const orchestrator = OrchestratorController.getInstance()

    // Register the spawn relationship. The panel and task initialization
    // are handled by the caller (SpawnTaskHandler or webview).
    orchestrator.spawnTask(request.task, controller, request.parentTaskId)

    return SpawnTaskResponse.create({ taskId: request.task })
}
