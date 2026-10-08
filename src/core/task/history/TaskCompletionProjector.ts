import type { TaskState } from "../kernel"

export interface TaskCompletionProjection {
	isCompleted: boolean
	revision: number
}

export interface TaskCompletionProjectionUpdate extends TaskCompletionProjection {
	taskId: string
}

export interface TaskCompletionProjectorOptions {
	taskId: string
	initial?: TaskCompletionProjection
	persist(update: TaskCompletionProjectionUpdate): Promise<boolean>
}

type CompletionRuntimeState = Pick<TaskState, "flow" | "dialog" | "revision">

/**
 * Phases that carry no settled completion verdict.
 *
 * Only phases that describe what the Task is actually doing can decide whether
 * it is completed. Startup and shutdown phases describe the session, not the
 * work, so they must leave the last real verdict untouched.
 *
 * Startup: reopening a finished Task walks through these phases before its
 * canonical state is hydrated. Treating them as "not completed" made every
 * reopen persist `isCompleted: false`, which is why history checkmarks
 * disappeared after a few refreshes.
 *
 * Shutdown: the halt barrier eventually moves a task to `terminated`. Treating
 * that session state as "not completed" would retract an already durable
 * completion verdict, so termination leaves the last settled verdict intact.
 */
const INDETERMINATE_PHASES: ReadonlySet<TaskState["flow"]["phase"]> = new Set(["idle", "initializing", "terminated"])

/**
 * The completion verdict a canonical state carries, or `undefined` when it carries none.
 *
 * The kernel keeps a presented completion as the completion dialog offered to
 * the user, while the flow stays running or waiting; the verdict holds while
 * that dialog is awaiting or being answered. A flow closed as `completed`
 * without a completion identity is the session shutting down, not a verdict,
 * so it leaves the last settled verdict in place.
 */
function completionVerdict(state: CompletionRuntimeState): boolean | undefined {
	if (INDETERMINATE_PHASES.has(state.flow.phase)) return undefined
	const primary = state.dialog.primary
	if (primary?.kind === "completion" && (primary.status === "awaiting" || primary.status === "resolving")) return true
	if (state.flow.phase === "completed") return state.flow.completionId !== undefined ? true : undefined
	return false
}

/** Project canonical Task completion state into the durable task-history index. */
export class TaskCompletionProjector {
	private isCompleted: boolean
	/**
	 * Highest durable revision this projector knows about.
	 *
	 * Runtime revisions restart per Task session, so a durable revision from an
	 * earlier session can exceed every revision the current session produces.
	 * Persisted revisions are therefore lifted above this watermark to stay
	 * monotonic for the durable store.
	 */
	private persistedRevision: number
	/** Highest runtime revision observed in the current session; guards out-of-order syncs. */
	private runtimeRevision = -1

	constructor(private readonly options: TaskCompletionProjectorOptions) {
		this.isCompleted = options.initial?.isCompleted ?? false
		this.persistedRevision = options.initial?.revision ?? -1
	}

	/** Persist one completion-state flip after its canonical Task snapshot is durable. */
	async sync(state: CompletionRuntimeState): Promise<boolean> {
		const isCompleted = completionVerdict(state)
		if (isCompleted === undefined) {
			return false
		}
		if (state.revision <= this.runtimeRevision) {
			return false
		}

		if (isCompleted === this.isCompleted) {
			this.runtimeRevision = state.revision
			return false
		}

		const revision = Math.max(state.revision, this.persistedRevision + 1)
		const persisted = await this.options.persist({
			taskId: this.options.taskId,
			isCompleted,
			revision,
		})
		if (!persisted) {
			return false
		}

		this.isCompleted = isCompleted
		this.runtimeRevision = state.revision
		this.persistedRevision = revision
		return true
	}
}
