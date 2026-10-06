import type { ApiHandler } from "@core/api"
import type { CanonicalMessageRange } from "@core/context/context-management/compaction-context-projection"
import { isCompactionPassBudgetError } from "@core/context/context-management/compaction-pass-budget-error"
import { planNextCompactionPass } from "@core/context/context-management/compaction-pass-planner"
import { type ContextCompactionPhaseTiming, elapsedCompactionMs } from "@core/context/context-management/compaction-phase-timing"
import { CompactionRetryPolicy } from "@core/context/context-management/compaction-retry-policy"
import { createCompactionSourceSnapshot } from "@core/context/context-management/compaction-source-snapshot"
import {
	type InternalCompactionAttemptIdentity,
	type InternalCompactionPassRetryEvent,
	isUnusableCompactionSummaryError,
	type RunInternalCompactionPassWithRetryInput,
	runInternalCompactionPassWithRetry,
} from "@core/context/context-management/internal-compaction-pass"
import { indexLogicalTurns } from "@core/context/context-management/logical-turns"
import {
	createSummaryRefitIdentity,
	formatSummaryRefitFailure,
	MAX_SUMMARY_REFIT_ATTEMPTS,
	resolveSummaryRefitCarryLimit,
	type SummaryCarryOverflow,
} from "@core/context/context-management/summary-refit"
import type { TargetWindowFittingDecision } from "@core/context/context-management/TargetWindowFittingService"
import {
	acceptCompactionPass,
	applyCompactionPassPlan,
	getCompactionPassIdentity,
	refitCompactionSummary,
	type TargetWindowFittingState,
	tryStartTargetWindowFitting,
} from "@core/context/context-management/target-window-fitting"
import type { CompactionProviderInput } from "@core/task/compaction/CompactionRequestReplay"
import type { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import type { ProviderRequestRoundAdmission, ProviderRequestRoundPort } from "@core/task/performance/provider-request-round-port"
import type { ChatContent } from "@shared/ChatContent"
import type { ClineContent, ClineStorageMessage } from "@shared/messages/content"
import type { Mode } from "@shared/storage/types"
import cloneDeep from "clone-deep"

export type ContextCompactionTriggerKind =
	| "auto_compaction"
	| "task_header"
	| "manual_compact_command"
	| "profile_switch"
	| "mode_switch"

export type ContextCompactionSessionResult = "completed" | "cancelled" | "failed"

/** Stable, non-secret transition state owned by the transition workflow. */
export interface ContextCompactionTransitionState {
	kind: "profile_switch" | "mode_switch"
	operationId: string
	phase: "compacting"
	source: {
		mode: Mode
		profile?: string
		contextWindow?: number
	}
	sourceProfiles?: Partial<Record<Mode, string>>
	target: {
		mode: Mode
		profile?: string
		contextWindow: number
	}
	targetModes?: Mode[]
	chatContent?: ChatContent
}

export interface ContextCompactionSessionInput {
	operationId: string
	trigger: ContextCompactionTriggerKind
	/** Stable owning Task identity for provider-side prompt cache isolation. */
	taskNamespace?: string
	compactionApi: ApiHandler
	targetApi: ApiHandler
	targetMode: Mode
	sourceHistory: ClineStorageMessage[]
	/** Canonical API range represented by each source message; synthetic boundary messages are undefined. */
	sourceCanonicalRanges?: Array<CanonicalMessageRange | undefined>
	/** Complete assistant/tool messages excluded from compaction but retained by final canonical commit. */
	targetContinuationHistory?: ClineStorageMessage[]
	/** Pending user/draft content used only for target projection until the ordinary request is admitted. */
	targetContinuationContent?: ClineContent[]
	/** Trigger-owned guidance included in a Pass request but excluded from target projection and canonical commit. */
	passGuidance?: ClineContent[]
	/** Original unsent ordinary input retained by the trigger while compaction is in flight. */
	ordinaryInput?: ClineContent[]
	/** Preserve the ordinary request's context-loading boundary during every target reprojection. */
	includeFileDetails?: boolean
	didSwitchFromPlan?: boolean
	transition?: ContextCompactionTransitionState
	/** Time already spent projecting the trigger-specific source before Session admission. */
	boundaryProjectionMs?: number
	signal?: AbortSignal
}

export interface ContextCompactionPassRequest {
	providerInput: CompactionProviderInput
	explicitInstructions: ExplicitInstructionRequestScope
	initialAttemptId: string
}

export type ContextCompactionPassReview = { action: "accept" } | { action: "regenerate"; feedback: ClineContent[] }

export type ContextCompactionPassRetryEvent =
	| InternalCompactionPassRetryEvent
	| {
			kind: "manual_regeneration"
			failedAttempt: InternalCompactionAttemptIdentity
			nextAttempt: InternalCompactionAttemptIdentity
			feedback: ClineContent[]
	  }

export interface ContextCompactionIndicatorProjection {
	durableContextTokens: number
	pendingSendTokens: number
	environmentTokens: number
	contextWindow: number
	profileId?: string
	profileName?: string
	mode: Mode
}

export type ContextCompactionReprojection = TargetWindowFittingDecision & {
	indicator?: ContextCompactionIndicatorProjection
}

export type ContextCompactionSessionEvent =
	| {
			kind: "pass_preparing"
			state: TargetWindowFittingState
	  }
	| {
			kind: "pass_started"
			state: TargetWindowFittingState
			passIdentity: ReturnType<typeof getCompactionPassIdentity>
			attempt: InternalCompactionAttemptIdentity
			providerInput: CompactionProviderInput
	  }
	| {
			kind: "pass_receiving"
			passIdentity: ReturnType<typeof getCompactionPassIdentity>
			attempt: InternalCompactionAttemptIdentity
			chunk: unknown
	  }
	| {
			kind: "pass_partial"
			passIdentity: ReturnType<typeof getCompactionPassIdentity>
			attempt: InternalCompactionAttemptIdentity
			content: string
	  }
	| {
			kind: "pass_retry"
			state: TargetWindowFittingState
			passIdentity: ReturnType<typeof getCompactionPassIdentity>
			providerInput: CompactionProviderInput
			event: ContextCompactionPassRetryEvent
	  }
	| {
			kind: "pass_completed"
			state: TargetWindowFittingState
			passIdentity: ReturnType<typeof getCompactionPassIdentity>
			attempt: InternalCompactionAttemptIdentity
			projection: ContextCompactionReprojection
			content: string
	  }
	| {
			kind: "summary_refit_preparing"
			state: TargetWindowFittingState
			passIdentity: ReturnType<typeof createSummaryRefitIdentity>
			refitAttempt: number
			carryLimitTokens: number
	  }
	| {
			kind: "summary_refit_started"
			state: TargetWindowFittingState
			passIdentity: ReturnType<typeof createSummaryRefitIdentity>
			attempt: InternalCompactionAttemptIdentity
			providerInput: CompactionProviderInput
			refitAttempt: number
			carryLimitTokens: number
	  }
	| {
			kind: "summary_refit_receiving"
			passIdentity: ReturnType<typeof createSummaryRefitIdentity>
			attempt: InternalCompactionAttemptIdentity
			chunk: unknown
	  }
	| {
			kind: "summary_refit_partial"
			passIdentity: ReturnType<typeof createSummaryRefitIdentity>
			attempt: InternalCompactionAttemptIdentity
			content: string
	  }
	| {
			kind: "summary_refit_retry"
			state: TargetWindowFittingState
			passIdentity: ReturnType<typeof createSummaryRefitIdentity>
			providerInput: CompactionProviderInput
			event: InternalCompactionPassRetryEvent
	  }
	| {
			kind: "summary_refit_completed"
			state: TargetWindowFittingState
			passIdentity: ReturnType<typeof createSummaryRefitIdentity>
			attempt: InternalCompactionAttemptIdentity
			content: string
			refitAttempt: number
			carryLimitTokens: number
	  }
	| { kind: "failed"; state?: TargetWindowFittingState; error: string }

export interface ContextCompactionSessionPorts {
	/** Maximum estimated input one Pass request may carry, including the reserve concession. */
	getPassInputCeiling(input: ContextCompactionSessionInput): number
	/** Summary-safe hard ceiling available only to an indivisible first uncovered logical turn. */
	getSingleTurnInputCeiling?(input: ContextCompactionSessionInput): number
	estimatePassInput(
		input: ContextCompactionSessionInput,
		passHistory: readonly ClineStorageMessage[],
		state: TargetWindowFittingState,
	): Promise<number>
	buildPassRequest(
		input: ContextCompactionSessionInput,
		state: TargetWindowFittingState,
		feedback?: readonly ClineContent[],
		passHistory?: readonly ClineStorageMessage[],
	): Promise<ContextCompactionPassRequest>
	buildSummaryRefitRequest(
		input: ContextCompactionSessionInput,
		state: TargetWindowFittingState,
		carryLimitTokens: number,
		refitAttempt: number,
	): Promise<ContextCompactionPassRequest>
	reviewPass?(
		input: ContextCompactionSessionInput,
		state: TargetWindowFittingState,
		passIdentity: ReturnType<typeof getCompactionPassIdentity>,
		attempt: InternalCompactionAttemptIdentity,
		summary: string,
	): Promise<ContextCompactionPassReview>
	reprojectTarget(input: ContextCompactionSessionInput, state: TargetWindowFittingState): Promise<ContextCompactionReprojection>
	stageAcceptedPass(
		input: ContextCompactionSessionInput,
		state: TargetWindowFittingState,
		projection: ContextCompactionReprojection,
	): Promise<void>
	commit(input: ContextCompactionSessionInput, state: TargetWindowFittingState): Promise<void>
	publish(input: ContextCompactionSessionInput, event: ContextCompactionSessionEvent): Promise<void>
	waitForRetry(input: ContextCompactionSessionInput, retryAttempt: number, signal: AbortSignal): Promise<void>
	recordUsage?(usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }): void
	recordTiming?(timing: ContextCompactionPhaseTiming): void
	providerRequestRounds?: ProviderRequestRoundPort
}

export interface ContextCompactionSessionOptions {
	maxRetryAttempts: number
}

/**
 * Bound on how often one Pass may be replanned against a narrower turn range.
 *
 * Each attempt drops at least one logical turn, so this only limits how long an unfittable history
 * is probed before the measured failure is reported.
 */
const MAX_PASS_RANGE_NARROWING_ATTEMPTS = 8

interface FittedCompactionPass {
	planResult: Awaited<ReturnType<typeof planNextCompactionPass>>
	state: TargetWindowFittingState
	request?: ContextCompactionPassRequest
	requestBuildMs: number
}

/** Own the complete fitting lifecycle shared by every compaction trigger. */
export class ContextCompactionSession {
	private active?: {
		operationId: string
		abortController: AbortController
		input: ContextCompactionSessionInput
		state?: TargetWindowFittingState
		settled: Promise<void>
		settle: () => void
	}

	constructor(
		private readonly ports: ContextCompactionSessionPorts,
		private readonly options: ContextCompactionSessionOptions,
	) {}

	async run(input: ContextCompactionSessionInput): Promise<ContextCompactionSessionResult> {
		if (this.active) return "failed"
		const abortController = new AbortController()
		let settleActive: (() => void) | undefined
		const settled = new Promise<void>((resolve) => {
			settleActive = resolve
		})
		this.active = {
			operationId: input.operationId,
			abortController,
			input,
			settled,
			settle: () => settleActive?.(),
		}
		const signal = combineSignals(input.signal, abortController.signal)
		const sourceSnapshot = createCompactionSourceSnapshot(input.sourceHistory, input.sourceCanonicalRanges, {
			providerId: input.compactionApi.getProviderId?.(),
			modelId: typeof input.compactionApi.getModel === "function" ? input.compactionApi.getModel().id : undefined,
		})
		const logicalTurnIndexStartedAtMs = performance.now()
		const logicalTurnIndex = indexLogicalTurns(sourceSnapshot.messages)
		const logicalTurnIndexMs = elapsedCompactionMs(logicalTurnIndexStartedAtMs)
		let state = tryStartTargetWindowFitting(logicalTurnIndex, input.operationId, sourceSnapshot)
		if (!state) {
			const reason = "No complete logical turn is available for context compaction."
			await this.ports.publish(input, { kind: "failed", error: reason })
			this.active.settle()
			this.active = undefined
			return "failed"
		}
		this.active.state = snapshotFittingState(state)

		let consecutiveSummaryRefitAttempts = 0
		try {
			while (true) {
				try {
					this.assertCurrent(input.operationId, signal)
					await this.ports.publish(input, {
						kind: "pass_preparing",
						state: snapshotFittingState(state),
					})
					const plannerStartedAtMs = performance.now()
					// The planner and the send side can measure the same request differently. Whatever
					// causes the divergence, the range must keep shrinking until a Pass actually fits;
					// reproposing the rejected range would leave the task permanently unable to compact.
					const fitted = await this.planPassWithinSendBudget(input, state, signal)
					const plannerMs = elapsedCompactionMs(plannerStartedAtMs)
					const planResult = fitted.planResult
					this.assertCurrent(input.operationId, signal)
					if (planResult.kind === "summary_carry_overflow" && state.cumulativeSummary) {
						if (consecutiveSummaryRefitAttempts >= MAX_SUMMARY_REFIT_ATTEMPTS) {
							throw new Error(
								formatSummaryRefitFailure(
									planResult,
									consecutiveSummaryRefitAttempts,
									resolveSummaryRefitCarryLimit(planResult),
								),
							)
						}
						consecutiveSummaryRefitAttempts += 1
						state = await this.runSummaryRefit(input, state, planResult, consecutiveSummaryRefitAttempts, signal)
						if (this.active?.operationId === input.operationId) this.active.state = snapshotFittingState(state)
						continue
					}
					if (planResult.kind !== "planned") {
						throw new Error(formatCompactionPlanningFailure(planResult))
					}
					if (!fitted.request) {
						throw new Error("Compaction Pass was planned without a request")
					}
					state = fitted.state
					const plannedState = state
					if (this.active?.operationId === input.operationId) this.active.state = snapshotFittingState(state)

					const passIdentity = getCompactionPassIdentity(state)
					const requestBuildMs = fitted.requestBuildMs
					let request: ContextCompactionPassRequest = fitted.request
					this.assertCurrent(input.operationId, signal)
					let attemptIndex = 0
					const initialAttempt: InternalCompactionAttemptIdentity = {
						attemptIndex,
						authorizationAttemptId: request.initialAttemptId,
					}
					await this.ports.publish(input, {
						kind: "pass_started",
						state: snapshotFittingState(state),
						passIdentity,
						attempt: initialAttempt,
						providerInput: request.providerInput,
					})
					let projection: ContextCompactionReprojection | undefined
					try {
						while (true) {
							const providerRequestRound = this.ports.providerRequestRounds?.admit({ source: "compaction" })
							const result = await runInternalCompactionPassWithRetry({
								api: input.compactionApi,
								providerInput: request.providerInput,
								explicitInstructions: request.explicitInstructions,
								taskNamespace: input.taskNamespace,
								providerRequestRound,
								passIdentity,
								...createPassRetryScope(input.trigger, this.options.maxRetryAttempts),
								initialAttemptIndex: attemptIndex,
								attemptIdFactory: (candidateAttemptIndex) =>
									candidateAttemptIndex === attemptIndex
										? request.initialAttemptId
										: `fitting:${input.operationId}:${passIdentity.passIndex}:attempt:${candidateAttemptIndex}`,
								waitForRetry: async (retryAttempt) => {
									this.assertCurrent(input.operationId, signal)
									await this.ports.waitForRetry(input, retryAttempt, signal)
								},
								onRetry: async (event) => {
									this.assertCurrent(input.operationId, signal)
									await this.ports.publish(input, {
										kind: "pass_retry",
										state: snapshotFittingState(plannedState),
										passIdentity,
										providerInput: request.providerInput,
										event,
									})
								},
								onChunk: async (chunk, attempt) => {
									this.assertCurrent(input.operationId, signal)
									await this.ports.publish(input, {
										kind: "pass_receiving",
										passIdentity,
										attempt,
										chunk: cloneDeep(chunk),
									})
								},
								onSummaryUpdate: async (content, attempt) => {
									this.assertCurrent(input.operationId, signal)
									await this.ports.publish(input, {
										kind: "pass_partial",
										passIdentity,
										attempt,
										content,
									})
								},
							})
							this.completeProviderExecution(result, providerRequestRound)
							this.assertCurrent(input.operationId, signal)
							const completedAttempt: InternalCompactionAttemptIdentity = {
								attemptIndex: result.attemptIndex,
								authorizationAttemptId: result.authorizationAttemptId,
							}
							const review = this.ports.reviewPass
								? await this.ports.reviewPass(input, state, passIdentity, completedAttempt, result.summary)
								: ({ action: "accept" } as const)
							this.assertCurrent(input.operationId, signal)
							if (review.action === "regenerate") {
								request.explicitInstructions.close()
								const nextRequest = await this.ports.buildPassRequest(
									input,
									state,
									review.feedback,
									planResult.passHistory,
								)
								const nextAttempt: InternalCompactionAttemptIdentity = {
									attemptIndex: result.attemptIndex + 1,
									authorizationAttemptId: nextRequest.initialAttemptId,
								}
								await this.ports.publish(input, {
									kind: "pass_retry",
									state: snapshotFittingState(state),
									passIdentity,
									providerInput: nextRequest.providerInput,
									event: {
										kind: "manual_regeneration",
										failedAttempt: completedAttempt,
										nextAttempt,
										feedback: cloneDeep(review.feedback),
									},
								})
								request = nextRequest
								attemptIndex = nextAttempt.attemptIndex
								continue
							}

							const nextState = acceptCompactionPass(state, result.summary).state
							const reprojectionStartedAtMs = performance.now()
							projection = await this.ports.reprojectTarget(input, snapshotFittingState(nextState))
							const reprojectionMs = elapsedCompactionMs(reprojectionStartedAtMs)
							this.assertCurrent(input.operationId, signal)
							await this.ports.stageAcceptedPass(input, nextState, projection)
							this.assertCurrent(input.operationId, signal)
							state = nextState
							consecutiveSummaryRefitAttempts = 0
							if (this.active?.operationId === input.operationId) this.active.state = snapshotFittingState(state)
							await this.ports.publish(input, {
								kind: "pass_completed",
								state: snapshotFittingState(state),
								passIdentity,
								attempt: completedAttempt,
								projection,
								content: result.summary,
							})
							this.recordAcceptedPassUsage(result)
							this.ports.recordTiming?.({
								operationId: input.operationId,
								passIndex: passIdentity.passIndex,
								boundaryProjectionMs: input.boundaryProjectionMs ?? 0,
								logicalTurnIndexMs,
								plannerMs,
								candidateEstimateCount: planResult.plan.candidateEstimateCount,
								requestBuildMs,
								providerTtfbMs: result.timing.providerTtfbMs,
								streamMs: result.timing.streamMs,
								reprojectionMs,
							})
							request.explicitInstructions.close()
							break
						}
					} catch (error) {
						request.explicitInstructions.cancel()
						throw error
					}

					if (!projection) throw new Error("Accepted compaction Pass is missing its target reprojection.")
					const decision = projection
					if (decision.status === "complete") {
						await this.ports.commit(input, state)
						return "completed"
					}
					if (decision.status === "exhausted") {
						throw new Error(
							`Context compaction could not fit the complete target request below the required 80% exit target of ${decision.fittingExitTarget} tokens for the effective context limit ${decision.effectiveContextLimit}, because no complete logical turn remains.`,
						)
					}
				} catch (error) {
					if (signal.aborted) throw signal.reason ?? error
					throw error
				}
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			await this.ports.publish(input, { kind: "failed", state: snapshotFittingState(state), error: reason })
			return signal.aborted ? "cancelled" : "failed"
		} finally {
			const active = this.active?.operationId === input.operationId ? this.active : undefined
			active?.settle()
			if (this.active === active) this.active = undefined
		}
	}

	cancel(operationId: string, reason = "Context compaction cancelled."): void {
		if (this.active?.operationId === operationId && !this.active.abortController.signal.aborted) {
			this.active.abortController.abort(new Error(reason))
			this.active.input.compactionApi.abort?.()
		}
	}

	getActiveOperationId(): string | undefined {
		return this.active?.operationId
	}

	/**
	 * Plan a Pass the send side will actually accept.
	 *
	 * The planner selects a range using its own estimate; building the request applies the
	 * send-side budget. When the two disagree the request is refused, and reproposing the same
	 * range would repeat that refusal forever. The two sides measure in different units, so the
	 * refused size cannot be subtracted from the planner's ceiling; the range itself is narrowed
	 * instead. Dropping at least one logical turn per refusal shrinks monotonically towards the
	 * single-turn case, which the planner reports as its own overflow outcome.
	 */
	private async planPassWithinSendBudget(
		input: ContextCompactionSessionInput,
		state: TargetWindowFittingState,
		signal: AbortSignal,
	): Promise<FittedCompactionPass> {
		const passInputCeiling = this.ports.getPassInputCeiling(input)
		const singleTurnInputCeiling = this.ports.getSingleTurnInputCeiling?.(input)
		let maxEndTurnIndex: number | undefined

		for (let attempt = 0; ; attempt++) {
			const planResult = await planNextCompactionPass({
				state,
				passInputCeiling,
				...(singleTurnInputCeiling === undefined ? {} : { singleTurnInputCeiling }),
				...(maxEndTurnIndex === undefined ? {} : { maxEndTurnIndex }),
				estimateInputTokens: (passHistory) => this.ports.estimatePassInput(input, passHistory, state),
			})
			this.assertCurrent(input.operationId, signal)
			if (planResult.kind !== "planned") {
				return { planResult, state, request: undefined, requestBuildMs: 0 }
			}

			const plannedState = applyCompactionPassPlan(state, planResult.plan)
			const requestBuildStartedAtMs = performance.now()
			try {
				const request = await this.ports.buildPassRequest(
					input,
					plannedState,
					cloneDeep(input.passGuidance ?? []),
					planResult.passHistory,
				)
				return {
					planResult,
					state: plannedState,
					request,
					requestBuildMs: elapsedCompactionMs(requestBuildStartedAtMs),
				}
			} catch (error) {
				const refusedEndTurnIndex = planResult.plan.passEndTurnIndex
				const canNarrow =
					isCompactionPassBudgetError(error) &&
					refusedEndTurnIndex > planResult.plan.passStartTurnIndex &&
					attempt < MAX_PASS_RANGE_NARROWING_ATTEMPTS
				if (!canNarrow) throw error
				maxEndTurnIndex = refusedEndTurnIndex - 1
			}
		}
	}

	private async runSummaryRefit(
		input: ContextCompactionSessionInput,
		state: TargetWindowFittingState,
		overflow: SummaryCarryOverflow,
		refitAttempt: number,
		signal: AbortSignal,
	): Promise<TargetWindowFittingState> {
		const carryLimitTokens = resolveSummaryRefitCarryLimit(overflow)
		if (carryLimitTokens <= 0) {
			throw new Error(formatSummaryRefitFailure(overflow, refitAttempt - 1, carryLimitTokens))
		}
		const passIdentity = createSummaryRefitIdentity(state, refitAttempt - 1)
		await this.ports.publish(input, {
			kind: "summary_refit_preparing",
			state: snapshotFittingState(state),
			passIdentity,
			refitAttempt,
			carryLimitTokens,
		})
		const request = await this.ports.buildSummaryRefitRequest(input, state, carryLimitTokens, refitAttempt)
		const initialAttempt: InternalCompactionAttemptIdentity = {
			attemptIndex: 0,
			authorizationAttemptId: request.initialAttemptId,
		}
		await this.ports.publish(input, {
			kind: "summary_refit_started",
			state: snapshotFittingState(state),
			passIdentity,
			attempt: initialAttempt,
			providerInput: request.providerInput,
			refitAttempt,
			carryLimitTokens,
		})
		try {
			const providerRequestRound = this.ports.providerRequestRounds?.admit({ source: "compaction" })
			const result = await runInternalCompactionPassWithRetry({
				api: input.compactionApi,
				providerInput: request.providerInput,
				explicitInstructions: request.explicitInstructions,
				taskNamespace: input.taskNamespace,
				providerRequestRound,
				passIdentity,
				...createPassRetryScope(input.trigger, this.options.maxRetryAttempts),
				attemptIdFactory: (attemptIndex) =>
					attemptIndex === 0
						? request.initialAttemptId
						: `fitting:${input.operationId}:refit:${refitAttempt}:attempt:${attemptIndex}`,
				waitForRetry: async (retryAttempt) => {
					this.assertCurrent(input.operationId, signal)
					await this.ports.waitForRetry(input, retryAttempt, signal)
				},
				onRetry: async (event) => {
					this.assertCurrent(input.operationId, signal)
					await this.ports.publish(input, {
						kind: "summary_refit_retry",
						state: snapshotFittingState(state),
						passIdentity,
						providerInput: request.providerInput,
						event,
					})
				},
				onChunk: async (chunk, attempt) => {
					this.assertCurrent(input.operationId, signal)
					await this.ports.publish(input, {
						kind: "summary_refit_receiving",
						passIdentity,
						attempt,
						chunk: cloneDeep(chunk),
					})
				},
				onSummaryUpdate: async (content, attempt) => {
					this.assertCurrent(input.operationId, signal)
					await this.ports.publish(input, {
						kind: "summary_refit_partial",
						passIdentity,
						attempt,
						content,
					})
				},
			})
			this.completeProviderExecution(result, providerRequestRound)
			this.assertCurrent(input.operationId, signal)
			let nextState: TargetWindowFittingState
			try {
				nextState = refitCompactionSummary(state, result.summary)
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				throw new Error(
					`${formatSummaryRefitFailure(overflow, refitAttempt, carryLimitTokens)} ` +
						`Refit output was rejected: ${reason}`,
				)
			}
			const completedAttempt: InternalCompactionAttemptIdentity = {
				attemptIndex: result.attemptIndex,
				authorizationAttemptId: result.authorizationAttemptId,
			}
			await this.ports.publish(input, {
				kind: "summary_refit_completed",
				state: snapshotFittingState(nextState),
				passIdentity,
				attempt: completedAttempt,
				content: result.summary,
				refitAttempt,
				carryLimitTokens,
			})
			this.recordAcceptedPassUsage(result)
			request.explicitInstructions.close()
			return nextState
		} catch (error) {
			request.explicitInstructions.cancel()
			throw error
		}
	}

	private completeProviderExecution(
		result: Awaited<ReturnType<typeof runInternalCompactionPassWithRetry>>,
		providerRequestRound?: ProviderRequestRoundAdmission,
	): void {
		if (!result.settlement) {
			providerRequestRound?.completeProviderOnly()
			return
		}
		void result.settlement.catch(() => undefined).finally(() => providerRequestRound?.completeProviderOnly())
	}

	private recordAcceptedPassUsage(result: Awaited<ReturnType<typeof runInternalCompactionPassWithRetry>>): void {
		if (!result.settlement) {
			if (result.usage) this.ports.recordUsage?.(result.usage)
			return
		}
		void result.settlement
			.then((settlement) => {
				const usage = settlement.usage ?? result.usage
				if (usage) this.ports.recordUsage?.(usage)
			})
			.catch(() => undefined)
	}

	private assertCurrent(operationId: string, signal: AbortSignal): void {
		if (signal.aborted) throw signal.reason ?? new Error("Context compaction cancelled.")
		if (this.active?.operationId !== operationId) throw new Error("Context compaction operation became stale.")
	}
}

function snapshotFittingState(state: TargetWindowFittingState): TargetWindowFittingState {
	return { ...state }
}

function formatCompactionPlanningFailure(
	result: Exclude<Awaited<ReturnType<typeof planNextCompactionPass>>, { kind: "planned" }>,
): string {
	const breakdown =
		`request envelope ${result.requestEnvelopeTokens}, summary carry ${result.summaryCarryTokens}, ` +
		`logical turn ${result.turnTokens}, combined ${result.combinedEstimatedInputTokens}, ` +
		`Pass ceiling ${result.passInputCeiling}`
	return result.kind === "summary_carry_overflow"
		? `The cumulative compaction summary cannot be carried into Pass ${result.turnIndex + 1} (${breakdown}).`
		: `Logical turn ${result.turnIndex + 1} cannot fit in one compaction Pass without content truncation (${breakdown}).`
}

/** A user-started Pass retries only summaries the model failed to produce, and only twice. */
const MANUAL_UNUSABLE_SUMMARY_RETRY_ATTEMPTS = 2

type PassRetryScope = Pick<
	RunInternalCompactionPassWithRetryInput,
	"retryPolicy" | "retryableFailure" | "allowOpenAiMaxOutputReplay"
>

/**
 * Select the Pass retry budget for one trigger.
 *
 * Manual compaction keeps transient failures user-visible, but an answer without summarize_task is
 * replayed with a correction because the user explicitly asked for a summary.
 */
function createPassRetryScope(trigger: ContextCompactionTriggerKind, automaticMaxRetryAttempts: number): PassRetryScope {
	if (!isManualTrigger(trigger)) {
		return { retryPolicy: new CompactionRetryPolicy(automaticMaxRetryAttempts), allowOpenAiMaxOutputReplay: true }
	}
	return {
		retryPolicy: new CompactionRetryPolicy(MANUAL_UNUSABLE_SUMMARY_RETRY_ATTEMPTS),
		retryableFailure: isUnusableCompactionSummaryError,
		allowOpenAiMaxOutputReplay: false,
	}
}

function isManualTrigger(trigger: ContextCompactionTriggerKind): boolean {
	return trigger === "task_header" || trigger === "manual_compact_command"
}

function combineSignals(primary: AbortSignal | undefined, secondary: AbortSignal): AbortSignal {
	if (!primary) return secondary
	if (primary.aborted) return primary
	if (secondary.aborted) return secondary
	const controller = new AbortController()
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason)
	}
	primary.addEventListener("abort", () => abort(primary), { once: true })
	secondary.addEventListener("abort", () => abort(secondary), { once: true })
	return controller.signal
}
