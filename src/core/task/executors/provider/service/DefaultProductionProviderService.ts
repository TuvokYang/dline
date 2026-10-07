import { createIdentityFactory, type IdentityFactory } from "@core/api/transform/block-identity"
import type { ApiStreamChunk, ApiStreamServerToolChunk, ApiStreamToolCallsChunk } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { parseAssistantMessageV2, type ToolUse } from "@core/assistant-message"
import { isDeterministicToolPairingError } from "@core/context/context-management/compaction-retryability"
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling"
import {
	type ClineAssistantContent,
	type ClineAssistantToolUseBlock,
	type ClineStorageMessage,
	projectInternalMessagesForProvider,
} from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { ClineError } from "@/services/error"
import { isTurnEndingToolName } from "../../../assistant-message-order"
import { isRetryableProviderError, type ProviderIdentity, waitRetryDelayUnlessAborted } from "../../../auto-retry"
import { getRetryDelay, MAX_AUTO_RETRY_ATTEMPTS } from "../../../auto-retry-schedule"
import { ContextWindowReceivingTracker } from "../../../ContextWindowReceivingTracker"
import { StreamResponseHandler } from "../../../StreamResponseHandler"
import type { JournalWatermark } from "../../../stores"
import type {
	ProviderBlockOutput,
	ProviderDraftEnvelope,
	ToolInvocationEnvelope,
} from "../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk, ProductionProviderService } from "../ProductionProviderAdapter"
import { ProviderFailure } from "../ProviderFailure"
import { repairProviderPairing } from "./ProviderPairingRepair"
import type { PreparedProviderRequest, ProviderRequestFactory, ProviderServerToolRequestContext } from "./ProviderRequest"
import { ProviderUsageIncrements } from "./ProviderUsageIncrements"

/** The automatic retries one turn may still spend, shared by every send of it. */
interface RetryBudget {
	attempts: number
}

/** What a retry chunk tells the chat about the attempt being waited for. */
type ProviderRetryNoticeInput = Extract<ProductionProviderChunk, { kind: "retry" }>["notice"]

interface PendingNativeTool {
	readonly functionId: string
	readonly dlineTid: string
	readonly presentationId: number
	name: string
	arguments: unknown
	signature?: string
}

/**
 * How a retry wait ended: `send` the next attempt, `cancelled` by the request's
 * signal, or `handed_back` to the user, which ends the request with the failure
 * the countdown was retrying.
 */
export type ProviderRetryWait = "send" | "cancelled" | "handed_back"

/** How a request that failed before its first chunk is sent again. */
export interface ProviderRetryPolicy {
	readonly maxAttempts: number
	/** Delay before one-based retry `attempt`. */
	delayMs(attempt: number): number
	/** Resolve `send` once the delay elapsed, `cancelled` as soon as the signal aborts. */
	wait(delayMs: number, signal: AbortSignal): Promise<ProviderRetryWait>
	/** The request left its retry loop: it produced a stream, failed for good, or was cancelled. */
	settled?(): void
	/** Whether the request starting now was opened by a manual Retry, which owns its failure. */
	claimManualTakeover?(): boolean
}

/** The automatic retry schedule the chat presents: five attempts, bounded at one minute. */
export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
	maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
	delayMs: getRetryDelay,
	wait: async (delayMs, signal) => ((await waitRetryDelayUnlessAborted(delayMs, signal)) ? "send" : "cancelled"),
}

export interface ProviderServerToolPresentationSession {
	consume(chunk: ApiStreamServerToolChunk): Promise<boolean>
	finalizeOpen(reason: string): Promise<void>
}

export interface ProviderServerToolPresentationPort {
	begin(context: ProviderServerToolRequestContext): ProviderServerToolPresentationSession
}

export type { ProviderServerToolRequestContext }

/**
 * How a request the provider refused as longer than its context window is recovered.
 *
 * With auto-compaction off nothing shrinks the conversation ahead of the
 * request, so the refusal is the first sign it no longer fits. Truncating
 * the oldest settled history and resending at once is what the user gets
 * instead of a dead end.
 */
export interface ProviderContextRecoveryPort {
	/** Whether this recovery applies now; auto-compaction owns the window when it is on. */
	enabled(): boolean
	/** Remove settled history; resolves the position to resend through, or undefined when nothing is left to remove. */
	truncate(signal: AbortSignal): Promise<JournalWatermark | undefined>
}

export interface DefaultProductionProviderServiceOptions {
	readonly requests: ProviderRequestFactory
	readonly identities?: IdentityFactory
	readonly nextPresentationId?: () => number
	readonly onUsage?: (usage: Readonly<Record<string, number>>) => void
	readonly retry?: ProviderRetryPolicy
	/**
	 * Binds each attempt of a turn's request to that turn's logical request
	 * round, so the rates count rounds rather than raw sends.
	 */
	readonly rounds?: {
		bindOrdinaryAttempt<T>(turnId: string, attempt: number, stream: AsyncIterable<T>): AsyncIterable<T>
	}
	readonly serverTools?: ProviderServerToolPresentationPort
	readonly contextRecovery?: ProviderContextRecoveryPort
}

/**
 * The request one turn sends, kept frozen across its retries.
 *
 * It is replaced only when the task replaced the handler it was prepared for:
 * the frozen prompt and tools are one provider's projection, so replaying them
 * through another provider's handler loses every tool that provider cannot
 * read. The replacement is prepared from the same draft and turn, so the
 * conversation it carries is unchanged.
 *
 * The one exception is a conversation truncated to fit the context window:
 * the turn is then projected through the truncation record, and stays so.
 */
class TurnRequest {
	private through: JournalWatermark | undefined

	constructor(
		private current: PreparedProviderRequest,
		private readonly prepareAgain: (through: JournalWatermark | undefined) => Promise<PreparedProviderRequest>,
	) {}

	get request(): PreparedProviderRequest {
		return this.current
	}

	/** Prepare the turn again when its handler was replaced; true when it was. */
	async refreshIfStale(): Promise<boolean> {
		if (this.current.isCurrent?.() !== false) return false
		Logger.info("[provider] the task replaced its handler while the request waited; preparing it for the new handler")
		this.current = await this.prepareAgain(this.through)
		return true
	}

	/** Prepare the turn again over the journal through `through`, after its conversation was truncated. */
	async projectThrough(through: JournalWatermark): Promise<void> {
		this.through = through
		this.current = await this.prepareAgain(through)
	}

	/** Abandoning the stream also withdraws the turn's one-shot authority. */
	abandon(): void {
		this.current.api.abort?.()
		this.current.authority?.cancel()
	}
}

/** Yield a stream's first chunk again, then the rest of it, forwarding early close to the source. */
async function* continueFrom<T>(first: T, rest: AsyncIterator<T>): AsyncGenerator<T> {
	yield first
	yield* { [Symbol.asyncIterator]: () => rest }
}

/** Release a failed attempt's stream; a stream that already failed has nothing left to report. */
/**
 * Shape the canonical history for the endpoint this request targets.
 *
 * Hosted tool blocks replay only to the protocol that produced them, and
 * attached PDFs become native documents only within the endpoint's document
 * budget; every other PDF is sent as its extracted text.
 */
function projectForEndpoint(request: PreparedProviderRequest, messages: ClineStorageMessage[]): ClineStorageMessage[] {
	return projectInternalMessagesForProvider(messages, {
		hostedToolReplayProtocol: request.api.getHostedToolReplayProtocol?.(),
		documentInput: request.api.getDocumentInputLimits?.(),
	})
}

async function closeQuietly(iterator: AsyncIterator<unknown> | undefined): Promise<void> {
	try {
		await iterator?.return?.(undefined)
	} catch {
		// The attempt already failed; its cleanup error carries no new information.
	}
}

function mergeArguments(current: unknown, incoming: unknown, mode: ApiStreamToolCallsChunk["argumentsMode"]): unknown {
	if (mode === "snapshot") return incoming ?? {}
	if (typeof current === "string" || typeof incoming === "string")
		return `${typeof current === "string" ? current : ""}${typeof incoming === "string" ? incoming : ""}`
	if (current && incoming && typeof current === "object" && typeof incoming === "object") return { ...current, ...incoming }
	return incoming ?? current ?? {}
}

function parseArguments(value: unknown): Readonly<Record<string, unknown>> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>
	if (typeof value !== "string" || value.trim().length === 0) return {}
	try {
		const parsed = JSON.parse(value)
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

/**
 * Parses without allocating identities, for text that is only shown.
 *
 * A streaming preview is re-parsed on every chunk; drawing real presentation
 * ids or tool identities for it would burn ids the final parse never uses.
 */
const PREVIEW_PARSE_REGISTRY = {
	getOrCreateTsForBlock: () => 0,
	getOrCreateToolIdentityForBlock: () => ({ function_id: "", dline_tid: "" }),
}

function proseOf(blocks: ReturnType<typeof parseAssistantMessageV2>): string {
	let prose = ""
	let hasText = false
	for (const block of blocks) {
		if (block.type !== "text") continue
		if (hasText) prose += "\n\n"
		prose += block.content
		hasText = true
	}
	return prose
}

/**
 * The prose of an assistant reply with its tool markup removed.
 *
 * Tool markup is an invocation, not something the model said to the user: a
 * call the task refuses (an explicit-only tool nobody authorized) must not
 * reach the chat as text while it streams any more than after it settles.
 */
function visibleAssistantText(text: string): string {
	return proseOf(parseAssistantMessageV2(text, PREVIEW_PARSE_REGISTRY))
}

/**
 * The failure as the chat's error box renders it.
 *
 * A provider's own parser knows its error shapes best; the generic transform
 * is the fallback. Describing a failure must never replace it with another.
 */
function describeProviderError(request: PreparedProviderRequest, error: unknown, provider: ProviderIdentity): string {
	try {
		const parsed =
			request.api.parseError?.(error, provider.modelId) ??
			ClineError.transform(error, provider.modelId, provider.providerId)
		return parsed.serialize()
	} catch {
		return ClineError.transform(error, provider.modelId, provider.providerId).serialize()
	}
}

/**
 * The failure as it leaves this service: the original error, carrying how the
 * chat should explain it. Describing it must never replace it with another.
 */
function describedFailure(request: PreparedProviderRequest, error: unknown): unknown {
	try {
		const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
		return new ProviderFailure(error, describeProviderError(request, error, provider))
	} catch {
		return error
	}
}

/** Closes a reply the user stopped, so the next request knows it was cut short on purpose. */
export const USER_INTERRUPTION_NOTICE = "[Response interrupted by user]"

/**
 * What a stopped reply leaves in the conversation.
 *
 * Only what the model already said is kept: its reasoning and prose. A tool
 * call it was still writing never ran, so it is dropped rather than replayed.
 */
function interruptedTurn(
	reasoningContent: readonly ClineAssistantContent[],
	reasoningText: string,
	prose: string,
): { content: ClineAssistantContent[]; text: string; reasoning?: string } | undefined {
	if (reasoningContent.length === 0 && !prose.trim()) return undefined
	const content: ClineAssistantContent[] = [...reasoningContent]
	content.push({ type: "text", text: prose.trim() ? `${prose}\n\n${USER_INTERRUPTION_NOTICE}` : USER_INTERRUPTION_NOTICE })
	return { content, text: prose, ...(reasoningText ? { reasoning: reasoningText } : {}) }
}

function toolParams(input: Readonly<Record<string, unknown>>): ToolUse["params"] {
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
	) as ToolUse["params"]
}

/** Production provider executor: request preparation is injected; stream folding stays provider-domain local. */
export class DefaultProductionProviderService implements ProductionProviderService {
	private readonly identities: IdentityFactory
	private readonly nextPresentationId: () => number
	private readonly retry: ProviderRetryPolicy

	constructor(private readonly options: DefaultProductionProviderServiceOptions) {
		this.identities = options.identities ?? createIdentityFactory()
		let presentationId = Date.now()
		this.nextPresentationId = options.nextPresentationId ?? (() => ++presentationId)
		this.retry = options.retry ?? DEFAULT_PROVIDER_RETRY_POLICY
	}

	async *start(input: {
		readonly draftRef: string
		readonly draft: ProviderDraftEnvelope
		readonly turnId?: string
		readonly signal: AbortSignal
	}): AsyncIterable<ProductionProviderChunk> {
		// Prepared once: every retry below replays exactly this request, so a
		// prompt refresh or a newer journal entry cannot change a turn in flight.
		// Only a replaced handler prepares it again, for the same turn.
		const prepared = await this.options.requests.prepare(input.draft, input.signal)
		const sameTurn = { ...input.draft, turnId: prepared.turnId }
		const turn = new TurnRequest(prepared, (through) =>
			this.options.requests.prepare(through ? { ...sameTurn, journalThrough: through } : sameTurn, input.signal),
		)
		const transientId = `provider:${prepared.turnId}`
		let text = ""
		let reasoningText = ""
		let encryptedReasoningShown = false
		// Replay needs what the provider signed, not only what it said: Anthropic
		// drops an unsigned thinking block and the Responses API replays summaries
		// and encrypted items, so the same accumulator dev and subagents use folds them.
		const newReasoning = () => new StreamResponseHandler(() => Date.now()).getHandlers().reasonsHandler
		let reasoning = newReasoning()
		const nativeTools = new Map<string, PendingNativeTool>()
		// Shared by every send of this turn, before and after a first chunk.
		// A manual Retry owns this request, so its failure returns to the user
		// rather than opening a second automatic sequence.
		const retryBudget: RetryBudget = { attempts: this.retry.claimManualTakeover?.() ? this.retry.maxAttempts : 0 }
		// Set once the reply called a tool or ran a hosted one; from then on a
		// failed stream is final, because replaying it could repeat that call.
		let toolActivity = false
		// A cancelled command cannot authorize a tool in a later turn.
		const abort = () => turn.abandon()
		input.signal.addEventListener("abort", abort, { once: true })
		// Set once a turn-ending call is complete. From then on the user owns the
		// next interaction, so only the final usage is still read: anything else
		// the provider streams belongs to a continuation Dline will never render.
		let turnEnded = false
		let serverTools: ProviderServerToolPresentationSession | undefined
		let streamFailed = false
		// What the response occupies while it streams; the final usage settles it.
		let receiving = new ContextWindowReceivingTracker()
		let usage = new ProviderUsageIncrements()
		let receivingTokens = 0
		let authoritativeContextTokens = 0

		try {
			for (;;) {
				const stream = yield* this.openStream(turn, input.signal, retryBudget)
				if (!stream) return
				serverTools ??= this.options.serverTools?.begin(turn.request.serverToolContext)
				try {
					for await (const chunk of stream) {
						if (input.signal.aborted) break
						if (turnEnded && chunk.type !== "usage") {
							// Leaving the loop closes the iterator; aborting the handler also
							// ends a transport that would otherwise stay open behind it.
							turn.request.api.abort?.()
							break
						}
						switch (chunk.type) {
							case "usage":
								yield { kind: "usage", usage: usage.next(chunk) }
								break
							case "text":
								text += chunk.text
								yield { kind: "partial", transientId, text: visibleAssistantText(text) }
								break
							case "reasoning":
								reasoning.processReasoningDelta({
									provider_metadata: chunk.provider_metadata,
									reasoning: chunk.reasoning,
									signature: chunk.signature,
									details:
										chunk.details === undefined
											? []
											: Array.isArray(chunk.details)
												? chunk.details
												: [chunk.details],
									redacted_data: chunk.redacted_data,
									redacted_phase: chunk.redacted_phase,
								})
								if (!chunk.reasoning) {
									// Encrypted-only reasoning has nothing to show, but the row must
									// still open once so the chat reads it as thinking, not a stall.
									if (chunk.redacted_data && !encryptedReasoningShown && reasoningText.length === 0) {
										encryptedReasoningShown = true
										yield { kind: "partial", transientId, text: visibleAssistantText(text), reasoning: "" }
									}
									break
								}
								reasoningText += chunk.reasoning
								// Shown while it streams, as dev did: a long think is otherwise
								// indistinguishable from a stalled request.
								yield {
									kind: "partial",
									transientId,
									text: visibleAssistantText(text),
									reasoning: reasoningText,
								}
								break
							case "tool_calls":
								toolActivity = true
								this.consumeNativeTool(nativeTools, chunk)
								// The completed chunk may omit the name, so it is read from the call
								// the earlier deltas accumulated.
								if (chunk.phase === "completed" && isTurnEndingToolName(nativeTools.get(chunk.dline_tid)?.name))
									turnEnded = true
								yield {
									kind: "partial",
									transientId,
									text: visibleAssistantText(text),
									projection: {
										kind: "provider.tool_partial",
										dlineTid: chunk.dline_tid,
										toolName: chunk.tool_call.function.name,
									},
								}
								break
							case "server_tool":
								toolActivity = true
								await serverTools?.consume(chunk)
								yield {
									kind: "partial",
									transientId,
									text: visibleAssistantText(text),
									projection: {
										kind: "provider.server_tool",
										tool: chunk.tool,
										phase: chunk.phase,
										dlineTid: chunk.dline_tid,
									},
								}
								break
						}
						const estimate = receiving.apply(chunk)
						if (
							estimate.receivingTokens !== receivingTokens ||
							estimate.authoritativeContextTokens !== authoritativeContextTokens
						) {
							receivingTokens = estimate.receivingTokens
							authoritativeContextTokens = estimate.authoritativeContextTokens
							yield { kind: "receiving", receivingTokens, authoritativeContextTokens }
						}
					}
					break
				} catch (error) {
					const notice = input.signal.aborted
						? undefined
						: this.midStreamRetry(error, turn.request, retryBudget, toolActivity || turnEnded)
					if (!notice) throw error
					// The rows the failed stream showed are transient and keyed by this
					// turn's stream, so the resent stream rewrites them from scratch.
					text = ""
					reasoningText = ""
					encryptedReasoningShown = false
					reasoning = newReasoning()
					nativeTools.clear()
					receiving = new ContextWindowReceivingTracker()
					usage = new ProviderUsageIncrements()
					receivingTokens = 0
					authoritativeContextTokens = 0
					yield { kind: "retry", notice }
					const waited = await this.retry.wait(notice.delayMs, input.signal)
					if (waited !== "send" || input.signal.aborted) {
						this.retry.settled?.()
						if (waited === "handed_back") throw error
						return
					}
					await turn.refreshIfStale()
				}
			}
		} catch (error) {
			streamFailed = true
			// A stream the user stopped ends however its transport reports it.
			if (!input.signal.aborted) throw describedFailure(turn.request, error)
		} finally {
			await serverTools?.finalizeOpen(
				input.signal.aborted
					? "Provider-hosted tool cancelled before it returned a result."
					: streamFailed
						? "Provider stream failed before this hosted tool call returned a result."
						: "Provider stream ended before this hosted tool call returned a result.",
			)
			input.signal.removeEventListener("abort", abort)
		}
		if (input.signal.aborted) {
			const reasoningContent: ClineAssistantContent[] = [...reasoning.getRedactedThinking()]
			const thinking = reasoning.getCurrentReasoning()
			if (thinking) reasoningContent.push(thinking)
			const interrupted = interruptedTurn(reasoningContent, reasoningText, visibleAssistantText(text))
			if (interrupted) yield { kind: "interrupted", transientId, ...interrupted }
			return
		}

		// The request that produced the stream decides how its reply is read.
		// A provider can still return native tool_use blocks to a request that
		// described its tools as markup (Claude Code does); those calls are
		// the model's actual reply, so dropping them would lose the turn.
		const request = turn.request
		const materialized =
			request.nativeTools || nativeTools.size > 0
				? this.materializeNativeTools(nativeTools, text)
				: this.materializeXmlTools(text)
		const content: ClineAssistantContent[] = [...reasoning.getRedactedThinking()]
		const thinking = reasoning.getCurrentReasoning()
		if (thinking) content.push(thinking)
		// History records what the model actually sent. A call it wrote as markup
		// beside native tools stays markup there: turning it into a native call
		// would replay an invented call id the provider never issued.
		const historyText = request.nativeTools ? text : materialized.text
		if (historyText.trim().length > 0) content.push({ type: "text", text: historyText })
		const recorded = (tool: ToolUse) => !request.nativeTools || tool.isNativeToolCall === true
		content.push(...materialized.tools.filter(recorded).map((tool) => this.toAssistantToolUse(tool)))
		const blocks = await Promise.all(
			materialized.tools.map((tool, index) => this.createBlock(request, tool, index, recorded(tool))),
		)
		yield {
			kind: "final",
			turnId: request.turnId,
			transientId,
			text: materialized.text,
			...(reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
			content,
			...(request.modelInfo === undefined ? {} : { modelInfo: request.modelInfo }),
			mode: blocks.length > 1 ? request.mode : "serial",
			blocks,
		}
	}

	recordUsage(usage: Readonly<Record<string, number>>): void {
		this.options.onUsage?.(usage)
	}

	/**
	 * Open the request's stream, sending it again until it produces a first chunk.
	 *
	 * Only a failure before the first chunk is replayed: nothing reached the
	 * conversation or the chat yet, so the same request can simply be sent
	 * again. After that, a replay would duplicate prose or tool calls the user
	 * already saw.
	 *
	 * A deterministic tool-pairing rejection is not transient, so waiting would
	 * repeat it. The conversation is rebuilt with canonical pairing once and
	 * sent immediately; a second rejection fails the request.
	 *
	 * A handler the task replaced meanwhile (a Profile, Mode or configuration
	 * change) prepares the turn again before the next attempt. An attempt that
	 * failed after its handler was replaced is sent again at once without
	 * spending the retry budget: the replacement aborted it, or its failure
	 * belonged to a provider the task no longer uses.
	 *
	 * Returns undefined when cancellation ended the attempt.
	 */
	private async *openStream(
		turn: TurnRequest,
		signal: AbortSignal,
		budget: RetryBudget,
	): AsyncGenerator<ProductionProviderChunk, AsyncIterable<ApiStreamChunk> | undefined> {
		try {
			return yield* this.sendUntilFirstChunk(turn, signal, budget)
		} finally {
			// However the loop ends, no countdown remains for the chat to show.
			this.retry.settled?.()
		}
	}

	/**
	 * Decide whether a stream that failed after its first chunk is sent again.
	 *
	 * Only a reply that so far streamed prose or reasoning is replayed: those rows
	 * are transient and the resent stream rewrites them. A reply that called a
	 * tool, ran a hosted one or ended its turn stands as it is, since a replay
	 * could repeat that call. Returns the notice to show, or undefined when the
	 * failure is final.
	 */
	private midStreamRetry(
		error: unknown,
		request: PreparedProviderRequest,
		budget: RetryBudget,
		replyActed: boolean,
	): ProviderRetryNoticeInput | undefined {
		if (replyActed || budget.attempts >= this.retry.maxAttempts) return undefined
		const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
		if (!isRetryableProviderError(error, provider)) return undefined
		budget.attempts++
		const delayMs = this.retry.delayMs(budget.attempts)
		Logger.warn(`[provider] stream failed after its first chunk; retry ${budget.attempts} in ${delayMs}ms`, error)
		return {
			attempt: budget.attempts,
			maxAttempts: this.retry.maxAttempts,
			delayMs,
			errorMessage: describeProviderError(request, error, provider),
		}
	}

	private async *sendUntilFirstChunk(
		turn: TurnRequest,
		signal: AbortSignal,
		budget: RetryBudget,
	): AsyncGenerator<ProductionProviderChunk, AsyncIterable<ApiStreamChunk> | undefined> {
		let pairingRebuilt = false
		const messagesOf = (request: PreparedProviderRequest): ClineStorageMessage[] =>
			projectForEndpoint(request, pairingRebuilt ? repairProviderPairing(request.messages) : request.messages)
		let messages = messagesOf(turn.request)
		// The first refusal for length is truncated and resent at once; each
		// later one waits out a retry and truncates again, until the retry
		// budget is spent or nothing settled is left to remove.
		let truncated = false
		const truncate = async (): Promise<boolean> => {
			const through = await this.options.contextRecovery?.truncate(signal)
			if (!through || signal.aborted) return false
			await turn.projectThrough(through)
			messages = messagesOf(turn.request)
			Logger.warn("[provider] request exceeded the context window; resending with truncated history")
			return true
		}
		for (;;) {
			const request = turn.request
			const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
			let iterator: AsyncIterator<ApiStreamChunk> | undefined
			let failure: unknown
			try {
				const apiStream = this.bindRound(
					request.turnId,
					budget.attempts,
					request.api.createMessage(request.systemPrompt, messages, request.tools, request.options),
				)
				iterator = normalizeApiStream(apiStream, createStreamNormalizer(this.identities))[Symbol.asyncIterator]()
				const first = await iterator.next()
				if (!first.done) return continueFrom(first.value, iterator)
				failure = new Error("API stream ended without producing any content")
			} catch (error) {
				failure = error
			}
			await closeQuietly(iterator)
			if (signal.aborted) return undefined
			if (await turn.refreshIfStale()) {
				messages = messagesOf(turn.request)
				continue
			}
			if (isDeterministicToolPairingError(failure)) {
				if (pairingRebuilt) throw failure
				pairingRebuilt = true
				messages = messagesOf(request)
				Logger.warn("[provider] request rejected for tool pairing; sending it once with canonical pairing")
				continue
			}
			const truncates = checkContextWindowExceededError(failure) && this.options.contextRecovery?.enabled() === true
			if (truncates && !truncated) {
				truncated = true
				if (await truncate()) continue
				if (signal.aborted) return undefined
				throw failure
			}
			if (budget.attempts >= this.retry.maxAttempts || !(truncates || isRetryableProviderError(failure, provider)))
				throw failure
			budget.attempts++
			const retries = budget.attempts
			const delayMs = this.retry.delayMs(retries)
			Logger.warn(`[provider] request failed before its first chunk; retry ${retries} in ${delayMs}ms`, failure)
			yield {
				kind: "retry",
				notice: {
					attempt: retries,
					maxAttempts: this.retry.maxAttempts,
					delayMs,
					errorMessage: describeProviderError(request, failure, provider),
				},
			}
			const waited = await this.retry.wait(delayMs, signal)
			if (waited === "cancelled" || signal.aborted) return undefined
			// The user took the failure back, so it ends the request as an
			// exhausted budget would, and the chat offers Retry for it.
			if (waited === "handed_back") throw failure
			if (truncates) {
				if (await truncate()) continue
				if (signal.aborted) return undefined
				throw failure
			}
			if (await turn.refreshIfStale()) messages = messagesOf(turn.request)
		}
	}

	/** Count this send toward the turn's logical request round; a retry joins the round it retries. */
	private bindRound<T>(turnId: string, attempt: number, stream: AsyncGenerator<T>): AsyncGenerator<T> {
		const rounds = this.options.rounds
		if (!rounds) return stream
		const bound = rounds.bindOrdinaryAttempt(turnId, attempt, stream)
		return (async function* () {
			yield* bound
		})()
	}

	private consumeNativeTool(tools: Map<string, PendingNativeTool>, chunk: ApiStreamToolCallsChunk): void {
		const existing = tools.get(chunk.dline_tid)
		const pending = existing ?? {
			functionId: chunk.function_id,
			dlineTid: chunk.dline_tid,
			presentationId: this.nextPresentationId(),
			name: "",
			arguments: "",
		}
		if (chunk.tool_call.function.name) pending.name = chunk.tool_call.function.name
		pending.arguments = mergeArguments(pending.arguments, chunk.tool_call.function.arguments, chunk.argumentsMode)
		if (chunk.signature) pending.signature = chunk.signature
		tools.set(chunk.dline_tid, pending)
	}

	/**
	 * Native tool calls arrive beside the assistant's prose, not instead of it.
	 *
	 * The streamed text is carried through rather than dropped: a provider that
	 * answers in words and calls no tool produced a turn whose entire content was
	 * discarded here, so the reply never reached the conversation or the chat.
	 *
	 * A model offered native tools can still write a call as markup in its prose.
	 * That markup is materialized as a call like any other, so the tool gate
	 * decides it: left as text it would bypass authorization entirely and show a
	 * refused call to the user as if the model had said it.
	 */
	private materializeNativeTools(tools: Map<string, PendingNativeTool>, text: string): { text: string; tools: ToolUse[] } {
		const written = this.materializeXmlTools(text)
		return {
			text: written.text,
			tools: [
				...written.tools,
				...[...tools.values()].map(
					(tool): ToolUse => ({
						type: "tool_use",
						name: tool.name as ToolUse["name"],
						params: toolParams(parseArguments(tool.arguments)),
						partial: false,
						ts: tool.presentationId,
						isNativeToolCall: true,
						function_id: tool.functionId,
						dline_tid: tool.dlineTid,
						...(tool.signature === undefined ? {} : { signature: tool.signature }),
					}),
				),
			],
		}
	}

	private materializeXmlTools(text: string): { text: string; tools: ToolUse[] } {
		const timestamps = new Map<string, number>()
		const identities = new Map<string, { function_id: string; dline_tid: string }>()
		const blocks = parseAssistantMessageV2(text, {
			getOrCreateTsForBlock: (key) => {
				const existing = timestamps.get(key)
				if (existing !== undefined) return existing
				const created = this.nextPresentationId()
				timestamps.set(key, created)
				return created
			},
			getOrCreateToolIdentityForBlock: (key) => {
				const existing = identities.get(key)
				if (existing) return existing
				const created = { function_id: this.identities.nextFunctionId(), dline_tid: this.identities.nextTraceId() }
				identities.set(key, created)
				return created
			},
		})
		return {
			text: proseOf(blocks),
			tools: blocks.filter((block): block is ToolUse => block.type === "tool_use" && !block.partial),
		}
	}

	private async createBlock(
		request: PreparedProviderRequest,
		tool: ToolUse,
		index: number,
		recorded: boolean,
	): Promise<ProviderBlockOutput> {
		const planned = await request.planTool(tool)
		const invocation: ToolInvocationEnvelope = {
			kind: "tool_invocation",
			toolName: tool.name,
			input: tool.params,
			functionId: tool.function_id,
			dlineTid: tool.dline_tid,
			presentationId: tool.ts,
			isNativeToolCall: tool.isNativeToolCall === true,
			...(tool.signature === undefined ? {} : { signature: tool.signature }),
			...(recorded ? {} : { resultReplay: "text" as const }),
		}
		return {
			blockId: tool.dline_tid,
			attempt: planned.attempt,
			index,
			lanes: planned.lanes,
			turnEnding: planned.turnEnding,
			invocation,
			approval: planned.approval,
		}
	}

	private toAssistantToolUse(tool: ToolUse): ClineAssistantToolUseBlock {
		return {
			type: "tool_use",
			function_id: tool.function_id,
			dline_tid: tool.dline_tid,
			name: tool.name,
			input: tool.params,
			...(tool.signature === undefined ? {} : { signature: tool.signature }),
		}
	}
}
