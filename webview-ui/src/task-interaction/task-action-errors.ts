import type { TaskViewAction } from "@shared/ExtensionMessage"

export type TaskActionFailureReason = "read_only" | "stop_away_failed" | "foreground_unavailable" | "unsupported"

/** Stable local failure meaning; the original Error message remains available to diagnostics. */
export class TaskActionError extends Error {
    constructor(
        readonly reason: TaskActionFailureReason,
        message: string,
        readonly actionType?: TaskViewAction["type"],
    ) {
        super(message)
        this.name = "TaskActionError"
    }
}
