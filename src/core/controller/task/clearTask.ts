import { Empty, EmptyRequest } from "@shared/proto/dline/common"
import { Controller } from ".."

/**
 * Clears the current task
 * @param controller The controller instance
 * @param _request The empty request
 * @returns Empty response
 */
export async function clearTask(controller: Controller, _request: EmptyRequest): Promise<Empty> {
    // clearTask is called here when the user closes the task.
    // Closing only ends the session: a Task that already established a
    // completion verdict keeps it, so reopening it from history does not
    // present finished work as unfinished.
    //
    // The user is waiting only for the surface to return to the recent-tasks
    // view, which happens as soon as the Task is detached. Store flushes, lock
    // release and registry cleanup are deferred: they no longer change what is
    // rendered, and the controller still drains them before the next Task
    // starts or the window shuts down.
    await controller.clearTask({
        clearPanelState: true,
        preserveCompletedState: true,
        deferTeardown: true,
        closeReason: "user_clear",
    })
    return Empty.create()
}
