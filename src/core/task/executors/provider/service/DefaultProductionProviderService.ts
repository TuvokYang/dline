import { createIdentityFactory, type IdentityFactory } from "@core/api/transform/block-identity"
import type { ApiStreamChunk, ApiStreamToolCallsChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { parseAssistantMessageV2, type ToolUse } from "@core/assistant-message"
import { isDeterministicToolPairingError } from "@core/context/context-management/compaction-retryability"
import type { ClineAssistantContent, ClineAssistantToolUseBlock, ClineStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { ClineError } from "@/services/error"
import {
	getRetryDelay,
	isRetryableProviderError,
	MAX_AUTO_RETRY_ATTEMPTS,
	type ProviderIdentity,
	waitRetryDelayUnlessAborted,
} from "../../../auto-retry"
import type {
	ProviderBlockOutput,
	ProviderDraftEnvelope,
	ToolInvocationEnvelope,
} from "../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk, ProductionProviderService } from "../ProductionProviderAdapter"
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
		const request = await this.options.requests.prepare(input.draft, input.signal)
		const transientId = `provider:${request.turnId}`
		const textParts: string[] = []
		const reasoningParts: string[] = []
		const nativeTools = new Map<string, PendingNativeTool>()
		// Abandoning the stream also withdraws the turn's one-shot authority, so a
		// cancelled command cannot authorize a tool in a later turn.
		const abort = () => {
			request.api.abort?.()
			request.authority?.cancel()
		}
		input.signal.addEventListener("abort", abort, { once: true })

		try {
			const stream = yield* this.openStream(request, input.signal)
			if (!stream) return
			for await (const chunk of stream) {
				if (input.signal.aborted) return
				switch (chunk.type) {
					case "usage":
						yield { kind: "usage", usage: usageRecord(chunk) }
						break
					case "text":
						textParts.push(chunk.text)
						yield { kind: "partial", transientId, text: visibleAssistantText(textParts.join("")) }
						break
					case "reasoning":
						if (chunk.reasoning) reasoningParts.push(chunk.reasoning)
						break
					case "tool_calls":
						this.consumeNativeTool(nativeTools, chunk)
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
		} finally {
			input.signal.removeEventListener("abort", abort)
		}
		if (input.signal.aborted) return

		const materialized = request.nativeTools
			? this.materializeNativeTools(nativeTools, textParts.join(""))
			: this.materializeXmlTools(textParts.join(""))
		const content: ClineAssistantContent[] = []
		if (reasoningParts.length > 0) content.push({ type: "thinking", thinking: reasoningParts.join(""), signature: "" })
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
			content,
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
	 * Returns undefined when cancellation ended the attempt.
	 */
	private async *openStream(
		request: PreparedProviderRequest,
		signal: AbortSignal,
	): AsyncGenerator<ProductionProviderChunk, AsyncIterable<ApiStreamChunk> | undefined> {
		const provider: ProviderIdentity = { providerId: request.api.getProviderId?.(), modelId: request.api.getModel().id }
		let messages: ClineStorageMessage[] = request.messages
		let pairingRebuilt = false
		let retries = 0
		for (;;) {
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
			if (isDeterministicToolPairingError(failure)) {
				if (pairingRebuilt) throw failure
				pairingRebuilt = true
				messages = repairProviderPairing(messages)
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
