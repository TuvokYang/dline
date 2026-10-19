import type { TaskViewAction, TaskViewState } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/dline/common"
import { AskResponseRequest, MoveCommandToBackgroundRequest } from "@shared/proto/dline/task"
import { TaskServiceClient } from "@/services/grpc-client"

/**
 * Carry out a footer action that targets the task rather than its interaction.
 *
 * Every surface that offers such an action, the footer and the composer's
 * cancel button alike, dispatches it here so they cannot drift apart.
 */
export async function dispatchTaskAction(view: TaskViewState, action: TaskViewAction): Promise<void> {
    if (action.type === "retry") {
        await TaskServiceClient.askResponse(AskResponseRequest.create({ responseType: "retry" }))
        return
    }
    if (action.type === "continue_in_background") {
        if (!action.activityId) {
            throw new Error("The foreground activity is no longer available to continue in the background.")
        }
        const response = await TaskServiceClient.moveCommandToBackground(
            MoveCommandToBackgroundRequest.create({
                taskId: view.taskId,
                taskInstanceId: view.taskInstanceId ?? "",
                activityId: action.activityId,
            }),
        )
        if (!response.moved) {
            throw new Error("The foreground activity is no longer available to continue in the background.")
        }
        return
    }
    await TaskServiceClient.cancelTask(EmptyRequest.create({}))
}

/** The task's cancel action, when the backend currently offers it. */
export function enabledCancelAction(view: TaskViewState | undefined): TaskViewAction | undefined {
    return view?.footer.actions.find((action) => action.type === "cancel" && action.enabled && action.dispatchTarget === "task")
}

/**
 * Whether the composer's action button carries this footer action, so the
 * footer must not offer it a second time.
 *
 * - the reply the composer's Enter already sends;
 * - cancelling the task, which the button offers while the task runs.
 *
 * Resume stays in the footer as well: a send from the composer also resumes,
 * but a history task needs the full-width footer button to be noticed.
 */
export function composerCarriesAction(view: TaskViewState, action: TaskViewAction): boolean {
    switch (action.type) {
        case "reply":
            return view.input.enterAction === "reply"
        case "cancel":
            return action.dispatchTarget === "task"
        default:
            return false
    }
}

/**
 * Whether a send from the composer resumes the task instead of starting a new turn.
 *
 * A Resume the backend still holds disabled, such as while a history task is
 * being prepared, counts too: the composer then shows resume as unavailable
 * rather than an unrelated send.
 */
export function composerResumesTask(view: TaskViewState | undefined): boolean {
    if (!view) return false
    return view.input.enterAction === "resume" || view.footer.actions.some((action) => action.type === "resume")
}
