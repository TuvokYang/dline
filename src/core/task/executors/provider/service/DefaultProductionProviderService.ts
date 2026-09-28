import { createIdentityFactory, type IdentityFactory } from "@core/api/transform/block-identity"
import type { ApiStreamChunk, ApiStreamToolCallsChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { parseAssistantMessageV2, type ToolUse } from "@core/assistant-message"
import { isDeterministicToolPairingError } from "@core/context/context-management/compaction-retryability"
import type { ClineAssistantContent, ClineAssistantToolUseBlock, ClineStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { ClineError } from "@/services/error"
import { isTurnEndingToolName } from "../../../assistant-message-order"
import {
	getRetryDelay,
	isRetryableProviderError,
	MAX_AUTO_RETRY_ATTEMPTS,
	type ProviderIdentity,
	waitRetryDelayUnlessAborted,
} from "../../../auto-retry"
import { StreamResponseHandler } from "../../../StreamResponseHandler"
import type {
	ProviderBlockOutput,
	ProviderDraftEnvelope,
	ToolInvocationEnvelope,
} from "../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk, ProductionProviderService } from "../ProductionProviderAdapter"
import { ProviderFailure } from "../ProviderFailure"
import { repairProviderPairing } from "./ProviderPairingRepair"
import type { PreparedProviderRequest, ProviderRequestFactory } from "./ProviderRequest"

interface PendingNativeTool {
	readonly functionId: string
	readonly dlineTid: string
	readonly presentationId: number
	name: string
	arguments: unknown
	signature?: string
}

/** How a request that failed before its first chunk is sent again. */
export interface ProviderRetryPolicy {
	readonly maxAttempts: number
	/** Delay before one-based retry `attempt`. */
	delayMs(attempt: number): number
	/** Resolve true once the delay elapsed, false as soon as the signal aborts. */
	wait(delayMs: number, signal: AbortSignal): Promise<boolean>
	/** The request left its retry loop: it produced a stream, failed for good, or was cancelled. */
	settled?(): void
}

/** The automatic retry schedule the chat presents: five attempts, bounded at one minute. */
export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
	maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
	delayMs: getRetryDelay,
	wait: waitRetryDelayUnlessAborted,
}

export interface DefaultProductionProviderServiceOptions {
	readonly requests: ProviderRequestFactory
	readonly identities?: IdentityFactory
	readonly nextPresentationId?: () => number
	readonly onUsage?: (usage: Readonly<Record<string, number>>) => void
	readonly retry?: ProviderRetryPolicy
}

/**
 * The request one turn sends, kept frozen across its retries.
 *
 * It is replaced only when the task replaced the handler it was prepared for:
 * the frozen prompt and tools are one provider's projection, so replaying them
 * through another provider's handler loses every tool that provider cannot
 * read. The replacement is prepared from the same draft and turn, so the
 * conversation it carries is unchanged.
 */
class TurnRequest {
	constructor(
		private current: PreparedProviderRequest,
		private readonly prepareAgain: () => Promise<PreparedProviderRequest>,
	) {}

	get request(): PreparedProviderRequest {
		return this.current
	}

	/** Prepare the turn again when its handler was replaced; true when it was. */
	async refreshIfStale(): Promise<boolean> {
		if (this.current.isCurrent?.() !== false) return false
		Logger.info("[provider] the task replaced its handler while the request waited; preparing it for the new handler")
		this.current = await this.prepareAgain()
		return true
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
async function closeQuietly(iterator: AsyncIterator<unknown> | undefined): Promise<void> {
	try {
		await iterator?.return?.(undefined)
	} catch {
		// The attempt already failed; its cleanup error carries no new information.
	}
}

function usageRecord(chunk: ApiStreamUsageChunk): Record<string, number> {
	return {
		inputTokens: chunk.inputTokens,
		outputTokens: chunk.outputTokens,
		cacheWriteTokens: chunk.cacheWriteTokens ?? 0,
		cacheReadTokens: chunk.cacheReadTokens ?? 0,
		thoughtsTokenCount: chunk.thoughtsTokenCount ?? 0,
		totalCost: chunk.totalCost ?? 0,
		webSearchRequests: chunk.serverToolUsage?.webSearchRequests ?? 0,
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
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => block.content)
		.join("\n\n")
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
	reasoning: string,
	prose: string,
): { content: ClineAssistantContent[]; text: string; reasoning?: string } | undefined {
	if (!reasoning.trim() && !prose.trim()) return undefined
	const content: ClineAssistantContent[] = []
	if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" })
	content.push({ type: "text", text: prose.trim() ? `${prose}\n\n${USER_INTERRUPTION_NOTICE}` : USER_INTERRUPTION_NOTICE })
	return { content, text: prose, ...(reasoning ? { reasoning } : {}) }
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
		const turn = new TurnRequest(prepared, () => this.options.requests.prepare(sameTurn, input.signal))
		const transientId = `provider:${prepared.turnId}`
		const textParts: string[] = []
		const reasoningParts: string[] = []
		// Replay needs what the provider signed, not only what it said: Anthropic
		// drops an unsigned thinking block and the Responses API replays summaries
		// and encrypted items, so the same accumulator dev and subagents use folds them.
		const { reasonsHandler: reasoning } = new StreamResponseHandler(() => Date.now()).getHandlers()
		const nativeTools = new Map<string, PendingNativeTool>()
		// A cancelled command cannot authorize a tool in a later turn.
		const abort = () => turn.abandon()
		input.signal.addEventListener("abort", abort, { once: true })
		// Set once a turn-ending call is complete. From then on the user owns the
		// next interaction, so only the final usage is still read: anything else
		// the provider streams belongs to a continuation Dline will never render.
		let turnEnded = false

		try {
			const stream = yield* this.openStream(turn, input.signal)
			if (!stream) return
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
						yield { kind: "usage", usage: usageRecord(chunk) }
						break
					case "text":
						textParts.push(chunk.text)
						yield { kind: "partial", transientId, text: visibleAssistantText(textParts.join("")) }
						break
					case "reasoning":
						reasoning.processReasoningDelta({
							provider_metadata: chunk.provider_metadata,
							reasoning: chunk.reasoning,
							signature: chunk.signature,
							details:
								chunk.details === undefined ? [] : Array.isArray(chunk.details) ? chunk.details : [chunk.details],
							redacted_data: chunk.redacted_data,
							redacted_phase: chunk.redacted_phase,
						})
						if (!chunk.reasoning) break
						reasoningParts.push(chunk.reasoning)
						// Shown while it streams, as dev did: a long think is otherwise
						// indistinguishable from a stalled request.
						yield {
							kind: "partial",
							transientId,
							text: visibleAssistantText(textParts.join("")),
							reasoning: reasoningParts.join(""),
						}
						break
					case "tool_calls":
						this.consumeNativeTool(nativeTools, chunk)
						// The completed chunk may omit the name, so it is read from the call
						// the earlier deltas accumulated.
						if (chunk.phase === "completed" && isTurnEndingToolName(nativeTools.get(chunk.dline_tid)?.name))
							turnEnded = true
						yield {
							kind: "partial",
							transientId,
							text: visibleAssistantText(textParts.join("")),
							projection: {
								kind: "provider.tool_partial",
								dlineTid: chunk.dline_tid,
								toolName: chunk.tool_call.function.name,
							},
						}
						break
					case "server_tool":
						yield {
							kind: "partial",
							transientId,
							text: visibleAssistantText(textParts.join("")),
							projection: {
								kind: "provider.server_tool",
								tool: chunk.tool,
								phase: chunk.phase,
								dlineTid: chunk.dline_tid,
							},
						}
						break
				}
			}
		} catch (error) {
			// A stream the user stopped ends however its transport reports it.
			if (!input.signal.aborted) throw describedFailure(turn.request, error)
		} finally {
			input.signal.removeEventListener("abort", abort)
		}
		if (input.signal.aborted) {
			const interrupted = interruptedTurn(reasoningParts.join(""), visibleAssistantText(textParts.join("")))
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
				? this.materializeNativeTools(nativeTools, textParts.join(""))
				: this.materializeXmlTools(textParts.join(""))
		const content: ClineAssistantContent[] = [...reasoning.getRedactedThinking()]
		const thinking = reasoning.getCurrentReasoning()
		if (thinking) content.push(thinking)
		// History records what the model actually sent. A call it wrote as markup
		// beside native tools stays markup there: turning it into a native call
		// would replay an invented call id the provider never issued.
		const historyText = request.nativeTools ? textParts.join("") : materialized.text
		if (historyText.trim().length > 0) content.push({ type: "text", text: historyText })
		const recorded = (tool: ToolUse) => !request.nativeTools || tool.isNativeToolCall === true
		content.push(...materialized.tools.filter(recorded).map((tool) => this.toAssistantToolUse(tool)))
		const blocks = materialized.tools.map((tool, index) => this.createBlock(request, tool, index, recorded(tool)))
		yield {
			kind: "final",
			turnId: request.turnId,
			transientId,
			text: materialized.text,
			...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join("") } : {}),
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
	): AsyncGenerator<ProductionProviderChunk, AsyncIterable<ApiStreamChunk> | undefined> {
		try {
			return yield* this.sendUntilFirstChunk(turn, signal)
		} finally {
			// However the loop ends, no countdown remains for the chat to show.
			this.retry.settled?.()
		}
	}

	private async *sendUntilFirstChunk(
		turn: TurnRequest,
		signal: AbortSignal,
	): AsyncGenerator<ProductionProviderChunk, AsyncIterable<ApiStreamChunk> | undefined> {
		let pairingRebuilt = false
		const messagesOf = (request: PreparedProviderRequest): ClineStorageMessage[] =>
			pairingRebuilt ? repairProviderPairing(request.messages) : request.messages
		let messages = messagesOf(turn.request)
		let retries = 0
		for (;;) {
			const request = turn.request
			const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
			let iterator: AsyncIterator<ApiStreamChunk> | undefined
			let failure: unknown
			try {
				const apiStream = request.api.createMessage(request.systemPrompt, messages, request.tools, request.options)
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
			if (retries >= this.retry.maxAttempts || !isRetryableProviderError(failure, provider)) throw failure
			retries++
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
			if (!(await this.retry.wait(delayMs, signal))) return undefined
			if (await turn.refreshIfStale()) messages = messagesOf(turn.request)
		}
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

	private createBlock(request: PreparedProviderRequest, tool: ToolUse, index: number, recorded: boolean): ProviderBlockOutput {
		const planned = request.planTool(tool)
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
