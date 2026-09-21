import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { type OpenActiveTaskSessionOptions, openActiveTaskSession } from "../session/TaskSessionFactory"

export type TaskInstance = ActiveTaskSession

export async function createTask(options: OpenActiveTaskSessionOptions): Promise<TaskInstance> {
	const result = await openActiveTaskSession(options)
	if (result.kind === "read_only") throw new Error(`TaskReadOnly:${result.reason}`)
	return result.session
}
