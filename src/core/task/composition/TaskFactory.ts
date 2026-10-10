import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { type OpenActiveTaskSessionOptions, openActiveTaskSession } from "../session/TaskSessionFactory"

export type TaskInstance = ActiveTaskSession

export function createTask(options: OpenActiveTaskSessionOptions): Promise<TaskInstance> {
    return openActiveTaskSession(options)
}
