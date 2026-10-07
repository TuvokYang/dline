import type { ApiHandler } from "@core/api"
import { isOutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import { createIdentityFactory } from "@core/api/transform/block-identity"
import type { ApiProviderStreamChunk } from "@core/api/transform/stream"
import { parseAssistantMessageV2, type ToolUse } from "@core/assistant-message"
import type { CompactionProviderInput } from "@core/task/compaction/CompactionProviderInput"
import type { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import type { ProviderRequestRoundAdmission } from "@core/task/performance/provider-request-round-port"
import { TaskRequestUsageTracker } from "@core/task/TaskRequestUsageTracker"
import type { CompactionSummaryFailureKind } from "@shared/context-compaction-failure"
import { ClineDefaultTool } from "@shared/tools"
import cloneDeep from "clone-deep"
import {
	type CompactionAttemptDiagnostics,
	type CompactionAttemptNextAction,
	CompactionReplyObservation,
	type InternalCompactionUsage,
} from "./compaction-attempt-diagnostics"
import {
	CompactionAuthorizationError,
	type CompactionFailureKind,
	CompactionSummaryRejectedError,
	classifyCompactionFailure,
	classifySummarizeTaskReply,
	isCorrectableCompactionFailure,
	toReminderKind,
	withCompactionRetryReminder,
} from "./compaction-attempt-failure"
import type { InternalCompactionProviderTiming } from "./compaction-phase-timing"
import { elapsedCompactionMs } from "./compaction-phase-timing"
import type { CompactionRetryPolicy } from "./compaction-retry-policy"
import { isRetryableCompactionError } from "./compaction-retryability"
import type { CompactionPassIdentity } from "./target-window-fitting"

export type { CompactionAttemptDiagnostics, InternalCompactionUsage } from "./compaction-attempt-diagnostics"

export interface InternalCompactionPassResult {
	summary: string
	/** Ordered checklist the model reported inside the accepted block, when focus chain is enabled. */
	taskProgress?: string
	usage?: InternalCompactionUsage
	timing: InternalCompactionProviderTiming
}

export interface RunInternalCompactionPassInput {
	api: ApiHandler
	providerInput: CompactionProviderInput
	explicitInstructions: ExplicitInstructionRequestScope
	taskNamespace?: string
	attemptId?: string
	providerRequestRound?: ProviderRequestRoundAdmission
	taskAttempt?: number
	/** Every accepted Provider chunk, before summary parsing, for request lifecycle observers. */
	onChunk?(chunk: unknown): void | Promise<void>
	/** Streamed summary snapshots delivered without retry lifecycle state. */
	onSummaryUpdate?(context: string): void | Promise<void>
	/** Content-free outcome of this attempt, reported exactly once before it returns or throws. */
	onAttemptSettled?(diagnostics: CompactionAttemptDiagnostics): void
}

export interface InternalCompactionAttemptIdentity {
	attemptIndex: number
	authorizationAttemptId: string
}

export interface InternalCompactionPassAttemptResult extends InternalCompactionPassResult, InternalCompactionAttemptIdentity {}

export type InternalCompactionPassRetryEvent =
	| {
			kind: "pass_retry"
			retryAttempt: number
			maxRetryAttempts: number
			failedAttempt: InternalCompactionAttemptIdentity
			nextAttempt: InternalCompactionAttemptIdentity
			failureKind: CompactionFailureKind
			error: unknown
	  }
	| {
			kind: "openai_max_output_replay"
			providerOutputCap: number
			failedAttempt: InternalCompactionAttemptIdentity
			nextAttempt: InternalCompactionAttemptIdentity
			failureKind: CompactionFailureKind
			error: unknown
	  }

export interface RunInternalCompactionPassWithRetryInput
	extends Omit<RunInternalCompactionPassInput, "attemptId" | "onChunk" | "onSummaryUpdate" | "onAttemptSettled"> {
	passIdentity: CompactionPassIdentity
	retryPolicy: CompactionRetryPolicy
	allowOpenAiMaxOutputReplay?: boolean
	/** Failures eligible for the ordinary Pass retry budget; defaults to correctable and transient failures. */
	retryableFailure?(error: unknown): boolean
	initialAttemptIndex?: number
	attemptIdFactory(attemptIndex: number): string
	waitForRetry(retryAttempt: number): Promise<void>
	onRetry?(event: InternalCompactionPassRetryEvent): void | Promise<void>
	onChunk?(chunk: unknown, attempt: InternalCompactionAttemptIdentity): void | Promise<void>
	onSummaryUpdate?(context: string, attempt: InternalCompactionAttemptIdentity): void | Promise<void>
	onAttemptSettled?(diagnostics: CompactionAttemptDiagnostics): void
}

class CompactionPresentationQueue {
	private queue: Array<() => void | Promise<void>> = []
	private drainPromise: Promise<void> | undefined
	private failed = false
	private failure: unknown

	enqueue(operation: () => void | Promise<void>): void {
		if (this.failed) return
		this.queue.push(operation)
		this.startDrain()
	}

	async flush(): Promise<void> {
		this.startDrain()
		if (this.drainPromise) await this.drainPromise
		if (this.failed) throw this.failure
	}

	private startDrain(): void {
		if (this.drainPromise) return
		this.drainPromise = this.drain()
	}

	private async drain(): Promise<void> {
		try {
			while (this.queue.length > 0) {
				const operation = this.queue.shift()
				if (!operation) continue
				try {
					await operation()
				} catch (error) {
					this.failed = true
					this.failure = error
					this.queue = []
					return
				}
			}
		} finally {
			this.drainPromise = undefined
		}
	}
}

/**
 * Execute one compaction Provider request without ordinary UI or history side effects.
 *
 * The reply is the explicit-instruction text block `<summarize_task><context>…</context></summarize_task>`.
 * The whole stream is read before the block is parsed, so a Provider error after a closed block
 * (for example an output-limit stop while the model wrote trailing text) cannot discard it.
 */
export async function runInternalCompactionPass(input: RunInternalCompactionPassInput): Promise<InternalCompactionPassResult> {
	input.explicitInstructions.beginProviderAttempt(input.attemptId)
	const consumePort = input.explicitInstructions.createConsumePort()
	const providerStartedAtMs = performance.now()
	let firstChunkAtMs: number | undefined
	const providerStream = input.api.createMessage(
		input.providerInput.systemPrompt,
		input.providerInput.messages,
		input.providerInput.tools,
		{
			serverTools: input.providerInput.serverTools,
			taskNamespace: input.taskNamespace,
			retryOwner: "compaction",
			...(input.providerInput.providerOutputCap === undefined
				? {}
				: {
						generation: {
							purpose: "compaction",
							maxOutputTokens: input.providerInput.providerOutputCap,
						} as const,
					}),
		},
	)
	const stream = input.providerRequestRound?.bindAttempt(providerStream, input.taskAttempt ?? 0) ?? providerStream

	const observation = new CompactionReplyObservation(input.providerInput.tools)
	const usageTracker = new TaskRequestUsageTracker()
	let usageReported = false
	const presentationQueue = new CompactionPresentationQueue()
	let lastPublishedSummary: string | undefined
	let summaryUpdateQueued = false
	// Each summary update ships the whole summary to the Webview and waits for delivery, so queueing
	// one per text chunk lets the card replay stale snapshots long after the Provider has finished.
	// Keep at most one update queued and read the latest reply text only when it runs.
	const scheduleSummaryUpdate = (): void => {
		if (!input.onSummaryUpdate || summaryUpdateQueued) return
		summaryUpdateQueued = true
		presentationQueue.enqueue(() => {
			summaryUpdateQueued = false
			const snapshot = parseSummarizeTaskCalls(observation.text).at(-1)?.params.context?.trim()
			if (!snapshot || snapshot === lastPublishedSummary) return
			lastPublishedSummary = snapshot
			return input.onSummaryUpdate?.(snapshot)
		})
	}

	const processChunk = (chunk: ApiProviderStreamChunk | undefined): void => {
		if (!chunk) return
		if (input.onChunk) presentationQueue.enqueue(() => input.onChunk?.(chunk))
		observation.record(chunk)
		if (chunk.type === "text") scheduleSummaryUpdate()
		if (chunk.type === "usage") {
			usageTracker.apply(chunk)
			usageReported = true
		}
	}

	const readUsage = (): InternalCompactionUsage | undefined => {
		if (!usageReported) return undefined
		const snapshot = usageTracker.getSnapshot()
		const totalTokens = snapshot.inputTokens + snapshot.outputTokens + snapshot.cacheWriteTokens + snapshot.cacheReadTokens
		if (totalTokens <= 0) return undefined
		return {
			inputTokens: snapshot.inputTokens,
			outputTokens: snapshot.outputTokens,
			cacheWriteTokens: snapshot.cacheWriteTokens,
			cacheReadTokens: snapshot.cacheReadTokens,
			totalTokens,
			...(snapshot.thoughtsTokens === undefined ? {} : { thoughtsTokens: snapshot.thoughtsTokens }),
		}
	}

	const attachUsage = (): void => {
		if (!usageReported) return
		const snapshot = usageTracker.getSnapshot()
		input.providerRequestRound?.attachExactUsage({
			inputTokens: snapshot.inputTokens,
			outputTokens: snapshot.outputTokens,
			cacheWriteTokens: snapshot.cacheWriteTokens,
			cacheReadTokens: snapshot.cacheReadTokens,
			...(snapshot.thoughtsTokens === undefined ? {} : { thoughtsTokens: snapshot.thoughtsTokens }),
			cacheUsageReported: snapshot.cacheUsageReported,
		})
	}

	let streamError: unknown
	let closedBeforeStreamEnd = false
	const iterator = stream[Symbol.asyncIterator]()
	try {
		for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
			firstChunkAtMs ??= performance.now()
			processChunk(next.value)
			// Like any tool call, summarize_task runs as soon as it closes; the task must not wait for the Provider tail.
			if (next.value.type === "text" && endsWithClosedSummarizeTaskCall(observation.text)) {
				closedBeforeStreamEnd = true
				break
			}
		}
	} catch (error) {
		streamError = error
	}
	if (closedBeforeStreamEnd) {
		// Within the grace period the tail is observed like the rest of the reply; after it, usage is only recorded.
		let applyTailUsage = (chunk: Extract<ApiProviderStreamChunk, { type: "usage" }>): void => processChunk(chunk)
		const tail = drainUsageTail(iterator, (chunk) => applyTailUsage(chunk))
		if (await settlesWithin(tail, USAGE_TAIL_GRACE_MS)) {
			attachUsage()
		} else {
			applyTailUsage = (chunk) => {
				usageTracker.apply(chunk)
				usageReported = true
			}
			void tail.then(attachUsage)
		}
	} else {
		attachUsage()
	}

	const settledAtMs = performance.now()
	const usage = readUsage()
	const timing: InternalCompactionProviderTiming = {
		providerTtfbMs: elapsedCompactionMs(providerStartedAtMs, firstChunkAtMs ?? settledAtMs),
		streamMs: elapsedCompactionMs(firstChunkAtMs ?? providerStartedAtMs, settledAtMs),
	}
	const reportAttempt = (fields: Pick<CompactionAttemptDiagnostics, "outcome" | "failureKind" | "trailingChars">): void => {
		try {
			input.onAttemptSettled?.(
				observation.toDiagnostics({
					...fields,
					attemptIndex: input.taskAttempt ?? 0,
					authorizationAttemptId: input.attemptId ?? "",
					...(input.providerInput.providerOutputCap === undefined
						? {}
						: { providerOutputCap: input.providerInput.providerOutputCap }),
					...(usage ? { usage } : {}),
					...timing,
				}),
			)
		} catch {
			// Diagnostics are observational and must never decide the compaction outcome.
		}
	}

	try {
		await presentationQueue.flush()
	} catch (error) {
		reportAttempt({ outcome: "failed", failureKind: classifyCompactionFailure(error) })
		throw error
	}

	const accepted = findClosedSummarizeTaskCall(observation.text)
	if (!accepted) {
		const failureKind = classifySummarizeTaskReply({
			call: parseSummarizeTaskCalls(observation.text).at(-1),
			text: observation.text,
			nativeToolCallNames: observation.calledToolNames,
			outputLimitReached: observation.stopReason === "output_limit" || isOutputLimitExceededError(streamError),
		})
		// A transport or cancellation failure explains the missing call better than the reply shape;
		// an output-limit error is kept as-is so the OpenAI reduced-cap replay can recognize it.
		const failure = streamError ?? new CompactionSummaryRejectedError(failureKind)
		reportAttempt({ outcome: "failed", failureKind: streamError ? classifyCompactionFailure(streamError) : failureKind })
		throw failure
	}

	const consumed = consumePort.consumeTool(ClineDefaultTool.SUMMARIZE_TASK)
	if (!consumed.ok) {
		reportAttempt({ outcome: "failed", failureKind: "authorization_failed" })
		throw new CompactionAuthorizationError(consumed.code)
	}
	reportAttempt({ outcome: "accepted", trailingChars: accepted.trailingChars })
	const taskProgress = accepted.call.params.task_progress?.trim()
	return {
		summary: accepted.summary,
		...(taskProgress ? { taskProgress } : {}),
		...(usage ? { usage } : {}),
		timing,
	}
}

/**
 * Own every attempt for one immutable hidden Pass without entering Task auto-retry.
 *
 * Every retry starts from the frozen Pass input. A correctable failure adds exactly one reminder
 * naming what was wrong with the previous reply; a transient Provider failure replays the
 * previous attempt's input unchanged.
 */
export async function runInternalCompactionPassWithRetry(
	input: RunInternalCompactionPassWithRetryInput,
): Promise<InternalCompactionPassAttemptResult> {
	const frozenProviderInput = cloneDeep(input.providerInput)
	let currentProviderInput = cloneDeep(frozenProviderInput)
	let currentAttempt = createAttemptIdentity(input, input.initialAttemptIndex ?? 0)
	let currentReminder: CompactionSummaryFailureKind | undefined
	let openAiMaxOutputReplayUsed = false

	while (true) {
		const attempt = currentAttempt
		const reminderKind = currentReminder
		// Hold the attempt diagnostics until the retry decision is known, so each report names its next action.
		let settled: CompactionAttemptDiagnostics | undefined
		const reportAttempt = (nextAction: CompactionAttemptNextAction): void => {
			if (!settled) return
			input.onAttemptSettled?.({ ...settled, ...(reminderKind ? { reminderKind } : {}), nextAction })
			settled = undefined
		}
		try {
			const result = await runInternalCompactionPass({
				api: input.api,
				providerInput: currentProviderInput,
				explicitInstructions: input.explicitInstructions,
				taskNamespace: input.taskNamespace,
				attemptId: attempt.authorizationAttemptId,
				providerRequestRound: input.providerRequestRound,
				taskAttempt: attempt.attemptIndex,
				onChunk: (chunk) => input.onChunk?.(chunk, attempt),
				onSummaryUpdate: (context) => input.onSummaryUpdate?.(context, attempt),
				onAttemptSettled: (diagnostics) => {
					settled = diagnostics
				},
			})
			reportAttempt("accept")
			input.retryPolicy.reset()
			return { ...result, ...attempt }
		} catch (error) {
			const failureKind = classifyCompactionFailure(error)
			const replayCap =
				input.allowOpenAiMaxOutputReplay === false
					? undefined
					: getOpenAiMaxOutputReplayCap(frozenProviderInput.providerOutputCap, error, openAiMaxOutputReplayUsed)
			if (replayCap !== undefined) {
				reportAttempt("retry")
				openAiMaxOutputReplayUsed = true
				const nextAttempt = createAttemptIdentity(input, attempt.attemptIndex + 1)
				currentReminder = "output_limit"
				currentProviderInput = {
					...withCompactionRetryReminder(frozenProviderInput, "output_limit"),
					providerOutputCap: replayCap,
				}
				await input.onRetry?.({
					kind: "openai_max_output_replay",
					providerOutputCap: replayCap,
					failedAttempt: attempt,
					nextAttempt,
					failureKind,
					error,
				})
				currentAttempt = nextAttempt
				continue
			}

			const isRetryableFailure = input.retryableFailure ?? isRetryableCompactionFailure
			if (!isRetryableFailure(error)) {
				reportAttempt("fail")
				throw error
			}
			const retryDecision = input.retryPolicy.registerFailure(input.passIdentity)
			if (retryDecision.action === "exhausted") {
				reportAttempt("fail")
				throw error
			}
			reportAttempt("retry")

			const nextAttempt = createAttemptIdentity(input, attempt.attemptIndex + 1)
			await input.onRetry?.({
				kind: "pass_retry",
				retryAttempt: retryDecision.retryAttempt,
				maxRetryAttempts: retryDecision.maxRetryAttempts,
				failedAttempt: attempt,
				nextAttempt,
				failureKind,
				error,
			})
			await input.waitForRetry(retryDecision.retryAttempt)
			currentAttempt = nextAttempt
			// Keep the current output cap, so a reduced OpenAI max-output replay cap survives ordinary Pass retries.
			const nextReminder = toReminderKind(failureKind)
			if (nextReminder) {
				currentReminder = nextReminder
				currentProviderInput = {
					...withCompactionRetryReminder(frozenProviderInput, nextReminder),
					providerOutputCap: currentProviderInput.providerOutputCap,
				}
			}
		}
	}
}

/**
 * Default retry eligibility for automatic compaction.
 *
 * Reply-shape and output-limit failures are always worth one more reminded attempt; Provider
 * failures follow HTTP retryability; authorization and cancellation failures are terminal.
 */
export function isRetryableCompactionFailure(error: unknown): boolean {
	if (isCorrectableCompactionFailure(error)) return true
	if (classifyCompactionFailure(error) !== "provider_error") return false
	return isRetryableCompactionError(error)
}

function createAttemptIdentity(
	input: RunInternalCompactionPassWithRetryInput,
	attemptIndex: number,
): InternalCompactionAttemptIdentity {
	return {
		attemptIndex,
		authorizationAttemptId: input.attemptIdFactory(attemptIndex),
	}
}

function getOpenAiMaxOutputReplayCap(
	initialProviderOutputCap: number | undefined,
	error: unknown,
	replayUsed: boolean,
): number | undefined {
	if (replayUsed || initialProviderOutputCap === undefined || !isOpenAiMaxOutputFailure(error)) return undefined
	const replayCap = Math.floor(initialProviderOutputCap * 0.9)
	return replayCap > 0 ? replayCap : undefined
}

function isOpenAiMaxOutputFailure(error: unknown): boolean {
	return (
		isOutputLimitExceededError(error) &&
		((error.protocol === "openai_chat" && error.reason === "length") ||
			(error.protocol === "openai_responses" && error.reason === "max_output_tokens"))
	)
}

const SUMMARIZE_TASK_CLOSE_TAG = `</${ClineDefaultTool.SUMMARIZE_TASK}>`

/** Parse every summarize_task explicit-instruction call in the reply with the standard tool parser. */
function parseSummarizeTaskCalls(text: string): ToolUse[] {
	if (!text.trim()) return []
	let ts = 0
	const identities = createIdentityFactory(() => String(++ts))
	const blocks = parseAssistantMessageV2(text, {
		getOrCreateTsForBlock: () => ++ts,
		getOrCreateToolIdentityForBlock: () => ({
			function_id: identities.nextFunctionId(),
			dline_tid: identities.nextTraceId(),
		}),
	})
	return blocks.filter((block): block is ToolUse => block.type === "tool_use" && block.name === ClineDefaultTool.SUMMARIZE_TASK)
}

interface ClosedSummarizeTaskCall {
	call: ToolUse
	summary: string
	/** Characters written after the call closed; ignored. */
	trailingChars: number
}

/**
 * Providers send usage right after the closing text.
 * is attached to the Provider round when it arrives.
 */
const USAGE_TAIL_GRACE_MS = 2_000

async function settlesWithin(tail: Promise<void>, graceMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), graceMs)
	})
	try {
		return await Promise.race([tail.then(() => true as const), expired])
	} finally {
		clearTimeout(timer)
	}
}

/** True when the streamed reply currently ends with a closed summarize_task call that carries a summary. */
function endsWithClosedSummarizeTaskCall(text: string): boolean {
	const settled = text.trimEnd()
	if (!settled.endsWith(SUMMARIZE_TASK_CLOSE_TAG)) return false
	const call = parseSummarizeTaskCalls(settled).at(-1)
	return call !== undefined && !call.partial && Boolean(call.params.context?.trim())
}

/**
 * Reads the rest of a Provider stream after the summary was accepted. Only usage matters there; a failing tail
 * cannot invalidate the accepted summary, so it only ends the drain.
 */
async function drainUsageTail(
	iterator: AsyncIterator<ApiProviderStreamChunk>,
	applyUsage: (chunk: Extract<ApiProviderStreamChunk, { type: "usage" }>) => void,
): Promise<void> {
	try {
		for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
			if (next.value.type === "usage") applyUsage(next.value)
		}
	} catch {
		// The usage recorded before the failure is still attached by the caller.
	}
}

/**
 * Find the closed summarize_task call that carries the summary.
 *
 * The standard parser only treats `</summarize_task>` at the end of the text as terminal, which
 * protects quoted closing tags while a reply streams. Once the reply has settled, anything written
 * after a closed call is ignored, so each closing tag is tried as the end of the reply, starting
 * from the last one, and the last closed call with a non-empty context wins.
 */
function findClosedSummarizeTaskCall(text: string): ClosedSummarizeTaskCall | undefined {
	let closeStart = text.lastIndexOf(SUMMARIZE_TASK_CLOSE_TAG)
	while (closeStart >= 0) {
		const replyEnd = closeStart + SUMMARIZE_TASK_CLOSE_TAG.length
		const call = parseSummarizeTaskCalls(text.slice(0, replyEnd))
			.filter((candidate) => !candidate.partial && candidate.params.context?.trim())
			.at(-1)
		const summary = call?.params.context?.trim()
		if (call && summary) return { call, summary, trailingChars: text.length - replyEnd }
		closeStart = closeStart > 0 ? text.lastIndexOf(SUMMARIZE_TASK_CLOSE_TAG, closeStart - 1) : -1
	}
	return undefined
}
