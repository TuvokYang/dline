import type { ClineContent } from "@shared/messages"
import type { TaskEvent } from "../runtime/TaskEvent"
import type { TaskDispatchResult, TaskRuntime } from "../runtime/TaskRuntime"
import type { InteractionKind } from "./Interaction"
import { InteractionCancellationError, isInteractionCancellationError } from "./InteractionCancellationError"
import type { ActiveInteraction } from "./InteractionReducer"
import type { InteractionDraft, InteractionResponse, InteractionSelection } from "./InteractionResponse"

/** Request used to open one primary interaction. */
export interface OpenInteractionRequest {
	turnId: string
	interactionId: string
	kind: InteractionKind
	presentation: string
	existingTs?: number
}

/** Request used to present and resolve one completion transaction. */
export interface CompleteInteractionRequest {
	turnId: string
	interactionId: string
	completionId: string
	presentation: string
	existingTs?: number
}

/** Request used to present and resolve one exhausted retry transaction. */
export interface RetryInteractionRequest {
	turnId: string
	interactionId: string
	apiIndex: number
	presentation: string
	/** Whether the failed request already has a durable user message at apiIndex. */
	persistedRequest?: boolean
	/** Ephemeral request content captured before it could be appended to API history. */
	retryContent?: ClineContent[]
}

/** Request used to present and resolve one mistake-limit transaction. */
export interface MistakeLimitInteractionRequest {
	turnId: string
	interactionId: string
	apiIndex: number
	presentation: string
}

/** Typed user outcome returned to one interaction consumer. */
export interface InteractionOutcome {
	actionId: InteractionResponse["actionId"]
	draft?: InteractionDraft
	selection?: InteractionSelection
}

export interface AwaitingUserDurableBoundary {
	readonly turnId: string
	readonly interactionId: string
	readonly kind: InteractionKind
}

export interface InteractionCoordinatorOptions {
	readonly onAwaitingUserDurable?: (boundary: AwaitingUserDurableBoundary) => void
	/** Resolve legacy error-retry snapshots that predate persisted retry-source state. */
	readonly isPersistedApiRequest?: (apiIndex: number) => boolean
	/** Rebuild legacy ephemeral retry content from durable task UI state. */
	readonly resolveLegacyRetryContent?: (apiIndex: number, interactionId: string) => Promise<ClineContent[] | undefined>
}

/** Context passed to the Task-owned continuation for a restored handler interaction. */
export interface DetachedInteractionContinuationContext {
	interaction: Readonly<ActiveInteraction>
	outcome: InteractionOutcome
	/** Return whether this continuation still belongs to the active cancellation generation. */
	isCurrent(): boolean
	/** Resolve the original interaction before opening a causally subsequent interaction. */
	resolve(): Promise<void>
}

/** Continue one accepted interaction when no live handler waiter survived restoration. */
export type DetachedInteractionContinuation = (context: DetachedInteractionContinuationContext) => Promise<void>

type RuntimeOwnedInteractionKind = "resume" | "completion" | "error_retry" | "mistake_limit"

function isRuntimeOwnedInteraction(kind: InteractionKind): kind is RuntimeOwnedInteractionKind {
	return kind === "resume" || kind === "completion" || kind === "error_retry" || kind === "mistake_limit"
}

function outcomeFrom(response: InteractionResponse): InteractionOutcome {
	return { actionId: response.actionId, draft: response.draft, selection: response.selection }
}

function isCompleteExecutionTurnEnd(kind: InteractionKind): boolean {
	switch (kind) {
		case "followup":
		case "make_plan":
		case "qna_response":
		case "generate_report":
		case "new_task":
		case "completion":
			return true
		default:
			return false
	}
}

/** Select conversational interactions that can continue after a committed mode switch. */
function modeSwitchAction(kind: InteractionKind): InteractionResponse["actionId"] | undefined {
	switch (kind) {
		case "followup":
		case "make_plan":
		case "qna_response":
		case "generate_report":
		case "completion":
			return "reply"
		case "status_acknowledgment":
			return "acknowledge"
		default:
			return undefined
	}
}

/** Coordinates one active interaction between runtime events and a handler waiter. */
export class InteractionCoordinator {
	private readonly waitingInteractionIds = new Set<string>()
	private readonly waitingInteractionRejectors = new Map<string, (error: Error) => void>()
	private readonly pendingInteractionSettlements = new Map<string, Promise<void>>()
	private readonly claimedContinuations = new Map<string, Promise<InteractionOutcome>>()
	private detachedContinuation?: DetachedInteractionContinuation
	private continuationGeneration = 0
	private readonly activeCancellationGenerations = new Set<number>()
	private permanentlyFenced = false

	constructor(
		private readonly runtime: TaskRuntime,
		private readonly options: InteractionCoordinatorOptions = {},
	) {}

	/** Register the sole Task-owned continuation for restored handler interactions. */
	registerDetachedContinuation(continuation: DetachedInteractionContinuation): () => void {
		if (this.detachedContinuation && this.detachedContinuation !== continuation) {
			throw new Error("Detached interaction continuation is already registered")
		}
		this.detachedContinuation = continuation
		return () => {
			if (this.detachedContinuation === continuation) {
				this.detachedContinuation = undefined
			}
		}
	}

	/** Fence old continuations and reject live waiters as soon as cancellation is requested. */
	cancelPending(reason = "task_cancelled"): number {
		const generation = ++this.continuationGeneration
		this.activeCancellationGenerations.add(generation)
		for (const reject of this.waitingInteractionRejectors.values()) {
			reject(new InteractionCancellationError(reason))
		}
		this.waitingInteractionRejectors.clear()
		return generation
	}

	/** Permanently invalidate every continuation after the owning Task leaves its Controller. */
	fence(reason = "task_detached"): void {
		if (this.permanentlyFenced) return
		this.permanentlyFenced = true
		this.continuationGeneration++
		for (const reject of this.waitingInteractionRejectors.values()) {
			reject(new InteractionCancellationError(reason))
		}
		this.waitingInteractionRejectors.clear()
	}

	/** Cancel only the live waiter owned by one interaction without fencing unrelated continuations. */
	cancelPendingInteraction(interactionId: string, reason = "interaction_cancelled"): boolean {
		const reject = this.waitingInteractionRejectors.get(interactionId)
		if (!reject) return false
		reject(new InteractionCancellationError(reason))
		return true
	}

	/** Wait until one explicitly cancelled or responded interaction waiter has fully unwound. */
	async waitForPendingInteraction(interactionId: string): Promise<void> {
		const pending = this.pendingInteractionSettlements.get(interactionId)
		if (pending) await pending
	}

	/** Release one cancellation transaction without making its old continuations current again. */
	completeCancellation(generation: number): void {
		this.activeCancellationGenerations.delete(generation)
	}

	/** Wait until every continuation already admitted by an interaction response has exited. */
	async waitForClaimedContinuations(): Promise<void> {
		while (true) {
			const pending = [...this.claimedContinuations.values()]
			if (pending.length === 0) return
			await Promise.allSettled(pending)
		}
	}

	/** Wait only for the detached continuation claimed by one interaction response. */
	async waitForClaimedContinuation(interactionId: string): Promise<void> {
		const pending = this.claimedContinuations.get(interactionId)
		if (pending) await Promise.allSettled([pending])
	}

	/** Release one accepted API continuation before a causally subsequent request gate opens. */
	async releaseApiContinuationForRequestGate(): Promise<boolean> {
		const interaction = this.runtime.getState().interaction
		const acceptedAction = interaction?.acceptedResponse?.actionId
		const ownsAdmittedApiContinuation =
			(interaction?.status === "resolving" ||
				(interaction?.status === "awaiting" && interaction.acceptedResponse !== undefined)) &&
			((interaction.kind === "resume" && acceptedAction === "resume") ||
				(interaction.kind === "error_retry" && acceptedAction === "retry") ||
				(interaction.kind === "mistake_limit" && acceptedAction === "process_anyway"))
		if (!interaction || !ownsAdmittedApiContinuation) return false

		const resolved = await this.runtime.dispatch({
			type: "INTERACTION_RESOLVED",
			interactionId: interaction.interactionId,
		})
		if (!resolved.accepted) {
			throw new Error(`Request-gate interaction handoff rejected: ${resolved.error?.code ?? "invalid_runtime_event"}`)
		}
		return true
	}

	/** Dispatch one response and synchronously consume resume continuation only when no waiter owns it. */
	async respond(response: InteractionResponse): Promise<TaskDispatchResult> {
		const generation = this.continuationGeneration
		if (!this.isCurrentGeneration(generation)) return this.staleResponseResult()
		const waiterOwnsContinuation = this.waitingInteractionIds.has(response.interactionId)
		const current = this.runtime.getState()
		const currentInteraction = current.interaction
		const targetsCurrentAwaitingInteraction =
			currentInteraction?.status === "awaiting" &&
			currentInteraction.taskId === response.taskId &&
			currentInteraction.turnId === response.turnId &&
			currentInteraction.interactionId === response.interactionId &&
			response.stateRevision >= currentInteraction.createdRevision &&
			response.stateRevision <= current.revision
		const detachedContinuation = this.detachedContinuation
		if (
			!waiterOwnsContinuation &&
			targetsCurrentAwaitingInteraction &&
			currentInteraction &&
			!isRuntimeOwnedInteraction(currentInteraction.kind) &&
			!detachedContinuation
		) {
			throw new Error(`Detached continuation is not registered for interaction kind=${currentInteraction.kind}`)
		}

		const result = await this.runtime.dispatch({ type: "INTERACTION_RESPONDED", response })
		if (!result.accepted) return result
		if (!this.isCurrentGeneration(generation)) return this.staleResponseResult()
		if (waiterOwnsContinuation) return result
		const interaction = result.next.interaction
		if (interaction?.status === "resolving") {
			const continuation = this.claimContinuation(interaction.interactionId, generation, () =>
				this.commitDetachedInteraction(interaction, response, generation, detachedContinuation),
			)
			const continuesInBackground =
				!isRuntimeOwnedInteraction(interaction.kind) ||
				(interaction.kind === "completion" && response.actionId !== "start_new_task")
			if (continuesInBackground) {
				void continuation.catch(() => undefined)
			} else {
				await continuation
			}
		}
		return result
	}

	/** Return whether the current awaiting interaction can continue after a direct mode switch. */
	canRespondForModeSwitch(): boolean {
		const interaction = this.runtime.getState().interaction
		return interaction?.status === "awaiting" && modeSwitchAction(interaction.kind) !== undefined
	}

	/** Resolve one conversational interaction with user-authored mode-switch content, if any. */
	async respondForModeSwitch(draft: InteractionDraft): Promise<boolean> {
		const state = this.runtime.getState()
		const interaction = state.interaction
		const actionId = interaction?.status === "awaiting" ? modeSwitchAction(interaction.kind) : undefined
		if (!interaction || !actionId) return false
		const result = await this.respond({
			taskId: interaction.taskId,
			turnId: interaction.turnId,
			interactionId: interaction.interactionId,
			actionId,
			stateRevision: state.revision,
			draft,
		})
		return result.accepted
	}

	/** Open or strictly take over one interaction and wait for its causal response. */
	async open(request: OpenInteractionRequest): Promise<InteractionOutcome> {
		const response = await this.waitForPresentedResponse(request, {
			type: "INTERACTION_OPEN_REQUESTED",
			...request,
		})
		const resolved = await this.runtime.dispatch({
			type: "INTERACTION_RESOLVED",
			interactionId: request.interactionId,
		})
		if (!resolved.accepted) {
			throw new Error(`Interaction resolve rejected: ${resolved.error?.code ?? "invalid_runtime_event"}`)
		}
		return { actionId: response.actionId, draft: response.draft, selection: response.selection }
	}

	/** Temporarily replace one awaiting primary interaction and restore it after this response is consumed. */
	async interrupt(request: OpenInteractionRequest): Promise<InteractionOutcome> {
		const response = await this.waitForResponse(request.interactionId, {
			type: "INTERACTION_INTERRUPT_REQUESTED",
			...request,
		})
		const resolved = await this.runtime.dispatch({
			type: "INTERACTION_RESOLVED",
			interactionId: request.interactionId,
		})
		if (!resolved.accepted) {
			throw new Error(`Interaction interrupt resolve rejected: ${resolved.error?.code ?? "invalid_runtime_event"}`)
		}
		return { actionId: response.actionId, draft: response.draft, selection: response.selection }
	}

	/** Open one resume interaction and commit its causal continuation. */
	async resume(request: OpenInteractionRequest): Promise<InteractionOutcome> {
		const response = await this.waitForPresentedResponse(request, {
			type: "INTERACTION_OPEN_REQUESTED",
			...request,
		})
		return this.commitResume(request.interactionId, response)
	}

	/** Take over one hydrated resume interaction and commit its causal continuation. */
	async resumeExisting(interactionId: string): Promise<InteractionOutcome> {
		const interaction = this.runtime.getState().interaction
		if (!interaction) throw new Error("Hydrated resume interaction is missing")
		const response = await this.waitForExistingResponse(interactionId, interaction.turnId, "resume")
		return this.commitResume(interactionId, response)
	}

	/** Claim and commit one accepted resume continuation exactly once per interaction identity. */
	private commitResume(interactionId: string, response: InteractionResponse): Promise<InteractionOutcome> {
		const generation = this.continuationGeneration
		return this.claimContinuation(interactionId, generation, () => this.commitClaimedResume(interactionId, response))
	}

	/** Claim one continuation while concurrent callers still reference the same interaction. */
	private claimContinuation(
		interactionId: string,
		generation: number,
		commit: () => Promise<InteractionOutcome>,
	): Promise<InteractionOutcome> {
		const existing = this.claimedContinuations.get(interactionId)
		if (existing) return existing
		if (!this.isCurrentGeneration(generation)) {
			return Promise.reject(new InteractionCancellationError("task_cancelled"))
		}
		const continuation = commit()
		this.claimedContinuations.set(interactionId, continuation)
		const clear = () => {
			if (this.claimedContinuations.get(interactionId) === continuation) {
				this.claimedContinuations.delete(interactionId)
			}
		}
		void continuation.then(clear, clear)
		return continuation
	}

	/** Commit the typed continuation selected by one accepted detached response. */
	private async commitDetachedInteraction(
		interaction: ActiveInteraction,
		response: InteractionResponse,
		generation: number,
		detachedContinuation?: DetachedInteractionContinuation,
	): Promise<InteractionOutcome> {
		switch (interaction.kind) {
			case "resume":
				return this.commitClaimedResume(interaction.interactionId, response)
			case "completion":
				if (response.actionId === "start_new_task") {
					return this.commitCompletionResponse(response)
				}
				await this.commitCompletionResponse(response)
				if (!this.isCurrentGeneration(generation)) return outcomeFrom(response)
				if (!detachedContinuation) {
					throw new Error("Detached continuation is not registered for completion feedback")
				}
				return this.commitHandlerResponse(interaction, response, generation, detachedContinuation)
			case "error_retry": {
				const apiIndex = this.runtime.getState().anchor.apiIndex
				const persistedRequest = interaction.persistedRequest ?? this.options.isPersistedApiRequest?.(apiIndex) ?? true
				const retryContent =
					interaction.retryContent ??
					(persistedRequest
						? undefined
						: await this.options.resolveLegacyRetryContent?.(apiIndex, interaction.interactionId))
				return this.commitErrorRetryResponse(response, apiIndex, persistedRequest, retryContent)
			}
			case "mistake_limit":
				return this.commitMistakeLimitResponse(response, this.runtime.getState().anchor.apiIndex)
			default:
				if (!detachedContinuation) {
					throw new Error(`Detached continuation is not registered for interaction kind=${interaction.kind}`)
				}
				return this.commitHandlerResponse(interaction, response, generation, detachedContinuation)
		}
	}

	/** Commit the already claimed resume continuation through its typed runtime event. */
	private async commitClaimedResume(interactionId: string, response: InteractionResponse): Promise<InteractionOutcome> {
		const committed = await this.runtime.dispatchAtAdmission({
			type: "TASK_RESUME_REQUESTED",
			interactionId,
			draft: response.draft ?? { text: "", images: [], files: [] },
		})
		if (!committed.accepted) {
			throw new Error(`Resume continuation rejected: ${committed.error?.code ?? "invalid_runtime_event"}`)
		}
		return outcomeFrom(response)
	}

	/** Let the Task continue one restored handler, then resolve its original interaction. */
	private async commitHandlerResponse(
		interaction: ActiveInteraction,
		response: InteractionResponse,
		generation: number,
		continuation: DetachedInteractionContinuation,
	): Promise<InteractionOutcome> {
		const outcome = outcomeFrom(response)
		let resolvePromise: Promise<void> | undefined
		const resolve = () => {
			if (!resolvePromise) {
				resolvePromise = this.resolveInteraction(interaction.interactionId)
			}
			return resolvePromise
		}
		await continuation({
			interaction,
			outcome,
			isCurrent: () => this.isCurrentGeneration(generation),
			resolve,
		})
		if (!this.isCurrentGeneration(generation)) return outcome
		await resolve()
		return outcome
	}

	/** Return whether asynchronous work still belongs to the latest non-cancelling generation. */
	private isCurrentGeneration(generation: number): boolean {
		return (
			!this.permanentlyFenced && generation === this.continuationGeneration && this.activeCancellationGenerations.size === 0
		)
	}

	/** Reject a response whose continuation lost admission to a newer cancellation transaction. */
	private staleResponseResult(): TaskDispatchResult {
		const current = this.runtime.getState()
		return {
			accepted: false,
			next: { ...current },
			effects: [],
			error: {
				code: "stale_interaction",
				eventType: "INTERACTION_RESPONDED",
				phase: current.phase,
			},
		}
	}

	/** Resolve exactly the original accepted interaction. */
	private async resolveInteraction(interactionId: string): Promise<void> {
		const active = this.runtime.getState().interaction
		if (!active || active.interactionId !== interactionId) {
			return
		}
		const resolved = await this.runtime.dispatch({ type: "INTERACTION_RESOLVED", interactionId })
		if (!resolved.accepted) {
			throw new Error(`Interaction resolve rejected: ${resolved.error?.code ?? "invalid_runtime_event"}`)
		}
	}

	/** Commit one accepted completion response through its typed lifecycle event. */
	private async commitCompletionResponse(response: InteractionResponse): Promise<InteractionOutcome> {
		const continuation: TaskEvent =
			response.actionId === "start_new_task"
				? {
						type: "TASK_CLEAR_REQUESTED",
						draft: response.draft ?? { text: "", images: [], files: [] },
					}
				: {
						type: "COMPLETION_FEEDBACK_RECEIVED",
						draft: response.draft ?? { text: "", images: [], files: [] },
					}
		const committed = await (response.actionId === "start_new_task"
			? this.runtime.dispatchAtAdmission(continuation)
			: this.runtime.dispatch(continuation))
		if (!committed.accepted) {
			throw new Error(`Completion continuation rejected: ${committed.error?.code ?? "invalid_runtime_event"}`)
		}
		return outcomeFrom(response)
	}

	/** Commit one accepted API-error response through its typed lifecycle event. */
	private async commitErrorRetryResponse(
		response: InteractionResponse,
		apiIndex: number,
		persistedRequest = true,
		retryContent?: ClineContent[],
	): Promise<InteractionOutcome> {
		const continuation: TaskEvent =
			response.actionId === "start_new_task"
				? {
						type: "TASK_CLEAR_REQUESTED",
						draft: response.draft ?? { text: "", images: [], files: [] },
					}
				: {
						type: "ERROR_RETRY_REQUESTED",
						apiIndex,
						draft: response.draft ?? { text: "", images: [], files: [] },
						persistedRequest,
						...(retryContent?.length ? { retryContent } : {}),
					}
		const committed = await this.runtime.dispatchAtAdmission(continuation)
		if (!committed.accepted) {
			throw new Error(`Retry continuation rejected: ${committed.error?.code ?? "invalid_runtime_event"}`)
		}
		return outcomeFrom(response)
	}

	/** Commit one accepted mistake-limit response through its typed lifecycle event. */
	private async commitMistakeLimitResponse(response: InteractionResponse, apiIndex: number): Promise<InteractionOutcome> {
		const continuation: TaskEvent =
			response.actionId === "start_new_task"
				? {
						type: "TASK_CLEAR_REQUESTED",
						draft: response.draft ?? { text: "", images: [], files: [] },
					}
				: {
						type: "MISTAKE_LIMIT_CONTINUE_REQUESTED",
						apiIndex,
						draft: response.draft ?? { text: "", images: [], files: [] },
					}
		const committed = await this.runtime.dispatchAtAdmission(continuation)
		if (!committed.accepted) {
			throw new Error(`Mistake-limit continuation rejected: ${committed.error?.code ?? "invalid_runtime_event"}`)
		}
		return outcomeFrom(response)
	}

	/** Present completion and commit the selected continuation as one backend transaction. */
	async complete(request: CompleteInteractionRequest): Promise<InteractionOutcome> {
		const response = await this.waitForPresentedResponse(
			{ ...request, kind: "completion" },
			{
				type: "ATTEMPT_COMPLETION_PRESENTED",
				...request,
			},
		)
		return this.commitCompletionResponse(response)
	}

	/** Present exhausted retry recovery and commit the selected continuation. */
	async recover(request: RetryInteractionRequest): Promise<InteractionOutcome> {
		const response = await this.waitForPresentedResponse(
			{ ...request, kind: "error_retry" },
			{
				type: "API_RETRY_EXHAUSTED",
				...request,
			},
		)
		const hasContinuationDraft = Boolean(
			response.draft &&
				(response.draft.text.trim().length > 0 || response.draft.images.length > 0 || response.draft.files.length > 0),
		)
		const persistedRequest = hasContinuationDraft ? false : request.persistedRequest !== false
		return this.commitErrorRetryResponse(response, request.apiIndex, persistedRequest, request.retryContent)
	}

	/** Present a mistake-limit recovery and commit the selected footer action. */
	async recoverMistakeLimit(request: MistakeLimitInteractionRequest): Promise<InteractionOutcome> {
		const response = await this.waitForPresentedResponse(
			{ ...request, kind: "mistake_limit" },
			{
				type: "MISTAKE_LIMIT_REACHED",
				...request,
			},
		)
		return this.commitMistakeLimitResponse(response, request.apiIndex)
	}

	/** Use an exact hydrated interaction when present, otherwise present a new one. */
	private async waitForPresentedResponse(
		request: Pick<OpenInteractionRequest, "turnId" | "interactionId" | "kind">,
		openingEvent: TaskEvent,
	): Promise<InteractionResponse> {
		if (this.runtime.getState().interaction) {
			try {
				return await this.waitForExistingResponse(request.interactionId, request.turnId, request.kind)
			} catch (error) {
				if (isInteractionCancellationError(error)) throw error
				throw new Error("Interaction open rejected: hydrated_interaction_mismatch", { cause: error })
			}
		}
		return this.waitForResponse(request.interactionId, openingEvent, request)
	}

	/** Wait for a causal response to one already hydrated interaction. */
	private async waitForExistingResponse(
		interactionId: string,
		turnId: string,
		kind: InteractionKind,
	): Promise<InteractionResponse> {
		const generation = this.continuationGeneration
		if (!this.isCurrentGeneration(generation)) throw new InteractionCancellationError("task_cancelled")
		const interaction = this.runtime.getState().interaction
		if (
			!interaction ||
			interaction.interactionId !== interactionId ||
			interaction.turnId !== turnId ||
			interaction.kind !== kind
		) {
			throw new Error("Hydrated interaction does not match the requested continuation")
		}
		if (interaction.status === "resolving") {
			if (!interaction.acceptedResponse) {
				throw new Error("Hydrated resolving interaction is missing its accepted response")
			}
			return interaction.acceptedResponse
		}
		if (interaction.status !== "awaiting") {
			throw new Error("Hydrated interaction is not awaiting the requested continuation")
		}
		this.waitingInteractionIds.add(interactionId)
		let resolveResponse: ((response: InteractionResponse) => void) | undefined
		let resolveSettlement: (() => void) | undefined
		const responsePromise = new Promise<InteractionResponse>((resolve, reject) => {
			resolveResponse = resolve
			this.waitingInteractionRejectors.set(interactionId, reject)
		})
		const settlement = new Promise<void>((resolve) => {
			resolveSettlement = resolve
		})
		this.pendingInteractionSettlements.set(interactionId, settlement)
		const unsubscribe = this.runtime.subscribe((event, result) => {
			this.captureResponse(interactionId, generation, event, result, resolveResponse)
		})
		try {
			const response = await responsePromise
			if (!this.isCurrentGeneration(generation)) throw new InteractionCancellationError("task_cancelled")
			return response
		} finally {
			this.waitingInteractionIds.delete(interactionId)
			this.waitingInteractionRejectors.delete(interactionId)
			if (this.pendingInteractionSettlements.get(interactionId) === settlement) {
				this.pendingInteractionSettlements.delete(interactionId)
			}
			resolveSettlement?.()
			unsubscribe()
		}
	}

	/** Dispatch an opening event and wait for its causally matching accepted response. */
	private async waitForResponse(
		interactionId: string,
		openingEvent: TaskEvent,
		awaitingBoundary?: Pick<OpenInteractionRequest, "turnId" | "interactionId" | "kind">,
	): Promise<InteractionResponse> {
		const generation = this.continuationGeneration
		if (!this.isCurrentGeneration(generation)) throw new InteractionCancellationError("task_cancelled")
		this.waitingInteractionIds.add(interactionId)
		let resolveResponse: ((response: InteractionResponse) => void) | undefined
		let resolveSettlement: (() => void) | undefined
		const responsePromise = new Promise<InteractionResponse>((resolve, reject) => {
			resolveResponse = resolve
			this.waitingInteractionRejectors.set(interactionId, reject)
		})
		const settlement = new Promise<void>((resolve) => {
			resolveSettlement = resolve
		})
		this.pendingInteractionSettlements.set(interactionId, settlement)
		const unsubscribe = this.runtime.subscribe((event, result) => {
			this.captureResponse(interactionId, generation, event, result, resolveResponse)
		})
		try {
			const opened = await this.runtime.dispatch(openingEvent)
			if (!opened.accepted) {
				throw new Error(`Interaction open rejected: ${opened.error?.code ?? "invalid_runtime_event"}`)
			}
			if (awaitingBoundary && isCompleteExecutionTurnEnd(awaitingBoundary.kind)) {
				this.options.onAwaitingUserDurable?.({
					turnId: awaitingBoundary.turnId,
					interactionId: awaitingBoundary.interactionId,
					kind: awaitingBoundary.kind,
				})
			}
			const response = await responsePromise
			if (!this.isCurrentGeneration(generation)) throw new InteractionCancellationError("task_cancelled")
			return response
		} finally {
			this.waitingInteractionIds.delete(interactionId)
			this.waitingInteractionRejectors.delete(interactionId)
			if (this.pendingInteractionSettlements.get(interactionId) === settlement) {
				this.pendingInteractionSettlements.delete(interactionId)
			}
			resolveSettlement?.()
			unsubscribe()
		}
	}

	/** Capture only an accepted response for the interaction owned by this waiter. */
	private captureResponse(
		interactionId: string,
		generation: number,
		event: TaskEvent,
		result: TaskDispatchResult,
		resolveResponse: ((response: InteractionResponse) => void) | undefined,
	): void {
		if (
			this.isCurrentGeneration(generation) &&
			event.type === "INTERACTION_RESPONDED" &&
			result.accepted &&
			event.response.interactionId === interactionId
		) {
			resolveResponse?.(event.response)
		}
	}
}
