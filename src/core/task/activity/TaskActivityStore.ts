import type {
	SubagentRetryRecipe,
	TaskActivityCancellationOwner,
	TaskActivityEvent,
	TaskActivityEventInput,
	TaskActivityExecutionMode,
	TaskActivityKind,
	TaskActivityMetrics,
	TaskActivityRecord,
	TaskActivityRuntimeConfig,
	TaskActivityStatus,
	TaskActivityUpdate,
} from "@shared/task-activity"
import { Logger } from "@/shared/services/Logger"

const FLUSH_DELAY_MS = 75
const MAX_OUTPUT_CHARS = 64 * 1024
const MAX_EVENT_TEXT_CHARS = 16 * 1024
const MAX_EVENTS_PER_ACTIVITY = 500
/**
 * Ceiling for the single-shot descriptive fields.
 *
 * `output` and events were already bounded, but `detail`, `result` and `error`
 * were not. One call may fan out to 32 subagents, each persisting its own
 * prompt and final answer, so an unbounded field is multiplied by the batch
 * width every time the activity file is written. The limit is generous enough
 * to keep a normal prompt or summary intact and only truncates the outliers
 * that would otherwise grow task storage without limit.
 */
const MAX_TEXT_FIELD_CHARS = 16 * 1024
const TRUNCATION_NOTICE = "\n… [truncated]"
const AUTHORIZATION_VALUE_PATTERN = /(\bauthorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?([^\s,;]+)/gi
const BEARER_TOKEN_PATTERN = /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi
const SENSITIVE_VALUE_PATTERN = /(api[_-]?key|access[_-]?token|password|secret)(\s*[:=]\s*)([^\s,;]+)/gi
const KNOWN_SECRET_TOKEN_PATTERN =
	/\b(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g

function redactSensitiveText(text: string): string {
	return text
		.replace(AUTHORIZATION_VALUE_PATTERN, "$1[REDACTED]")
		.replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
		.replace(SENSITIVE_VALUE_PATTERN, "$1$2[REDACTED]")
		.replace(KNOWN_SECRET_TOKEN_PATTERN, "[REDACTED]")
}

/**
 * Redact and bound one descriptive field.
 *
 * The head is kept rather than the tail: a prompt, a summary or an error is
 * most informative at the start, unlike the streaming `output` log where the
 * newest lines matter. The marker makes the truncation visible so a reader is
 * not left believing a clipped value is complete.
 *
 * @param text Raw field text.
 * @returns Redacted text within the field ceiling.
 */
function boundFieldText(text: string): string {
	const safeText = redactSensitiveText(text)
	if (safeText.length <= MAX_TEXT_FIELD_CHARS) return safeText
	return `${safeText.slice(0, MAX_TEXT_FIELD_CHARS)}${TRUNCATION_NOTICE}`
}

/**
 * Apply the same field ceiling to a retry recipe.
 *
 * A recipe carries the task and prompt verbatim so a failed run can be
 * replayed, and every item of a large batch persists its own copy. Left raw it
 * would be the one payload that escapes both the ceiling and redaction, so the
 * stored text is bounded on the way in.
 *
 * @param recipe Recipe as supplied by the caller.
 * @returns Recipe whose free text is redacted and bounded.
 */
function boundRetryRecipe(recipe: SubagentRetryRecipe): SubagentRetryRecipe {
	return {
		...recipe,
		task: boundFieldText(recipe.task),
		prompt: boundFieldText(recipe.prompt),
	}
}

type ActivityListener = (update: TaskActivityUpdate) => void | Promise<void>
type CancelActivity = () => void | Promise<void>
type ControlActivity = () => boolean | Promise<boolean>
export type BackgroundHandoffResult =
	| boolean
	| {
			accepted: boolean
			rollback?: () => void | Promise<void>
			commit?: () => void | Promise<void>
	  }
type MoveActivity = () => Promise<BackgroundHandoffResult>

export interface TaskActivityPersistencePort {
	load(): Promise<TaskActivityRecord[]>
	save(activities: TaskActivityRecord[]): Promise<void>
}

export interface CreateTaskActivityInput {
	activityId: string
	kind: TaskActivityKind
	executionMode: TaskActivityExecutionMode
	cancellationOwner?: TaskActivityCancellationOwner
	title: string
	continueInBackground?: MoveActivity
	/** Activity identities that must transfer ownership with this activity. */
	backgroundGroupIds?: string[]
	detail?: string
	timeoutSeconds?: number
	parentActivityId?: string
	status?: TaskActivityStatus
	retryRecipe?: SubagentRetryRecipe
	cancel?: CancelActivity
	finish?: ControlActivity
	retry?: ControlActivity
}

/** Task-local activity state with bounded output and batched incremental notifications. */
export class TaskActivityStore {
	private readonly activities = new Map<string, TaskActivityRecord>()
	private readonly cancellers = new Map<string, CancelActivity>()
	private readonly finishers = new Map<string, ControlActivity>()
	private readonly retriers = new Map<string, ControlActivity>()
	private readonly backgroundMovers = new Map<string, MoveActivity>()
	private readonly backgroundGroups = new Map<string, readonly string[]>()
	private readonly listeners = new Map<ActivityListener, Promise<void>>()
	private readonly dirtyIds = new Set<string>()
	private readonly persistedRecoveryCandidateIds = new Set<string>()
	private persistenceDeferralDepth = 0
	private flushTimer?: NodeJS.Timeout
	private sequence = 0
	private persistenceSequence = Promise.resolve()
	private hydratePromise?: Promise<void>

	constructor(
		readonly taskId: string,
		private readonly persistence?: TaskActivityPersistencePort,
	) {}

	async hydrate(): Promise<void> {
		if (!this.persistence) return
		this.hydratePromise ??= this.loadPersistedActivities()
		await this.hydratePromise
	}

	/** Finalize persisted in-flight work after the caller has acquired the task lock. */
	async recoverInterruptedActivities(): Promise<string[]> {
		await this.hydrate()
		const interruptedActivityIds: string[] = []
		this.persistenceDeferralDepth += 1
		try {
			for (const activityId of this.persistedRecoveryCandidateIds) {
				const activity = this.activities.get(activityId)
				if (!activity || !this.isTransient(activity.status) || this.cancellers.has(activity.activityId)) continue
				interruptedActivityIds.push(activity.activityId)
				this.update(activity.activityId, {
					status: "interrupted",
					latestEvent: "Interrupted before completion",
				})
			}
		} finally {
			this.persistedRecoveryCandidateIds.clear()
			this.persistenceDeferralDepth -= 1
		}
		await this.waitForPersistence()
		return interruptedActivityIds
	}

	private async loadPersistedActivities(): Promise<void> {
		if (!this.persistence) return
		for (const activity of await this.persistence.load()) {
			this.persistedRecoveryCandidateIds.add(activity.activityId)
			if (!this.activities.has(activity.activityId)) {
				this.activities.set(activity.activityId, this.clone(activity))
			}
			for (const event of activity.events) this.sequence = Math.max(this.sequence, event.sequence)
		}
	}

	create(input: CreateTaskActivityInput): TaskActivityRecord {
		if (this.activities.has(input.activityId)) {
			throw new Error(`Task activity already exists: ${input.activityId}`)
		}
		const now = Date.now()
		const activity: TaskActivityRecord = {
			schemaVersion: 2,
			activityId: input.activityId,
			taskId: this.taskId,
			kind: input.kind,
			executionMode: input.executionMode,
			cancellationOwner: input.cancellationOwner ?? "task",
			status: input.status ?? "running",
			currentAttempt: 1,
			createdAt: now,
			updatedAt: now,
			title: boundFieldText(input.title),
			detail: input.detail === undefined ? undefined : boundFieldText(input.detail),
			timeoutSeconds: input.timeoutSeconds,
			parentActivityId: input.parentActivityId,
			retryRecipe: input.kind === "subagent" && input.retryRecipe ? boundRetryRecipe(input.retryRecipe) : undefined,
			events: [],
		}
		this.activities.set(activity.activityId, activity)
		if (input.cancel) this.cancellers.set(activity.activityId, input.cancel)
		if (input.finish) this.finishers.set(activity.activityId, input.finish)
		if (input.retry) this.retriers.set(activity.activityId, input.retry)
		if (input.continueInBackground) {
			this.backgroundMovers.set(activity.activityId, input.continueInBackground)
			this.backgroundGroups.set(activity.activityId, input.backgroundGroupIds ?? [activity.activityId])
		}
		this.appendEvent(input.activityId, { kind: "status", status: activity.status, text: "Activity started" }, true)
		return this.clone(activity)
	}

	setCancel(activityId: string, cancel: CancelActivity): void {
		if (!this.activities.has(activityId)) return
		this.cancellers.set(activityId, cancel)
		this.markDirty(activityId, true)
	}

	setFinish(activityId: string, finish: ControlActivity): void {
		if (!this.activities.has(activityId)) return
		this.finishers.set(activityId, finish)
		this.markDirty(activityId, true)
	}

	setRetry(activityId: string, retry: ControlActivity | undefined): void {
		const activity = this.activities.get(activityId)
		if (!activity) return
		const hadRetry = this.retriers.has(activityId)
		if (retry) this.retriers.set(activityId, retry)
		else this.retriers.delete(activityId)
		if (activity.kind === "subagent" && activity.retryRecipe) {
			activity.retryRecipe = { ...activity.retryRecipe, retryable: Boolean(retry) }
			if (retry) activity.retryUnavailableReason = undefined
			activity.updatedAt = Date.now()
		}
		if (hadRetry !== Boolean(retry) || activity.retryRecipe) this.markDirty(activityId, true)
	}

	setRetryUnavailableReason(activityId: string, reason: string): void {
		const activity = this.activities.get(activityId)
		if (!activity || activity.kind !== "subagent") return
		this.retriers.delete(activityId)
		if (activity.retryRecipe) activity.retryRecipe = { ...activity.retryRecipe, retryable: false }
		activity.retryUnavailableReason = redactSensitiveText(reason)
		activity.updatedAt = Date.now()
		this.markDirty(activityId, true)
	}

	isCancellable(activityId: string): boolean {
		const activity = this.activities.get(activityId)
		return activity?.status === "running" && this.cancellers.has(activityId)
	}

	isFinishable(activityId: string): boolean {
		const activity = this.activities.get(activityId)
		return activity?.kind === "subagent" && activity.status === "running" && this.finishers.has(activityId)
	}

	hasLiveRetryControl(activityId: string): boolean {
		return this.retriers.has(activityId)
	}

	isRetryable(activityId: string): boolean {
		const activity = this.activities.get(activityId)
		// A user cancellation is recoverable just like a provider failure: the run
		// stopped without producing a result, so restarting it is well defined.
		const isRecoverableStatus = activity?.status === "failed" || activity?.status === "cancelled"
		return (
			activity?.kind === "subagent" &&
			isRecoverableStatus &&
			(this.hasLiveRetryControl(activityId) || activity.retryRecipe?.retryable === true)
		)
	}

	/** Return the newest running foreground activity of the requested kind with a live handoff callback. */
	getReadyBackgroundHandoffActivityId(kind: TaskActivityKind): string | undefined {
		return this.list().find(
			(activity) =>
				activity.kind === kind &&
				activity.status === "running" &&
				activity.executionMode === "foreground" &&
				this.backgroundMovers.has(activity.activityId),
		)?.activityId
	}

	/** Move eligible foreground activities into explicit background ownership. */
	async moveToBackground(activityIds: string[]): Promise<string[]> {
		const moved: string[] = []
		const visited = new Set<string>()
		for (const requestedId of activityIds) {
			if (visited.has(requestedId)) continue
			const groupIds = [...new Set(this.backgroundGroups.get(requestedId) ?? [requestedId])]
			groupIds.forEach((activityId) => {
				visited.add(activityId)
			})
			const move = this.backgroundMovers.get(requestedId)
			const isEligibleGroup = () =>
				Boolean(move) &&
				groupIds.every((activityId) => {
					const activity = this.activities.get(activityId)
					return (
						activity?.status === "running" &&
						activity.executionMode === "foreground" &&
						this.backgroundMovers.get(activityId) === move
					)
				})
			if (!move || !isEligibleGroup()) continue
			let result: BackgroundHandoffResult | undefined
			let ownershipSnapshots: Array<{
				activityId: string
				executionMode: TaskActivityExecutionMode
				cancellationOwner: TaskActivityCancellationOwner
				latestEvent?: string
			}> = []
			try {
				result = await move()
				const accepted = typeof result === "boolean" ? result : result.accepted
				if (!accepted) continue
				if (!isEligibleGroup()) {
					if (typeof result !== "boolean") await result.rollback?.()
					continue
				}
				ownershipSnapshots = groupIds.map((activityId) => {
					const activity = this.activities.get(activityId) as TaskActivityRecord
					return {
						activityId,
						executionMode: activity.executionMode,
						cancellationOwner: activity.cancellationOwner,
						latestEvent: activity.latestEvent,
					}
				})
				for (const activityId of groupIds) {
					this.update(activityId, {
						executionMode: "background",
						cancellationOwner: "explicit",
						latestEvent: "Continuing in background",
					})
				}
				for (const activityId of groupIds) {
					this.backgroundMovers.delete(activityId)
					this.backgroundGroups.delete(activityId)
				}
				if (typeof result !== "boolean") await result.commit?.()
				moved.push(...groupIds)
			} catch (error) {
				for (const snapshot of ownershipSnapshots) {
					const activity = this.activities.get(snapshot.activityId)
					if (!activity) continue
					activity.executionMode = snapshot.executionMode
					activity.cancellationOwner = snapshot.cancellationOwner
					activity.latestEvent = snapshot.latestEvent
					this.markDirty(snapshot.activityId, true)
				}
				if (result && typeof result !== "boolean") await result.rollback?.()
				Logger.warn("[TaskActivityStore] Failed to move activity group to background", error)
			}
		}
		return moved
	}

	update(
		activityId: string,
		patch: Partial<
			Pick<
				TaskActivityRecord,
				| "status"
				| "executionMode"
				| "cancellationOwner"
				| "title"
				| "detail"
				| "latestEvent"
				| "result"
				| "error"
				| "finishedAt"
				| "retryRecipe"
				| "retryUnavailableReason"
			>
		> & { metrics?: Partial<TaskActivityMetrics>; runtime?: TaskActivityRuntimeConfig },
	): void {
		this.applyUpdate(activityId, patch, false)
	}

	/**
	 * Apply one activity patch.
	 *
	 * A terminal `cancelled` or `interrupted` activity normally rejects status
	 * changes so a late in-flight callback cannot resurrect it. An explicit user
	 * retry is the one authorized transition out of that state, so it opts in
	 * through `allowTerminalTransition` instead of weakening the guard for
	 * everyone.
	 *
	 * @param activityId Activity to patch.
	 * @param patch Fields to apply.
	 * @param allowTerminalTransition Whether a terminal status may change.
	 */
	private applyUpdate(
		activityId: string,
		patch: Parameters<TaskActivityStore["update"]>[1],
		allowTerminalTransition: boolean,
	): void {
		const activity = this.activities.get(activityId)
		if (!activity) return
		if (
			!allowTerminalTransition &&
			(activity.status === "cancelled" || activity.status === "interrupted") &&
			patch.status &&
			patch.status !== activity.status
		) {
			return
		}
		const previousStatus = activity.status
		const { metrics, runtime, ...activityPatch } = patch
		const sanitizedPatch = {
			...activityPatch,
			...(activityPatch.title === undefined ? {} : { title: boundFieldText(activityPatch.title) }),
			...(activityPatch.detail === undefined ? {} : { detail: boundFieldText(activityPatch.detail) }),
			...(activityPatch.latestEvent === undefined ? {} : { latestEvent: boundFieldText(activityPatch.latestEvent) }),
			...(activityPatch.result === undefined ? {} : { result: boundFieldText(activityPatch.result) }),
			...(activityPatch.error === undefined ? {} : { error: boundFieldText(activityPatch.error) }),
			...(activityPatch.retryUnavailableReason === undefined
				? {}
				: { retryUnavailableReason: boundFieldText(activityPatch.retryUnavailableReason) }),
			// A patched recipe carries the same free text as a created one and
			// must not be the path that reintroduces an unbounded prompt.
			...(activityPatch.retryRecipe === undefined ? {} : { retryRecipe: boundRetryRecipe(activityPatch.retryRecipe) }),
		}
		Object.assign(activity, sanitizedPatch, { updatedAt: Date.now() })
		if (runtime && activity.kind === "subagent") {
			activity.runtime = { ...activity.runtime, ...runtime }
		}
		if (metrics && activity.kind === "subagent") {
			activity.metrics = { ...activity.metrics, ...metrics }
			this.appendEvent(activityId, { kind: "metrics", metrics: { ...activity.metrics } }, false)
		}
		if (previousStatus !== activity.status) {
			this.appendEvent(activityId, { kind: "status", status: activity.status, text: activity.latestEvent }, false)
		}
		if (this.isTerminal(activity.status) && !activity.finishedAt) activity.finishedAt = activity.updatedAt
		if (this.isTerminal(activity.status)) {
			this.cancellers.delete(activityId)
			this.finishers.delete(activityId)
			this.backgroundMovers.delete(activityId)
			// A failed or cancelled run produced no result, so its retry control
			// must survive the terminal transition and stay available to the user.
			if (activity.status !== "failed" && activity.status !== "cancelled") this.retriers.delete(activityId)
		}
		const priority = previousStatus !== activity.status || this.isTerminal(activity.status)
		this.markDirty(activityId, priority)
	}

	appendOutput(activityId: string, text: string): void {
		if (!text) return
		const activity = this.activities.get(activityId)
		if (!activity) return
		const safeText = redactSensitiveText(text)
		const combined = `${activity.output ?? ""}${safeText}`
		activity.output = combined.length > MAX_OUTPUT_CHARS ? combined.slice(-MAX_OUTPUT_CHARS) : combined
		activity.updatedAt = Date.now()
		if (activity.kind === "command") {
			this.markDirty(activityId, false)
		} else {
			this.appendEvent(activityId, { kind: "output", text: safeText }, false)
		}
	}

	appendEvent(activityId: string, input: TaskActivityEventInput, priority = false): TaskActivityEvent | undefined {
		const activity = this.activities.get(activityId)
		if (!activity) return undefined
		const event = this.createEvent(input, activity.currentAttempt)
		activity.events.push(event)
		this.trimEvents(activity)
		activity.updatedAt = event.timestamp
		this.markDirty(activityId, priority)
		return event
	}

	get(activityId: string): TaskActivityRecord | undefined {
		const activity = this.activities.get(activityId)
		return activity ? this.clone(activity) : undefined
	}

	list(): TaskActivityRecord[] {
		return Array.from(this.activities.values())
			.map((activity) => this.clone(activity))
			.sort((a, b) => b.createdAt - a.createdAt || a.activityId.localeCompare(b.activityId))
	}

	listRunning(cancellationOwner?: TaskActivityCancellationOwner): TaskActivityRecord[] {
		return this.list().filter(
			(activity) =>
				activity.status === "running" && (!cancellationOwner || activity.cancellationOwner === cancellationOwner),
		)
	}

	subscribe(listener: ActivityListener): () => void {
		this.listeners.set(listener, Promise.resolve())
		void this.hydrate().then(() => {
			if (this.listeners.has(listener)) {
				this.enqueue(listener, { sequence: ++this.sequence, snapshot: true, activities: this.list() })
			}
		})
		return () => this.listeners.delete(listener)
	}

	async finish(activityIds: string[]): Promise<string[]> {
		const finished: string[] = []
		for (const activityId of activityIds) {
			const activity = this.activities.get(activityId)
			const finish = this.finishers.get(activityId)
			if (!activity || !finish || activity.kind !== "subagent" || activity.status !== "running") continue
			this.finishers.delete(activityId)
			try {
				if (!(await finish())) {
					if (activity.status === "running") this.finishers.set(activityId, finish)
					continue
				}
				this.update(activityId, { latestEvent: "Finish requested" })
				finished.push(activityId)
			} catch (error) {
				if (activity.status === "running") this.finishers.set(activityId, finish)
				Logger.warn("[TaskActivityStore] Failed to finish activity", error)
			}
		}
		return finished
	}

	async retry(activityIds: string[]): Promise<string[]> {
		const retried: string[] = []
		for (const activityId of activityIds) {
			const activity = this.activities.get(activityId)
			const retry = this.retriers.get(activityId)
			// Restarting a cancelled run is as well defined as restarting a failed one.
			const previousStatus = activity?.status
			const isRecoverableStatus = previousStatus === "failed" || previousStatus === "cancelled"
			if (!activity || !retry || activity.kind !== "subagent" || !isRecoverableStatus) continue
			const previousError = activity.error
			activity.currentAttempt += 1
			activity.result = undefined
			activity.error = undefined
			activity.finishedAt = undefined
			this.applyUpdate(activityId, { status: "running", latestEvent: "Retry requested" }, true)
			try {
				if (!(await retry())) {
					// Restore the original terminal state so the row keeps its true history.
					this.applyUpdate(
						activityId,
						{ status: previousStatus, error: previousError, latestEvent: "Retry unavailable" },
						true,
					)
					continue
				}
				retried.push(activityId)
			} catch (error) {
				this.applyUpdate(
					activityId,
					{
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
						latestEvent: "Retry failed to start",
					},
					true,
				)
			}
		}
		return retried
	}

	/**
	 * Cancel every eligible activity concurrently.
	 *
	 * Cancellation runs under a caller-owned timeout budget, so the batch must
	 * not serialize on the slowest canceller: one unresponsive activity would
	 * otherwise consume the whole budget and leave the rest untouched. Each
	 * activity reaches its own terminal state independently, and a rejecting
	 * canceller only fails its own activity.
	 *
	 * Results are collected by request position rather than by settle order:
	 * cancellers finish in an order decided by the remote runtime, so appending
	 * as they settle made the same batch answer differently run to run. The
	 * caller compares this response against the ids it requested.
	 */
	async cancel(activityIds: string[]): Promise<string[]> {
		const outcomes = await Promise.all(
			activityIds.map(async (activityId): Promise<string | undefined> => {
				const activity = this.activities.get(activityId)
				const cancel = this.cancellers.get(activityId)
				if (!activity || !cancel || activity.status !== "running") return undefined
				this.update(activityId, { status: "cancelling", latestEvent: "Cancellation requested" })
				try {
					await cancel()
					this.update(activityId, { status: "cancelled", latestEvent: "Cancelled by user" })
					return activityId
				} catch (error) {
					this.update(activityId, {
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					})
					return undefined
				}
			}),
		)
		return outcomes.filter((activityId): activityId is string => activityId !== undefined)
	}

	dispose(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer)
		this.flushTimer = undefined
		this.listeners.clear()
		this.cancellers.clear()
		this.finishers.clear()
		this.retriers.clear()
		this.backgroundMovers.clear()
	}

	async waitForPersistence(): Promise<void> {
		this.flush()
		await this.persistenceSequence
	}

	private markDirty(activityId: string, priority: boolean): void {
		this.dirtyIds.add(activityId)
		if (this.persistenceDeferralDepth > 0) return
		if (priority) {
			this.flush()
			return
		}
		if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS)
	}

	private flush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer)
		this.flushTimer = undefined
		if (this.dirtyIds.size === 0) return
		const activities = Array.from(this.dirtyIds)
			.map((id) => this.get(id))
			.filter((activity): activity is TaskActivityRecord => Boolean(activity))
		this.dirtyIds.clear()
		this.persist()
		if (this.listeners.size === 0) return
		const update: TaskActivityUpdate = { sequence: ++this.sequence, snapshot: false, activities }
		for (const listener of this.listeners.keys()) this.enqueue(listener, update)
	}

	private enqueue(listener: ActivityListener, update: TaskActivityUpdate): void {
		const previous = this.listeners.get(listener)
		if (!previous) return
		const delivery = previous
			.catch(() => undefined)
			.then(() => listener(update))
			.catch((error) => Logger.warn("[TaskActivityStore] Activity delivery failed", error))
		this.listeners.set(listener, delivery)
	}

	private trimEvents(activity: TaskActivityRecord): void {
		while (activity.events.length > MAX_EVENTS_PER_ACTIVITY) {
			const removableIndex = [
				activity.events.findIndex(
					(event) => event.kind === "thinking" || event.kind === "assistant_message" || event.kind === "metrics",
				),
				activity.events.findIndex((event) => event.kind === "tool_result"),
				activity.events.findIndex((event) => event.kind === "tool_call" && event.toolStatus === "started"),
			].find((index) => index >= 0)
			activity.events.splice(removableIndex ?? 0, 1)
		}
	}

	private createEvent(input: TaskActivityEventInput, attempt: number): TaskActivityEvent {
		return this.redactEvent({
			...input,
			sequence: ++this.sequence,
			timestamp: Date.now(),
			attempt,
		} as TaskActivityEvent)
	}

	private clone(activity: TaskActivityRecord): TaskActivityRecord {
		return {
			...activity,
			title: redactSensitiveText(activity.title),
			detail: activity.detail === undefined ? undefined : redactSensitiveText(activity.detail),
			latestEvent: activity.latestEvent === undefined ? undefined : redactSensitiveText(activity.latestEvent),
			output: activity.output === undefined ? undefined : redactSensitiveText(activity.output),
			result: activity.result === undefined ? undefined : redactSensitiveText(activity.result),
			error: activity.error === undefined ? undefined : redactSensitiveText(activity.error),
			runtime: activity.runtime ? { ...activity.runtime } : undefined,
			metrics: activity.metrics ? { ...activity.metrics } : undefined,
			// A recipe reaching this point may come from an activity file
			// written by an older build, so it is bounded here as well as on
			// the create path; otherwise loading such a file would reintroduce
			// the raw prompt the ceiling exists to prevent.
			retryRecipe: activity.retryRecipe ? boundRetryRecipe(activity.retryRecipe) : undefined,
			retryUnavailableReason:
				activity.retryUnavailableReason === undefined ? undefined : redactSensitiveText(activity.retryUnavailableReason),
			events: activity.events.map((event) => this.redactEvent({ ...event })),
		}
	}

	private redactEvent(event: TaskActivityEvent): TaskActivityEvent {
		if ("text" in event && typeof event.text === "string") {
			event.text = redactSensitiveText(event.text)
			if (event.text.length > MAX_EVENT_TEXT_CHARS) event.text = event.text.slice(-MAX_EVENT_TEXT_CHARS)
		}
		if ("summary" in event && typeof event.summary === "string") event.summary = redactSensitiveText(event.summary)
		if ("error" in event && typeof event.error === "string") event.error = redactSensitiveText(event.error)
		return event
	}

	private persist(): void {
		const persistence = this.persistence
		if (!persistence) return
		this.persistenceSequence = this.persistenceSequence
			.catch(() => undefined)
			.then(() => this.hydrate())
			.then(() => persistence.save(this.list()))
			.catch((error) => Logger.warn("[TaskActivityStore] Failed to persist activity history", error))
	}

	private isTransient(status: TaskActivityStatus): boolean {
		return status === "awaiting_approval" || status === "running" || status === "cancelling"
	}

	private isTerminal(status: TaskActivityStatus): boolean {
		return (
			status === "completed" ||
			status === "failed" ||
			status === "timeout" ||
			status === "cancelled" ||
			status === "interrupted"
		)
	}
}
