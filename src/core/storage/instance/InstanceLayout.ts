import path from "node:path"

/**
 * Durable layout of one task or subagent instance.
 *
 * A task lives at `<documents-root>/tasks/<task-id>/`. Every subagent of that task,
 * including one spawned by another subagent, lives directly at
 * `<task-root>/subagents/<subagent-id>/` with the same layout; the spawning side
 * records the relationship. Task locks, checkpoints and TaskHistory belong to the
 * task only and are not part of this layout.
 *
 * This module is the single source of these paths. Callers must not rebuild them.
 */

/** Directory that holds every task instance below the documents root. */
const TASKS_DIRECTORY_NAME = "tasks"

/** Directory that holds every subagent instance of one task. */
const SUBAGENTS_DIRECTORY_NAME = "subagents"

/** Durable kernel snapshot; its previous version is kept as `state.json.bak`. */
const STATE_FILE_NAME = "state.json"

/** File-based journal, publications and payloads, until they move into `journal.db`. */
const RUNTIME_DIRECTORY_NAME = "runtime"

/** SQLite databases of one instance. Each database has exactly one writing module. */
export const InstanceDatabase = {
	/** Kernel commits: journal entries, command publications and payloads. */
	Journal: "journal.db",
	/** Chat projection written by the UI message store. */
	Messages: "messages.db",
	/** Activity events appended by TaskActivityStore. */
	Activities: "activities.db",
	/** API usage metrics written by the task performance services. */
	Metrics: "metrics.db",
} as const

export type InstanceDatabase = (typeof InstanceDatabase)[keyof typeof InstanceDatabase]

/** Identifies one instance. A subagent is always addressed through the task that owns it. */
export interface InstanceLocation {
	readonly taskId: string
	readonly subagentId?: string
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Rejects identities that are empty or could leave the instance directory, such as `..` or path separators. */
export function assertInstanceIdentity(kind: "task" | "subagent", identity: string): void {
	if (!IDENTITY_PATTERN.test(identity)) {
		throw new Error(`Invalid ${kind} identity for instance storage: ${JSON.stringify(identity)}`)
	}
}

/** Absolute root of the task that owns every instance of `taskId`. */
export function taskInstanceRoot(documentsRoot: string, taskId: string): string {
	assertInstanceIdentity("task", taskId)
	return path.join(documentsRoot, TASKS_DIRECTORY_NAME, taskId)
}

/** Absolute root of one task or subagent instance. */
export function instanceRoot(documentsRoot: string, location: InstanceLocation): string {
	const taskRoot = taskInstanceRoot(documentsRoot, location.taskId)
	if (location.subagentId === undefined) return taskRoot
	assertInstanceIdentity("subagent", location.subagentId)
	return path.join(taskRoot, SUBAGENTS_DIRECTORY_NAME, location.subagentId)
}

/** Paths inside one instance root. */
export class InstanceLayout {
	constructor(readonly root: string) {}

	get stateFile(): string {
		return path.join(this.root, STATE_FILE_NAME)
	}

	/** Transitional: removed once the journal, publications and payloads live in `journal.db`. */
	get runtimeDirectory(): string {
		return path.join(this.root, RUNTIME_DIRECTORY_NAME)
	}

	database(kind: InstanceDatabase): string {
		return path.join(this.root, kind)
	}
}
