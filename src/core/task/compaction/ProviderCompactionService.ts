import { randomUUID } from "node:crypto"
import { createCompactionConversationRange } from "@core/context/context-management/compaction-conversation-range"
import { CompactionPassBudgetError } from "@core/context/context-management/compaction-pass-budget-error"
import { resolveCompactionWindowBudget } from "@core/context/context-management/compaction-window-budget"
import { estimateContextWindowCandidate } from "@core/context/context-management/context-window-projection"
import {
	COMPACTION_CLOSURE_RESERVE_TOKENS,
	type CompactTriggerOptions,
	computeSummarizeBudget,
	getContextWindowInfo,
	MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
	resolveCompactTriggerPolicy,
} from "@core/context/context-management/context-window-utils"
import { buildSummaryRefitGuidance } from "@core/context/context-management/summary-refit"
import { decideTargetWindowFitting } from "@core/context/context-management/TargetWindowFittingService"
import {
	buildCompactionPassHistory,
	buildTargetCandidateHistory,
	type TargetWindowFittingState,
} from "@core/context/context-management/target-window-fitting"
import type { ClineContent, ClineStorageMessage } from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import { getRetryDelay, MAX_AUTO_RETRY_ATTEMPTS } from "../auto-retry-schedule"
import {
	type ContextCompactionIndicatorProjection,
	type ContextCompactionPassRequest,
	ContextCompactionSession,
	type ContextCompactionSessionInput,
	type ContextCompactionSessionPorts,
	type ContextCompactionTriggerKind,
} from "../ContextCompactionSession"
import { estimateContextWindowIndicatorSegments } from "../ContextWindowIndicatorProjection"
import { CompactionRunFailedError } from "../executors/compaction/CompactionCommandExecutor"
import type { ProductionCompactionService } from "../executors/compaction/ProductionCompactionAdapter"
import { repairProviderPairing } from "../executors/provider/service/ProviderPairingRepair"
import type { ProviderRequestFrame, ProviderRequestFramePort } from "../executors/provider/service/ProviderRequest"
import { ExplicitInstructionRegistry } from "../explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "../explicit-instructions/ExplicitInstructionRequestScope"
import type { CompactionTrigger } from "../stores/payload/TaskPayloadEnvelopes"
import type { CompactionRequestScopeReader } from "./CompactionRequestScopes"
import type { CompactionProgressPort } from "./MessageStateCompactionCards"

/** The environment block the next request would carry, rendered without consuming what it reports. */
export interface CompactionEnvironmentPreview {
	preview(input: { readonly signal: AbortSignal }): Promise<string | undefined>
}

/** Receives the next request each accepted Pass projects, for the context-window indicator. */
export interface CompactionIndicatorPort {
	passProjected(compactionId: string, projection: ContextCompactionIndicatorProjection): void
}

export interface ProviderCompactionServiceOptions {
	/** The frame ordinary requests use; compaction must share it to keep the provider prefix cache. */
	readonly frames: ProviderRequestFramePort
	/**
	 * Renders the summarize instruction appended after the source conversation.
	 *
	 * It receives the resolved frame because the instruction must describe the
	 * same prompt profile the frame's system prompt was rendered for, and the
	 * window budget block the instruction must state to the model.
	 */
	readonly instruction: (frame: ProviderRequestFrame, budgetGuidance: string) => string
	/** The auto-condense settings; absent means the provider window alone bounds the request. */
	readonly triggerOptions?: () => CompactTriggerOptions
	/**
	 * The handler a run is sent under when it is not the task's own, as for a
	 * context transition that compacts for the target it is about to adopt.
	 */
	readonly scopes?: CompactionRequestScopeReader
	/** Pause before an automatic retry of a failed Pass; defaults to the task retry schedule. */
	readonly waitForRetry?: (retryAttempt: number, signal: AbortSignal) => Promise<void>
	/** Shows the run while it works: each Pass, and a Pass that broke off and is sent again. */
	readonly progress?: CompactionProgressPort
	/** Adds the environment block to the measured next request; absent in headless assemblies. */
	readonly environment?: CompactionEnvironmentPreview
	/** Shows each accepted Pass's projected next request; absent in headless assemblies. */
	readonly indicator?: CompactionIndicatorPort
}

interface CompactionContext {
	readonly sourceHistory: ClineStorageMessage[]
	/** Journal position of each source message; absent in contexts written before partial landing. */
	readonly sourceRanges?: ReadonlyArray<readonly [number, number]>
	/** Visible messages after the span, carried by the next request after the summary. */
	readonly tail?: ClineStorageMessage[]
	/** Caller-imposed ceiling on the summary; the window budget still applies below it. */
	readonly maxOutputTokens?: number
	/** What the user asked this summary to keep; part of this request only. */
	readonly guidance?: string
	/** Why the user rejected the previous summary; part of the regenerated request only. */
	readonly feedback?: string
}

/** What a completed run hands to landing. */
export interface ProviderCompactionResult {
	readonly summary: string
	/**
	 * Journal seq of the last message the summary stands for.
	 *
	 * Earlier than the span end when summarizing the oldest turns already made
	 * the next request fit: the turns after it stay verbatim.
	 */
	readonly coveredThrough?: number
}

function isCompactionContext(value: unknown): value is CompactionContext {
	return Boolean(value && typeof value === "object" && Array.isArray((value as { sourceHistory?: unknown }).sourceHistory))
}

/**
 * The user's words that ride on every Pass of this run and never on the target.
 *
 * Regeneration feedback replaces `/compact` guidance rather than adding to it,
 * so the request is steered by the user's latest word on the summary.
 */
function passGuidanceOf(context: CompactionContext): ClineContent[] {
	if (context.feedback?.trim()) {
		return [{ type: "text", text: `<summary_feedback>\n${context.feedback.trim()}\n</summary_feedback>` }]
	}
	if (context.guidance?.trim()) return [{ type: "text", text: `<user_guidance>\n${context.guidance.trim()}\n</user_guidance>` }]
	return []
}

/**
 * The closing message of a Pass: the instruction with the run's words folded in.
 *
 * Guidance and feedback are never a turn of their own, so their text joins the
 * instruction rather than standing as a block a model could answer by itself.
 * Anything that is not text, such as an attached image, stays its own block.
 */
function closingContentOf(instruction: string, closing: readonly ClineContent[]): ClineContent[] {
	const texts = closing.flatMap((block) => (block.type === "text" ? [block.text] : []))
	const others = closing.filter((block) => block.type !== "text")
	return [{ type: "text", text: [instruction, ...texts].join("\n\n") }, ...others]
}

/** A manual run is reviewed by the user, so a failure is theirs to retry rather than the run's. */
function sessionTriggerOf(trigger: CompactionTrigger | undefined): ContextCompactionTriggerKind {
	return trigger === "manual" ? "manual_compact_command" : "auto_compaction"
}

function smallestLimit(...limits: Array<number | undefined>): number | undefined {
	const defined = limits.filter((limit): limit is number => typeof limit === "number" && Number.isFinite(limit) && limit > 0)
	return defined.length > 0 ? Math.min(...defined) : undefined
}

/** Wait for one retry delay, ending early with the run when it is stopped. */
function delayRetry(retryAttempt: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason)
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolve()
		}, getRetryDelay(retryAttempt))
		signal.addEventListener("abort", onAbort, { once: true })
	})
}

/**
 * Runs one compaction as a sequence of hidden Passes outside the ordinary turn stream.
 *
 * Each Pass is the ordinary request's frame - the same handler, system prompt,
 * tools and task namespace - followed by the cumulative summary, the oldest
 * turns not yet summarized, and the summarize instruction. Passes continue
 * turn by turn until the next request projected from the summary and the
 * remaining turns fits below 80% of the effective window, so a conversation
 * larger than one request is condensed without dropping any turn and a
 * conversation that only just overflowed keeps its recent turns verbatim.
 */
export class ProviderCompactionService implements ProductionCompactionService {
	/** One registry per task: every Pass request authorizes exactly one summarize_task consumption. */
	private readonly registry = new ExplicitInstructionRegistry()

	constructor(private readonly options: ProviderCompactionServiceOptions) {}

	async run(input: Parameters<ProductionCompactionService["run"]>[0]): Promise<unknown> {
		if (!isCompactionContext(input.context)) throw new Error("InvalidCompactionContext")
		if (input.signal.aborted) throw input.signal.reason
		const scope = this.options.scopes?.resolve(input.compactionId)
		const frame = await this.options.frames.frame(input.signal, scope)
		// A stop during frame resolution happened before the listener below exists.
		if (input.signal.aborted) throw input.signal.reason
		const context = input.context
		const outcome: { committed?: TargetWindowFittingState; failure?: string } = {}
		const session = new ContextCompactionSession(this.ports(frame, context, input, outcome), {
			maxRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS,
		})
		// The session checks its signal between steps; aborting the handler is
		// what ends a provider stream that is already running.
		const abort = () => session.cancel(input.compactionId)
		input.signal.addEventListener("abort", abort, { once: true })
		try {
			const result = await session.run(this.sessionInput(frame, context, input, scope?.mode))
			if (input.signal.aborted) throw input.signal.reason
			const summary = outcome.committed?.cumulativeSummary
			if (result !== "completed" || !outcome.committed || !summary) {
				throw new CompactionRunFailedError(outcome.failure ?? "Context compaction did not complete.")
			}
			const coveredThrough = coveredSeq(outcome.committed, context)
			return coveredThrough === undefined ? { summary } : { summary, coveredThrough }
		} finally {
			// The cards stay: the landed summary or the failure card takes over the
			// last one, and the run's owner withdraws them when neither comes.
			input.signal.removeEventListener("abort", abort)
		}
	}

	private sessionInput(
		frame: ProviderRequestFrame,
		context: CompactionContext,
		input: Parameters<ProductionCompactionService["run"]>[0],
		mode: ContextCompactionSessionInput["targetMode"] | undefined,
	): ContextCompactionSessionInput {
		const ranges = context.sourceRanges
		return {
			operationId: input.compactionId,
			trigger: sessionTriggerOf(input.trigger),
			taskNamespace: frame.options?.taskNamespace,
			compactionApi: frame.api,
			targetApi: frame.api,
			// Only the ports below read the Mode, and they read the frame instead.
			targetMode: mode ?? "act",
			sourceHistory: context.sourceHistory,
			...(ranges && ranges.length === context.sourceHistory.length
				? { sourceCanonicalRanges: ranges.map(([from, to]) => [from, to] as const) }
				: {}),
			targetContinuationHistory: context.tail ?? [],
			passGuidance: passGuidanceOf(context),
			signal: input.signal,
		}
	}

	private ports(
		frame: ProviderRequestFrame,
		context: CompactionContext,
		input: Parameters<ProductionCompactionService["run"]>[0],
		outcome: { committed?: TargetWindowFittingState; failure?: string },
	): ContextCompactionSessionPorts {
		const estimator = { providerId: frame.api.getProviderId?.(), modelId: frame.api.getModel().id }
		const policy = () =>
			resolveCompactTriggerPolicy(
				getContextWindowInfo(frame.api).contextWindow,
				computeSummarizeBudget(),
				this.options.triggerOptions?.(),
			)
		return {
			getPassInputCeiling: () => policy().passInputCeilingTokens,
			// Only an indivisible turn may use the window up to the closure reserve.
			getSingleTurnInputCeiling: () =>
				Math.max(
					0,
					policy().hardPassContextWindowTokens -
						COMPACTION_CLOSURE_RESERVE_TOKENS -
						MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
				),
			estimatePassInput: async (sessionInput, passHistory) => {
				const request = this.passRequest(frame, sessionInput, passHistory, undefined, undefined, "estimate")
				try {
					return estimateContextWindowCandidate(request.providerInput, estimator)
				} finally {
					request.explicitInstructions.cancel()
				}
			},
			buildPassRequest: async (sessionInput, state, feedback, passHistory) =>
				this.passRequest(
					frame,
					sessionInput,
					passHistory ?? buildCompactionPassHistory(state),
					feedback,
					smallestLimit(state.nextPassSummaryCarryLimitTokens, context.maxOutputTokens),
					"send",
				),
			buildSummaryRefitRequest: async (sessionInput, state, carryLimitTokens, refitAttempt) => {
				if (!state.cumulativeSummary) throw new Error("Summary refit requires an existing cumulative summary")
				return this.passRequest(
					frame,
					sessionInput,
					[{ role: "user", content: [{ type: "text", text: state.cumulativeSummary }] }],
					[{ type: "text", text: buildSummaryRefitGuidance(carryLimitTokens, refitAttempt) }],
					carryLimitTokens,
					"send",
				)
			},
			reprojectTarget: async (sessionInput, state) => {
				// Measured as it would be sent, as dev does: the next request carries
				// a fresh environment block, and tool pairing is repaired before
				// estimating so an orphaned result in the kept tail is not counted.
				const environment = await this.options.environment?.preview({ signal: sessionInput.signal ?? input.signal })
				const continuation: ClineStorageMessage[] = environment
					? [{ role: "user", content: [{ type: "text", text: environment }], ts: Date.now() }]
					: []
				const messages = repairProviderPairing(
					buildTargetCandidateHistory(state, [...(context.tail ?? []), ...continuation]),
				)
				const providerInput = {
					systemPrompt: frame.systemPrompt,
					messages,
					tools: frame.tools,
					serverTools: frame.options?.serverTools ?? [],
				}
				const contextWindow = getContextWindowInfo(frame.api).contextWindow
				const decision = decideTargetWindowFitting({
					candidateEstimatedTokens: estimateContextWindowCandidate(providerInput, estimator),
					providerContextWindow: contextWindow,
					...this.options.triggerOptions?.(),
					hasMoreTurns: state.coveredTurnCount < state.turns.length,
				})
				const segments = estimateContextWindowIndicatorSegments({
					providerInput,
					durableMessageCount: Math.max(0, messages.length - continuation.length),
					...estimator,
				})
				return {
					...decision,
					indicator: {
						durableContextTokens: segments.durableContextTokens,
						pendingSendTokens: segments.pendingSendTokens,
						environmentTokens: segments.environmentTokens,
						contextWindow,
						mode: sessionInput.targetMode,
					},
				}
			},
			stageAcceptedPass: async () => {},
			commit: async (_sessionInput, state) => {
				outcome.committed = { ...state }
			},
			publish: async (_sessionInput, event) => {
				if (event.kind === "failed") outcome.failure = event.error
				if (event.kind === "pass_completed" && event.projection.indicator) {
					this.options.indicator?.passProjected(input.compactionId, event.projection.indicator)
				}
				if (await this.options.progress?.present(input.compactionId, event)) this.republish(input)
			},
			waitForRetry: (_sessionInput, retryAttempt, signal) =>
				(this.options.waitForRetry ?? delayRetry)(retryAttempt, signal),
		}
	}

	/** Ask the task view to redraw, so a progress step reaches the chat. */
	private republish(input: Parameters<ProductionCompactionService["run"]>[0]): void {
		input.publish({ kind: "compaction_progress", compactionId: input.compactionId, attempt: input.attempt })
	}

	/**
	 * Build one hidden Pass request on the ordinary frame.
	 *
	 * The closing message carries the instruction, the window budget the model
	 * must respect, and this run's guidance. Every request gets its own explicit
	 * instruction scope, so each Pass authorizes exactly one summary.
	 */
	private passRequest(
		frame: ProviderRequestFrame,
		input: ContextCompactionSessionInput,
		passHistory: readonly ClineStorageMessage[],
		feedback: readonly ClineContent[] | undefined,
		summaryOutputLimitTokens: number | undefined,
		purpose: "send" | "estimate",
	): ContextCompactionPassRequest {
		const scope = new ExplicitInstructionRequestScope(this.registry, { requestId: randomUUID(), attemptId: randomUUID() })
		scope.register({
			type: "summarize_task",
			source: input.trigger,
			targetTool: ClineDefaultTool.SUMMARIZE_TASK,
			operationId: input.operationId,
		})
		try {
			const ts = Date.now()
			const closing = feedback ?? input.passGuidance ?? []
			const buildMessages = (budgetGuidance: string): ClineStorageMessage[] => [
				...passHistory,
				{
					role: "user",
					content: closingContentOf(this.options.instruction(frame, budgetGuidance), closing),
					ts,
				},
			]
			const policy = resolveCompactTriggerPolicy(
				getContextWindowInfo(frame.api).contextWindow,
				computeSummarizeBudget(),
				this.options.triggerOptions?.(),
			)
			const serverTools = frame.options?.serverTools ?? []
			const model = frame.api.getModel()
			const { budget, messages } = resolveCompactionWindowBudget({
				contextWindow: policy.hardPassContextWindowTokens,
				maxOutputTokens: model.info.capabilities?.maxTokens,
				summaryOutputLimitTokens,
				systemPrompt: frame.systemPrompt,
				tools: frame.tools,
				serverTools,
				closureReserveTokens: COMPACTION_CLOSURE_RESERVE_TOKENS,
				// The planner sizes the Pass range with this same estimator; measuring
				// differently here would refuse a range the planner cannot shrink.
				estimator: { providerId: frame.api.getProviderId?.(), modelId: model.id },
				buildMessages,
			})
			if (
				budget.decision !== "ready" &&
				purpose === "send" &&
				budget.estimatedInputTokens > policy.passInputCeilingTokens
			) {
				// Structured so the session narrows the range with the measurement
				// that refused it instead of reproposing the same range.
				throw new CompactionPassBudgetError({
					estimatedInputTokens: budget.estimatedInputTokens,
					contextWindow: policy.hardPassContextWindowTokens,
					availableRemainder: budget.availableRemainder,
					estimatedTextTokens: budget.estimatedTextTokens,
					estimatedImageTokens: budget.estimatedImageTokens,
				})
			}
			return {
				providerInput: {
					systemPrompt: frame.systemPrompt,
					messages,
					tools: frame.tools,
					serverTools,
					providerOutputCap: budget.providerOutputCap,
				},
				explicitInstructions: scope,
				initialAttemptId: scope.createConsumePort().identity.attemptId,
			}
		} catch (error) {
			scope.cancel()
			throw error
		}
	}
}

/** Journal seq of the last summarized message, when the context recorded where its messages live. */
function coveredSeq(state: TargetWindowFittingState, context: CompactionContext): number | undefined {
	const last = context.sourceRanges?.at(-1)
	if (!last || context.sourceRanges?.length !== context.sourceHistory.length) return undefined
	return createCompactionConversationRange(state, last[1]).apiConversationRange[1]
}
