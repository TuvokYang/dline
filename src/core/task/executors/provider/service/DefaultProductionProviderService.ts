import { createIdentityFactory, type IdentityFactory } from "@core/api/transform/block-identity"
import type { ApiStreamToolCallsChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { parseAssistantMessageV2, type ToolUse } from "@core/assistant-message"
import type { ClineAssistantContent, ClineAssistantToolUseBlock } from "@shared/messages/content"
import type {
	ProviderBlockOutput,
	ProviderDraftEnvelope,
	ToolInvocationEnvelope,
} from "../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk, ProductionProviderService } from "../ProductionProviderAdapter"
import type { PreparedProviderRequest, ProviderRequestFactory } from "./ProviderRequest"

interface PendingNativeTool {
	readonly functionId: string
	readonly dlineTid: string
	readonly presentationId: number
	name: string
	arguments: unknown
	signature?: string
}

export interface DefaultProductionProviderServiceOptions {
	readonly requests: ProviderRequestFactory
	readonly identities?: IdentityFactory
	readonly nextPresentationId?: () => number
	readonly onUsage?: (usage: Readonly<Record<string, number>>) => void
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

function toolParams(input: Readonly<Record<string, unknown>>): ToolUse["params"] {
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
	) as ToolUse["params"]
}

/** Production provider executor: request preparation is injected; stream folding stays provider-domain local. */
export class DefaultProductionProviderService implements ProductionProviderService {
	private readonly identities: IdentityFactory
	private readonly nextPresentationId: () => number

	constructor(private readonly options: DefaultProductionProviderServiceOptions) {
		this.identities = options.identities ?? createIdentityFactory()
		let presentationId = Date.now()
		this.nextPresentationId = options.nextPresentationId ?? (() => ++presentationId)
	}

	async *start(input: {
		readonly draftRef: string
		readonly draft: ProviderDraftEnvelope
		readonly turnId?: string
		readonly signal: AbortSignal
	}): AsyncIterable<ProductionProviderChunk> {
		const request = await this.options.requests.prepare(input.draft, input.signal)
		const transientId = `provider:${request.turnId}`
		const textParts: string[] = []
		const reasoningParts: string[] = []
		const nativeTools = new Map<string, PendingNativeTool>()
		const apiStream = request.api.createMessage(request.systemPrompt, request.messages, request.tools, request.options)
		const stream = normalizeApiStream(apiStream, createStreamNormalizer(this.identities))
		// Abandoning the stream also withdraws the turn's one-shot authority, so a
		// cancelled command cannot authorize a tool in a later turn.
		const abort = () => {
			request.api.abort?.()
			request.authority?.cancel()
		}
		input.signal.addEventListener("abort", abort, { once: true })

		try {
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
