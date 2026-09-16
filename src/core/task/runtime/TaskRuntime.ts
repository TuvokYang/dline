import type { TaskEffect } from "./TaskEffect"
import type { TaskEffectPorts } from "./TaskEffectRunner"
import { TaskEffectError, TaskEffectRunner } from "./TaskEffectRunner"
import type { TaskEvent } from "./TaskEvent"
import { reduceTask, type TransitionResult } from "./TaskReducer"
import type { TaskRuntimeState } from "./TaskRuntimeState"

/** Dispatch result returned after state commit and effect processing. */
export type TaskDispatchResult = TransitionResult & {
	effectError?: {
		effectId: string
		effectType: TaskEffectError["effect"]["type"]
		message: string
	}
}

/** Observer notified after one event and any derived presentation event commit. */
export type TaskRuntimeObserver = (event: TaskEvent, result: TaskDispatchResult) => void

interface PreparedDispatch {
	result: TaskDispatchResult
	deferredEffects: TaskEffect[]
	effectState: TaskRuntimeState
}

/** Effects whose ports can causally dispatch more events into this runtime. */
function isReentrantEffect(effect: TaskEffect): boolean {
	return (
		effect.type === "EXECUTE_TOOL" ||
		effect.type === "START_API" ||
		effect.type === "START_NEW_TASK" ||
		effect.type === "START_SUCCESSOR_TASK"
	)
}

/** Owns the task runtime aggregate and serializes all event dispatches. */
export class TaskRuntime {
	private state: TaskRuntimeState
	private readonly runner: TaskEffectRunner
	private readonly observers = new Set<TaskRuntimeObserver>()
	private readonly deferredEffects = new Map<Promise<TaskDispatchResult>, number>()
	private queue: Promise<void> = Promise.resolve()
	private commitObserver?: (event: string, state: Readonly<TaskRuntimeState>) => void

	/** Observation at the commit boundary, independent of delayed effect completion observers. */
	setCommitObserver(observer: (event: string, state: Readonly<TaskRuntimeState>) => void): void {
		this.commitObserver = observer
		this.observeCommit("initialized")
	}

	private observeCommit(event: string): void {
		try {
			this.commitObserver?.(event, this.state)
		} catch {
			/* Diagnostics cannot roll back a commit. */
		}
	}

	constructor(initialState: TaskRuntimeState, ports: TaskEffectPorts) {
		this.state = initialState
		this.runner = new TaskEffectRunner(ports)
	}

	/** Replace runtime state only with an already validated resume aggregate. */
	restore(state: TaskRuntimeState): void {
		this.state = state
		this.observeCommit("restored")
	}

	/** Return the current committed runtime aggregate. */
	getState(): Readonly<TaskRuntimeState> {
		return this.state
	}

	/** Subscribe to committed runtime events. */
	subscribe(observer: TaskRuntimeObserver): () => void {
		this.observers.add(observer)
		return () => this.observers.delete(observer)
	}

	/** Serialize one event transition and its ordered effects. */
	dispatch(event: TaskEvent): Promise<TaskDispatchResult> {
		// Commit state and all non-reentrant effects under the queue. Long-running
		// tool/API/task-lifecycle ports are completed after releasing it, otherwise
		// a port that dispatches back into this runtime waits on its own queue entry.
		const preparation = this.queue.then(() => this.prepareDispatch(event, true))
		this.queue = preparation.then(
			() => undefined,
			() => undefined,
		)
		return preparation.then((prepared) => this.trackDeferredEffects(this.completeDeferredEffects(event, prepared), prepared))
	}

	/** Return after state admission and immediate effects while long-running effects finish in the background. */
	dispatchAtAdmission(event: TaskEvent): Promise<TaskDispatchResult> {
		const preparation = this.queue.then(() => this.prepareDispatch(event, true))
		this.queue = preparation.then(
			() => undefined,
			() => undefined,
		)
		return preparation.then((prepared) => {
			if (prepared.result.accepted && prepared.deferredEffects.length > 0) {
				void this.trackDeferredEffects(this.completeDeferredEffects(event, prepared), prepared).catch(() => undefined)
			}
			return prepared.result
		})
	}

	/** Wait until every deferred reentrant effect admitted through the supplied revision has exited. */
	async waitForDeferredEffectsThrough(revision: number): Promise<void> {
		while (true) {
			const pending = [...this.deferredEffects.entries()]
				.filter(([, originRevision]) => originRevision <= revision)
				.map(([promise]) => promise)
			if (pending.length === 0) return
			await Promise.allSettled(pending)
		}
	}

	/** Track deferred work by the state revision that admitted it. */
	private trackDeferredEffects(promise: Promise<TaskDispatchResult>, prepared: PreparedDispatch): Promise<TaskDispatchResult> {
		if (!prepared.result.accepted || prepared.deferredEffects.length === 0) return promise
		this.deferredEffects.set(promise, prepared.effectState.revision)
		void promise.finally(() => {
			this.deferredEffects.delete(promise)
		})
		return promise
	}

	/** Commit one reduced state and run effects that cannot re-enter the runtime. */
	private async prepareDispatch(event: TaskEvent, deferReentrantEffects: boolean): Promise<PreparedDispatch> {
		const result = reduceTask(this.state, event)
		if (!result.accepted) {
			return { result, deferredEffects: [], effectState: this.state }
		}

		this.state = result.next
		this.observeCommit(event.type)
		const effectState = this.state
		const deferredEffects = deferReentrantEffects ? result.effects.filter(isReentrantEffect) : []
		const immediateEffects = deferReentrantEffects
			? result.effects.filter((effect) => !isReentrantEffect(effect))
			: result.effects
		try {
			const anchors = await this.runner.run(immediateEffects, effectState)
			for (const anchor of anchors) {
				const interactionId = this.presentedInteractionId(event)
				if (interactionId) {
					await this.prepareDispatch(
						{
							type: "INTERACTION_PRESENTED",
							interactionId,
							messageTs: anchor.uiMessageTs,
						},
						false,
					)
				}
			}
		} catch (error) {
			if (event.type === "EFFECT_FAILED") {
				throw error
			}
			if (!(error instanceof TaskEffectError)) {
				throw error
			}
			await this.prepareDispatch(
				{
					type: "EFFECT_FAILED",
					effectId: error.effect.id,
					effectType: error.effect.type,
					originRevision: effectState.revision,
					message: error.message,
				},
				false,
			)
			const failed: TaskDispatchResult = {
				...result,
				accepted: false,
				effectError: {
					effectId: error.effect.id,
					effectType: error.effect.type,
					message: error.message,
				},
			}
			for (const observer of this.observers) {
				observer(event, failed)
			}
			return { result: failed, deferredEffects: [], effectState }
		}
		if (deferredEffects.length === 0) {
			this.notifyObservers(event, result)
		}
		return { result, deferredEffects, effectState }
	}

	/** Complete one reentrant port after the state queue has been released. */
	private async completeDeferredEffects(event: TaskEvent, prepared: PreparedDispatch): Promise<TaskDispatchResult> {
		if (!prepared.result.accepted || prepared.deferredEffects.length === 0) {
			return prepared.result
		}
		try {
			await this.runner.run(prepared.deferredEffects, prepared.effectState)
			this.notifyObservers(event, prepared.result)
			return prepared.result
		} catch (error) {
			if (!(error instanceof TaskEffectError)) {
				throw error
			}
			await this.dispatch({
				type: "EFFECT_FAILED",
				effectId: error.effect.id,
				effectType: error.effect.type,
				originRevision: prepared.effectState.revision,
				...(error.effect.type === "START_API" && prepared.effectState.interaction
					? { originInteraction: prepared.effectState.interaction }
					: {}),
				message: error.message,
			})
			const failed: TaskDispatchResult = {
				...prepared.result,
				accepted: false,
				effectError: {
					effectId: error.effect.id,
					effectType: error.effect.type,
					message: error.message,
				},
			}
			this.notifyObservers(event, failed)
			return failed
		}
	}

	private notifyObservers(event: TaskEvent, result: TaskDispatchResult): void {
		for (const observer of this.observers) {
			observer(event, result)
		}
	}

	/** Return the interaction identity presented by one direct or composite lifecycle event. */
	private presentedInteractionId(event: TaskEvent): string | undefined {
		switch (event.type) {
			case "INTERACTION_OPEN_REQUESTED":
			case "INTERACTION_INTERRUPT_REQUESTED":
			case "API_RETRY_EXHAUSTED":
			case "MISTAKE_LIMIT_REACHED":
			case "ATTEMPT_COMPLETION_PRESENTED":
			case "HOSTED_WEB_REQUEST_REJECTED":
				return event.interactionId
			case "TASK_CANCELLED":
				return event.resume?.interactionId
			case "CHECKPOINT_CHAT_RESTORED": {
				const interaction = this.state.interaction
				return interaction?.kind === "resume" && interaction.status === "opening" ? interaction.interactionId : undefined
			}
			case "EFFECT_FAILED": {
				const interaction = this.state.interaction
				return interaction?.kind === "resume" && interaction.status === "opening" ? interaction.interactionId : undefined
			}
			default:
				return undefined
		}
	}
}
