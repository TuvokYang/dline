import type { CanonicalTaskViewProjection } from "@core/task/view/canonical/CanonicalTaskViewProjection"
import type { TaskViewAction, TaskViewState } from "@shared/ExtensionMessage"

/** Decorate committed Away facts without introducing another mode owner. */
export function awayTaskView(view: CanonicalTaskViewProjection): { away: TaskViewState["away"]; actions: TaskViewAction[] } {
    return {
        away: view.away,
        actions: view.taskActions
            .filter((action) => action.actionId === "stop_away")
            .map((action) => ({
                type: "stop_away",
                label: "Stop Away Mode",
                appearance: "secondary",
                enabled: action.enabled,
                payloadPolicy: "none",
                dispatchTarget: "task",
            })),
    }
}
