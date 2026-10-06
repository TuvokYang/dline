import type { ApiHandler } from "@core/api"
import { isOutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import { createIdentityFactory } from "@core/api/transform/block-identity"
import type { ApiProviderStreamChunk } from "@core/api/transform/stream"
import { ApiUsageAccumulator } from "@core/api/transform/usage-accumulator"
import { parseAssistantMessageV2, type ToolUse } from "@core/assistant-message"
import type { CompactionProviderInput } from "@core/task/compaction/CompactionRequestReplay"
import type { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import type { ProviderRequestRoundAdmission } from "@core/task/performance/provider-request-round-port"
import { ClineDefaultTool } from "@shared/tools"
import cloneDeep from "clone-deep"
import type { InternalCompactionProviderTiming } from "./compaction-phase-timing"
import { elapsedCompactionMs } from "./compaction-phase-timing"
import type { CompactionRetryPolicy } from "./compaction-retry-policy"
import { isRetryableCompactionError } from "./compaction-retryability"
import type { CompactionPassIdentity } from "./target-window-fitting"

export interface InternalCompactionUsage {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalTokens: number
}

export interface InternalCompactionSettlement {
	usage?: InternalCompactionUsage
	error?: unknown
}

export interface InternalCompactionPassResult {
	summary: string
	usage?: InternalCompactionUsage
	timing: InternalCompactionProviderTiming
	/** Provider stream settlement that may finish after the summary is safe to checkpoint. */
	settlement?: Promise<InternalCompactionSettlement>
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
			error: unknown
	  }
	| {
			kind: "openai_max_output_replay"
			providerOutputCap: number
			failedAttempt: InternalCompactionAttemptIdentity
			nextAttempt: InternalCompactionAttemptIdentity
			error: unknown
	  }

export interface RunInternalCompactionPassWithRetryInput
	extends Omit<RunInternalCompactionPassInput, "attemptId" | "onChunk" | "onSummaryUpdate"> {
	passIdentity: CompactionPassIdentity
	retryPolicy: CompactionRetryPolicy
	allowOpenAiMaxOutputReplay?: boolean
	/** Failures eligible for the ordinary Pass retry budget; defaults to every transient compaction failure. */
	retryableFailure?(error: unknown): boolean
	initialAttemptIndex?: number
	attemptIdFactory(attemptIndex: number): string
	waitForRetry(retryAttempt: number): Promise<void>
	onRetry?(event: InternalCompactionPassRetryEvent): void | Promise<void>
	onChunk?(chunk: unknown, attempt: InternalCompactionAttemptIdentity): void | Promise<void>
	onSummaryUpdate?(context: string, attempt: InternalCompactionAttemptIdentity): void | Promise<void>
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

/** Execute one compaction Provider request without ordinary UI or history side effects. */
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

	let assistantText = ""
	let nativeSummary: string | undefined
	let usage: InternalCompactionUsage | undefined
	let cacheUsageReported = false
	const usageAccumulator = new ApiUsageAccumulator()
	const presentationQueue = new CompactionPresentationQueue()
	let lastPublishedSummary: string | undefined
	let completedSummary: string | undefined
	let resolveCompletedSummary!: (summary: string) => void
	const completedSummaryPromise = new Promise<string>((resolve) => {
		resolveCompletedSummary = resolve
	})
	const nativeArguments = new Map<string, string>()
	const publishSummarySnapshot = (context: string | undefined): void => {
		const snapshot = context?.trim()
		if (!snapshot || snapshot === lastPublishedSummary) return
		lastPublishedSummary = snapshot
		if (input.onSummaryUpdate) presentationQueue.enqueue(() => input.onSummaryUpdate?.(snapshot))
	}

	const processChunk = (chunk: ApiProviderStreamChunk | undefined, publishChunk: boolean): void => {
		if (!chunk) return
		if (publishChunk && input.onChunk) presentationQueue.enqueue(() => input.onChunk?.(chunk))
		switch (chunk.type) {
			case "text":
				assistantText += chunk.text
				publishSummarySnapshot(parseXmlSummarySnapshot(assistantText))
				break
			case "tool_calls": {
				if (chunk.tool_call.function.name !== ClineDefaultTool.SUMMARIZE_TASK) break
				const key = chunk.tool_index === undefined ? chunk.function_id : String(chunk.tool_index)
				const next = normalizeArguments(chunk.tool_call.function.arguments)
				// Responses-family adapters emit the complete arguments twice: once as the
				// argument delta and again on output_item.done. A chunk that is already a
				// complete summary payload is authoritative; otherwise keep appending
				// incremental deltas until a complete payload arrives.
				const completeSnapshot = parseSummaryArguments(next)
				if (completeSnapshot !== undefined) {
					nativeArguments.set(key, next)
					nativeSummary = completeSnapshot
					publishSummarySnapshot(completeSnapshot)
				} else {
					const accumulated = `${nativeArguments.get(key) ?? ""}${next}`
					nativeArguments.set(key, accumulated)
					publishSummarySnapshot(parsePartialSummaryArguments(accumulated))
					// Chat-family adapters emit complete argument chunks without a completion phase.
					if (chunk.phase === undefined || chunk.phase === "completed") {
						const completed = parseSummaryArguments(accumulated)
						if (completed !== undefined) {
							nativeSummary = completed
							publishSummarySnapshot(completed)
						}
					}
				}
				if (chunk.phase === "completed") {
					const completed = nativeSummary ?? parseSummaryArguments(nativeArguments.get(key) ?? "")
					if (completed !== undefined && completedSummary === undefined) {
						completedSummary = completed
						resolveCompletedSummary(completed)
					}
				}
				break
			}
			case "usage": {
				cacheUsageReported ||= chunk.cacheWriteTokens !== undefined || chunk.cacheReadTokens !== undefined
				const current = usageAccumulator.apply(chunk).usage
				usage = {
					...current,
					totalTokens: current.inputTokens + current.outputTokens + current.cacheWriteTokens + current.cacheReadTokens,
				}
				break
			}
			case "reasoning":
			case "server_tool":
				break
		}
	}

	const attachRoundUsage = (): void => {
		if (!usage) return
		input.providerRequestRound?.attachExactUsage({
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheUsageReported,
		})
	}

	const pumpStream = async (): Promise<InternalCompactionSettlement> => {
		try {
			for await (const chunk of stream) {
				firstChunkAtMs ??= performance.now()
				processChunk(chunk, completedSummary === undefined)
			}
			await presentationQueue.flush()
			if (completedSummary === undefined) {
				// Truncated native arguments never parse as complete JSON, so a Pass that
				// streamed a usable summary was discarded together with every token it
				// cost. The partial reader already backs the streamed presentation, so it
				// is trusted here as the final fallback before declaring the Pass unusable.
				const summary = nativeSummary ?? parseXmlSummary(assistantText) ?? parseSalvagedNativeSummary(nativeArguments)
				if (!summary) {
					throw createUnusableSummaryError(nativeArguments)
				}
				completedSummary = summary
				resolveCompletedSummary(summary)
			}
			if (!usage || usage.totalTokens <= 0) {
				throw new Error("Internal compaction Pass did not return reliable usage")
			}
			return { usage }
		} catch (error) {
			await presentationQueue.flush()
			if (completedSummary !== undefined) return { usage, error }
			throw error
		} finally {
			attachRoundUsage()
		}
	}

	const settlement = pumpStream()
	const summary = await Promise.race([
		completedSummaryPromise,
		settlement.then(() => {
			if (!completedSummary) throw new Error("Internal compaction Pass completed without an accepted summary")
			return completedSummary
		}),
	])
	await presentationQueue.flush()
	const consumed = consumePort.consumeTool(ClineDefaultTool.SUMMARIZE_TASK)
	if (!consumed.ok) {
		throw new Error(`Internal compaction summarize_task authorization failed: ${consumed.code}`)
	}
	const summaryCompletedAtMs = performance.now()
	return {
		summary,
		...(usage && usage.totalTokens > 0 ? { usage } : {}),
		timing: {
			providerTtfbMs: elapsedCompactionMs(providerStartedAtMs, firstChunkAtMs ?? summaryCompletedAtMs),
			streamMs: elapsedCompactionMs(firstChunkAtMs ?? providerStartedAtMs, summaryCompletedAtMs),
		},
		settlement,
	}
}

/** Own every attempt for one immutable hidden Pass without entering Task auto-retry. */
export async function runInternalCompactionPassWithRetry(
	input: RunInternalCompactionPassWithRetryInput,
): Promise<InternalCompactionPassAttemptResult> {
	const frozenProviderInput = cloneDeep(input.providerInput)
	let currentProviderInput = cloneDeep(frozenProviderInput)
	let currentAttempt = createAttemptIdentity(input, input.initialAttemptIndex ?? 0)
	let openAiMaxOutputReplayUsed = false

	while (true) {
		try {
			const result = await runInternalCompactionPass({
				api: input.api,
				providerInput: currentProviderInput,
				explicitInstructions: input.explicitInstructions,
				taskNamespace: input.taskNamespace,
				attemptId: currentAttempt.authorizationAttemptId,
				providerRequestRound: input.providerRequestRound,
				taskAttempt: currentAttempt.attemptIndex,
				onChunk: (chunk) => input.onChunk?.(chunk, currentAttempt),
				onSummaryUpdate: (context) => input.onSummaryUpdate?.(context, currentAttempt),
			})
			input.retryPolicy.reset()
			return { ...result, ...currentAttempt }
		} catch (error) {
			const replayCap =
				input.allowOpenAiMaxOutputReplay === false
					? undefined
					: getOpenAiMaxOutputReplayCap(frozenProviderInput.providerOutputCap, error, openAiMaxOutputReplayUsed)
			if (replayCap !== undefined) {
				openAiMaxOutputReplayUsed = true
				const nextAttempt = createAttemptIdentity(input, currentAttempt.attemptIndex + 1)
				currentProviderInput = { ...cloneDeep(frozenProviderInput), providerOutputCap: replayCap }
				await input.onRetry?.({
					kind: "openai_max_output_replay",
					providerOutputCap: replayCap,
					failedAttempt: currentAttempt,
					nextAttempt,
					error,
				})
				currentAttempt = nextAttempt
				continue
			}
			// A suspected truncation has already consumed its single reduced replay above,
			// so it must not fall through into ordinary same-cap Pass retries.
			const isRetryableFailure = input.retryableFailure ?? isRetryableCompactionError
			if (isOpenAiMaxOutputFailure(error) || isSuspectedCompactionOutputTruncation(error) || !isRetryableFailure(error)) {
				throw error
			}

			const retryDecision = input.retryPolicy.registerFailure(input.passIdentity)
			if (retryDecision.action === "exhausted") {
				throw error
			}
			const nextAttempt = createAttemptIdentity(input, currentAttempt.attemptIndex + 1)
			await input.onRetry?.({
				kind: "pass_retry",
				retryAttempt: retryDecision.retryAttempt,
				maxRetryAttempts: retryDecision.maxRetryAttempts,
				failedAttempt: currentAttempt,
				nextAttempt,
				error,
			})
			await input.waitForRetry(retryDecision.retryAttempt)
			currentAttempt = nextAttempt
			// Keep the current output cap, so a reduced OpenAI max-output replay cap survives ordinary Pass retries.
			// An unusable summary is retried from the frozen input plus one correction, never the failed attempt's output.
			currentProviderInput = isUnusableCompactionSummaryError(error)
				? { ...withCompactionCorrection(frozenProviderInput), providerOutputCap: currentProviderInput.providerOutputCap }
				: cloneDeep(currentProviderInput)
		}
	}
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
	if (replayUsed || initialProviderOutputCap === undefined) return undefined
	// A reported max-output failure and an unreadable argument payload both mean the
	// summary did not fit the cap, so both earn the same single reduced replay.
	if (!isOpenAiMaxOutputFailure(error) && !isSuspectedCompactionOutputTruncation(error)) return undefined
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

function normalizeArguments(value: unknown): string {
	if (typeof value === "string") return value
	if (value === undefined) return ""
	return JSON.stringify(value)
}

function parseSummaryArguments(value: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(value)
		if (typeof parsed !== "object" || parsed === null || !("context" in parsed)) return undefined
		const context = (parsed as { context?: unknown }).context
		return typeof context === "string" && context.trim() ? context.trim() : undefined
	} catch {
		return undefined
	}
}

/** Marks a Pass whose native arguments arrived but never yielded a usable summary. */
const SUSPECTED_OUTPUT_TRUNCATION = Symbol.for("dline.compaction.suspectedOutputTruncation")

/** Marks a Pass that answered with text or another tool instead of any summarize_task arguments. */
const UNUSABLE_SUMMARY = Symbol.for("dline.compaction.unusableSummary")

/** Appended to the compaction instruction message when a retry follows an unusable summary. */
export const COMPACTION_CORRECTION_NOTE =
	"The previous compaction attempt did not return a usable summarize_task call. Respond only by calling summarize_task with the complete context summary; do not call any other tool and do not reply with plain text."

/**
 * Report whether a Pass failed because the model never produced summarize_task arguments.
 *
 * @param error The failure raised while settling one compaction Pass.
 * @returns True when a corrected retry of the same frozen Pass may succeed.
 */
export function isUnusableCompactionSummaryError(error: unknown): boolean {
	return typeof error === "object" && error !== null && UNUSABLE_SUMMARY in error
}

/**
 * Build the retry input for an unusable summary from the frozen Pass input.
 *
 * The correction travels inside the final message, which carries the compaction instruction,
 * so the cached prompt prefix and the tool list stay byte-identical across attempts.
 */
function withCompactionCorrection(frozenProviderInput: CompactionProviderInput): CompactionProviderInput {
	const corrected = cloneDeep(frozenProviderInput)
	const instructionMessage = corrected.messages.at(-1)
	if (!instructionMessage) return corrected
	const correction = { type: "text" as const, text: COMPACTION_CORRECTION_NOTE }
	instructionMessage.content =
		typeof instructionMessage.content === "string"
			? [{ type: "text" as const, text: instructionMessage.content }, correction]
			: [...instructionMessage.content, correction]
	return corrected
}

/**
 * Report whether a Pass failure looks like a Provider output-cap truncation.
 *
 * The Provider does not always report a `length` stop reason, so an unparsable
 * argument payload is the only available signal that the summary was cut off.
 *
 * @param error The failure raised while settling one compaction Pass.
 * @returns True when the same Pass is worth replaying under a smaller output cap.
 */
export function isSuspectedCompactionOutputTruncation(error: unknown): boolean {
	return typeof error === "object" && error !== null && SUSPECTED_OUTPUT_TRUNCATION in error
}

/**
 * Build the terminal error for a Pass that produced no usable summarize_task context.
 *
 * @param nativeArguments Accumulated raw argument text per tool-call key.
 * @returns The error, tagged when argument text arrived but could not be read.
 */
function createUnusableSummaryError(nativeArguments: ReadonlyMap<string, string>): Error {
	const error = new Error("Internal compaction Pass did not return a valid summarize_task context")
	const receivedArgumentText = [...nativeArguments.values()].some((value) => value.trim().length > 0)
	return Object.assign(error, { [receivedArgumentText ? SUSPECTED_OUTPUT_TRUNCATION : UNUSABLE_SUMMARY]: true })
}

/**
 * Recover the longest usable summary from native arguments that never completed.
 *
 * @param nativeArguments Accumulated raw argument text per tool-call key.
 * @returns The salvaged summary, or undefined when no fragment carries content.
 */
function parseSalvagedNativeSummary(nativeArguments: ReadonlyMap<string, string>): string | undefined {
	let salvaged: string | undefined
	for (const accumulated of nativeArguments.values()) {
		const candidate = parseSummaryArguments(accumulated) ?? parsePartialSummaryArguments(accumulated)
		if (candidate && (salvaged === undefined || candidate.length > salvaged.length)) salvaged = candidate
	}
	return salvaged
}

function parsePartialSummaryArguments(value: string): string | undefined {
	const match = value.match(/"context"\s*:\s*"((?:[^"\\]|\\.)*)/)
	if (!match) return undefined
	try {
		const context: unknown = JSON.parse(`"${match[1]}"`)
		return typeof context === "string" && context.trim() ? context.trim() : undefined
	} catch {
		return undefined
	}
}

function parseXmlSummary(text: string): string | undefined {
	return parseXmlSummaryBlock(text, false)
}

function parseXmlSummarySnapshot(text: string): string | undefined {
	return parseXmlSummaryBlock(text, true)
}

function parseXmlSummaryBlock(text: string, allowPartial: boolean): string | undefined {
	if (!text.trim()) return undefined
	let ts = 0
	const identities = createIdentityFactory(() => String(++ts))
	const blocks = parseAssistantMessageV2(text, {
		getOrCreateTsForBlock: () => ++ts,
		getOrCreateToolIdentityForBlock: () => ({
			function_id: identities.nextFunctionId(),
			dline_tid: identities.nextTraceId(),
		}),
	})
	const summaries = blocks.filter(
		(block): block is ToolUse =>
			block.type === "tool_use" &&
			block.name === ClineDefaultTool.SUMMARIZE_TASK &&
			(allowPartial || !block.partial) &&
			typeof block.params.context === "string" &&
			block.params.context.trim().length > 0,
	)
	// A model may emit several summarize_task blocks in one response, for example a
	// revised summary after a first draft. Requiring exactly one block rejected a
	// response that did carry a usable summary, which burned the whole Pass and its
	// tokens. The last complete block is the model's final answer, so it wins.
	return summaries.at(-1)?.params.context?.trim()
}
