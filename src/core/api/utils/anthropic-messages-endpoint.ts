import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages/messages"
import type { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { ApiUsageAccumulator, type NormalizedApiUsage } from "../transform/usage-accumulator"
import {
	type AnthropicMessagesStreamEvent,
	type AnthropicMessagesStreamState,
	closeOpenServerToolCalls,
	handleAnthropicMessagesApiStreamResponse,
} from "./messages_api_support"

/** Maximum number of automatic requests one Dline request may add after pause_turn. */
export const DEFAULT_ANTHROPIC_PAUSE_TURN_CONTINUATIONS = 4

export interface AnthropicMessagesEndpointOptions {
	/** Canonical request history before the first endpoint response. */
	messages: readonly MessageParam[]
	/** Open one Messages stream while preserving the provider's request-scoped options. */
	openStream(messages: MessageParam[]): Promise<AsyncIterable<AnthropicMessagesStreamEvent>>
	/** Test and policy override; the default permits four continuation requests. */
	maxPauseTurnContinuations?: number
}

type MutableContentBlock = Record<string, unknown>

interface ServerToolUsageSnapshot {
	webSearchRequests: number
	webFetchRequests: number
	hasUsage: boolean
}

interface UsageExtensionsSnapshot {
	serverTools: ServerToolUsageSnapshot
	thoughtsTokenCount: number
	hasThoughts: boolean
	totalCost: number
	hasCost: boolean
}

function emptyUsage(): NormalizedApiUsage {
	return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
}

function emptyUsageExtensions(): UsageExtensionsSnapshot {
	return {
		serverTools: { webSearchRequests: 0, webFetchRequests: 0, hasUsage: false },
		thoughtsTokenCount: 0,
		hasThoughts: false,
		totalCost: 0,
		hasCost: false,
	}
}

function addUsage(left: NormalizedApiUsage, right: NormalizedApiUsage): NormalizedApiUsage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
		cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
	}
}

function addUsageExtensions(left: UsageExtensionsSnapshot, right: UsageExtensionsSnapshot): UsageExtensionsSnapshot {
	return {
		serverTools: {
			webSearchRequests: left.serverTools.webSearchRequests + right.serverTools.webSearchRequests,
			webFetchRequests: left.serverTools.webFetchRequests + right.serverTools.webFetchRequests,
			hasUsage: left.serverTools.hasUsage || right.serverTools.hasUsage,
		},
		thoughtsTokenCount: left.thoughtsTokenCount + right.thoughtsTokenCount,
		hasThoughts: left.hasThoughts || right.hasThoughts,
		totalCost: left.totalCost + right.totalCost,
		hasCost: left.hasCost || right.hasCost,
	}
}

function applyUsageExtensions(current: UsageExtensionsSnapshot, chunk: ApiStreamUsageChunk): void {
	const applyValue = (previous: number, value: number | undefined): number => {
		if (typeof value !== "number" || !Number.isFinite(value)) return previous
		const normalized = Math.max(0, value)
		return chunk.usageMode === "delta" ? previous + normalized : Math.max(previous, normalized)
	}

	if (chunk.serverToolUsage) {
		current.serverTools.hasUsage = true
		current.serverTools.webSearchRequests = applyValue(
			current.serverTools.webSearchRequests,
			chunk.serverToolUsage.webSearchRequests,
		)
		current.serverTools.webFetchRequests = applyValue(
			current.serverTools.webFetchRequests,
			chunk.serverToolUsage.webFetchRequests,
		)
	}
	if (typeof chunk.thoughtsTokenCount === "number" && Number.isFinite(chunk.thoughtsTokenCount)) {
		current.hasThoughts = true
		current.thoughtsTokenCount = applyValue(current.thoughtsTokenCount, chunk.thoughtsTokenCount)
	}
	if (typeof chunk.totalCost === "number" && Number.isFinite(chunk.totalCost)) {
		current.hasCost = true
		current.totalCost = applyValue(current.totalCost, chunk.totalCost)
	}
}

function cumulativeUsageChunk(
	chunk: ApiStreamUsageChunk,
	completed: NormalizedApiUsage,
	current: NormalizedApiUsage,
	completedExtensions: UsageExtensionsSnapshot,
	currentExtensions: UsageExtensionsSnapshot,
): ApiStreamUsageChunk {
	const usage = addUsage(completed, current)
	const extensions = addUsageExtensions(completedExtensions, currentExtensions)
	const cumulative: ApiStreamUsageChunk = {
		...chunk,
		usageMode: "snapshot",
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
	}
	if (usage.cacheWriteTokens > 0 || chunk.cacheWriteTokens !== undefined) {
		cumulative.cacheWriteTokens = usage.cacheWriteTokens
	}
	if (usage.cacheReadTokens > 0 || chunk.cacheReadTokens !== undefined) {
		cumulative.cacheReadTokens = usage.cacheReadTokens
	}
	if (extensions.serverTools.hasUsage) {
		cumulative.serverToolUsage = {
			webSearchRequests: extensions.serverTools.webSearchRequests,
			webFetchRequests: extensions.serverTools.webFetchRequests,
		}
	}
	if (extensions.hasThoughts) cumulative.thoughtsTokenCount = extensions.thoughtsTokenCount
	if (extensions.hasCost) cumulative.totalCost = extensions.totalCost
	return cumulative
}

function asRecord(value: unknown): MutableContentBlock | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as MutableContentBlock) : undefined
}

function mergeStreamedInput(initial: unknown, streamed: unknown): unknown {
	const initialRecord = asRecord(initial)
	const streamedRecord = asRecord(streamed)
	return initialRecord && streamedRecord ? { ...initialRecord, ...streamedRecord } : streamed
}

/** Reconstruct one streamed assistant response in the exact block order required for pause_turn replay. */
class AnthropicAssistantContentCollector {
	private readonly blocks = new Map<number, MutableContentBlock>()
	private readonly inputJson = new Map<number, string>()
	stopReason: string | null | undefined

	observe(event: AnthropicMessagesStreamEvent): void {
		switch (event.type) {
			case "message_delta": {
				const stopReason = event.delta?.stop_reason
				if (stopReason !== undefined) this.stopReason = stopReason
				break
			}
			case "content_block_start": {
				const source = asRecord(event.content_block)
				if (!source) break
				const block = { ...source }
				if (Array.isArray(source.citations)) block.citations = [...source.citations]
				this.blocks.set(event.index, block)
				break
			}
			case "content_block_delta": {
				const block = this.blocks.get(event.index)
				const delta = asRecord(event.delta)
				if (!block || !delta) break
				switch (delta.type) {
					case "text_delta":
						block.text = `${typeof block.text === "string" ? block.text : ""}${
							typeof delta.text === "string" ? delta.text : ""
						}`
						break
					case "thinking_delta":
						block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${
							typeof delta.thinking === "string" ? delta.thinking : ""
						}`
						break
					case "signature_delta":
						if (typeof delta.signature === "string") block.signature = delta.signature
						break
					case "citations_delta": {
						const citations = Array.isArray(block.citations) ? [...block.citations] : []
						if (delta.citation !== undefined) citations.push(delta.citation)
						block.citations = citations
						break
					}
					case "input_json_delta":
						if (typeof delta.partial_json === "string") {
							this.inputJson.set(event.index, `${this.inputJson.get(event.index) ?? ""}${delta.partial_json}`)
						}
						break
				}
				break
			}
		}
	}

	content(): ContentBlockParam[] {
		return [...this.blocks.entries()]
			.sort(([left], [right]) => left - right)
			.map(([index, source]) => {
				const block = { ...source }
				const streamedInput = this.inputJson.get(index)
				if (streamedInput) {
					try {
						block.input = mergeStreamedInput(block.input, JSON.parse(streamedInput) as unknown)
					} catch {
						throw new Error(`Anthropic Messages pause_turn block ${index} contained invalid streamed JSON input.`)
					}
				}
				return block as unknown as ContentBlockParam
			})
	}
}

async function* observeAnthropicStream(
	stream: AsyncIterable<AnthropicMessagesStreamEvent>,
	collector: AnthropicAssistantContentCollector,
): AsyncGenerator<AnthropicMessagesStreamEvent> {
	for await (const event of stream) {
		collector.observe(event)
		yield event
	}
}

function resolveContinuationLimit(value: number | undefined): number {
	const limit = value ?? DEFAULT_ANTHROPIC_PAUSE_TURN_CONTINUATIONS
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new Error("Anthropic Messages pause_turn continuation limit must be a non-negative safe integer.")
	}
	return limit
}

/**
 * Run one logical Anthropic Messages request, automatically continuing provider-owned pause_turn responses.
 *
 * The adapter deliberately keeps replay blocks request-local rather than adding provider-only content to Dline's
 * canonical conversation history. Each continuation receives the same request options through `openStream`, while
 * usage and hosted-tool identity remain one logical Dline request.
 */
export async function* streamAnthropicMessagesEndpoint(options: AnthropicMessagesEndpointOptions): ApiStream {
	const maxContinuations = resolveContinuationLimit(options.maxPauseTurnContinuations)
	// Hosted calls may start in one response and complete in a pause_turn continuation.
	const serverToolState: Required<AnthropicMessagesStreamState> = {
		startedServerToolCallIds: new Set<string>(),
		serverToolUseBlocks: new Map<string, Record<string, unknown>>(),
	}
	let messages = [...options.messages]
	let continuationCount = 0
	let completedUsage = emptyUsage()
	let completedExtensions = emptyUsageExtensions()

	while (true) {
		const collector = new AnthropicAssistantContentCollector()
		const requestUsage = new ApiUsageAccumulator()
		const requestExtensions = emptyUsageExtensions()
		const stream = await options.openStream(messages)

		for await (const chunk of handleAnthropicMessagesApiStreamResponse(
			observeAnthropicStream(stream, collector),
			serverToolState,
		)) {
			if (chunk.type !== "usage") {
				yield chunk
				continue
			}
			const { usage } = requestUsage.apply(chunk)
			applyUsageExtensions(requestExtensions, chunk)
			yield cumulativeUsageChunk(chunk, completedUsage, usage, completedExtensions, requestExtensions)
		}

		if (collector.stopReason !== "pause_turn") {
			yield* closeOpenServerToolCalls(serverToolState, collector.stopReason)
			return
		}
		const replayContent = collector.content()
		if (replayContent.length === 0) {
			throw new Error("Anthropic Messages returned pause_turn without assistant content to continue.")
		}
		if (continuationCount >= maxContinuations) {
			throw new Error(`Anthropic Messages exceeded the pause_turn continuation limit (${maxContinuations}).`)
		}

		completedUsage = addUsage(completedUsage, requestUsage.getUsage())
		completedExtensions = addUsageExtensions(completedExtensions, requestExtensions)
		messages = [...messages, { role: "assistant", content: replayContent }]
		continuationCount += 1
	}
}
