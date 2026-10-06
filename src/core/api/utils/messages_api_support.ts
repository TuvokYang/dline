import { Anthropic } from "@anthropic-ai/sdk"
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type {
	CodeExecutionTool20260120,
	WebFetchTool20260318,
	WebSearchTool20260318,
} from "@anthropic-ai/sdk/resources/messages/messages"
import { Tool as AnthropicTool, type ToolUnion as AnthropicToolUnion } from "@anthropic-ai/sdk/resources/messages/messages"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import type { ClineAssistantHostedToolBlock } from "@/shared/messages/content"
import { ServerTool } from "@/shared/proto/dline/models/metadata"
import { OutputLimitExceededError } from "../stream/OutputLimitExceededError"
import type { ApiRawStreamServerToolChunk, ApiStream } from "../transform/stream"

export type AnthropicMessagesStreamEvent = Anthropic.RawMessageStreamEvent | BetaRawMessageStreamEvent

export interface AnthropicMessagesStreamState {
	/** Provider-native hosted calls that may complete in a later pause_turn response. */
	startedServerToolCallIds?: Set<string>
	/**
	 * Verbatim call blocks of those hosted calls, completed with their streamed input.
	 * Kept across pause_turn responses so a result arriving later still pairs with its call.
	 */
	serverToolUseBlocks?: Map<string, Record<string, unknown>>
	/**
	 * Calls an earlier logical response deferred behind client tool calls, which this request resumes.
	 * Their result opens the response without a `server_tool_use` of its own and is replayed alone.
	 */
	resumedServerToolCallIds?: Set<string>
}

/**
 * Hosted tools whose call and result are stored for replay on later requests.
 *
 * Anthropic only lets the model cite or re-fetch what it saw if those blocks come back. Sandbox
 * execution is left out: its results are bound to a provider container this request never pins.
 */
const REPLAYED_HOSTED_TOOLS: ReadonlySet<ServerTool> = new Set([ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH])

/** Whether a deferred call to this provider-native hosted tool can be carried to the next request. */
export function isResumableHostedToolName(name: unknown): boolean {
	const tool = typeof name === "string" ? SERVER_TOOL_BY_PROVIDER_NAME[name] : undefined
	return tool !== undefined && REPLAYED_HOSTED_TOOLS.has(tool)
}

/**
 * Pair a completed hosted call with its result block, consuming the stored call.
 *
 * A result for a call deferred by an earlier response is replayed alone: its call is already stored with
 * the turn that issued it.
 */
function takeHostedToolReplay(
	tool: ServerTool,
	resultBlock: { tool_use_id: string },
	serverToolUseBlocks: Map<string, Record<string, unknown>>,
	resumedServerToolCallIds: Set<string> | undefined,
): ClineAssistantHostedToolBlock | undefined {
	const callBlock = serverToolUseBlocks.get(resultBlock.tool_use_id)
	serverToolUseBlocks.delete(resultBlock.tool_use_id)
	const resumed = resumedServerToolCallIds?.delete(resultBlock.tool_use_id) === true
	if (!REPLAYED_HOSTED_TOOLS.has(tool)) return undefined
	const nativeResult = { ...(resultBlock as unknown as Record<string, unknown>) }
	if (resumed) return { type: "hosted_tool", protocol: "anthropic_messages", segment: "result", blocks: [nativeResult] }
	if (!callBlock) return undefined
	return { type: "hosted_tool", protocol: "anthropic_messages", blocks: [callBlock, nativeResult] }
}

export interface CloseOpenServerToolCallsOptions {
	/** Client `tool_use` blocks in the final response; any of them defers hosted calls of the same group. */
	clientToolCallCount: number
}

/**
 * Settle every hosted call still open when a logical response ended without continuing it.
 *
 * A response that stops for client tool calls defers its open hosted calls to the request that returns those
 * results, so a replayable call is reported `deferred` together with its call block. Every other open call
 * failed, and its stop reason is named so the gap is diagnosable.
 */
export function* closeOpenServerToolCalls(
	state: Required<AnthropicMessagesStreamState>,
	stopReason: string | null | undefined,
	options: CloseOpenServerToolCallsOptions = { clientToolCallCount: 0 },
): Generator<ApiRawStreamServerToolChunk> {
	const deferredByClientTools = stopReason === "tool_use" && options.clientToolCallCount > 0
	for (const functionId of state.startedServerToolCallIds) {
		const callBlock = state.serverToolUseBlocks.get(functionId)
		const name = callBlock?.name
		const tool = typeof name === "string" ? SERVER_TOOL_BY_PROVIDER_NAME[name] : undefined
		if (tool === undefined) continue
		if (state.resumedServerToolCallIds.has(functionId)) {
			yield failedServerToolChunk(
				functionId,
				tool,
				`Anthropic did not return the result of the deferred hosted ${name} call at the start of this response.`,
			)
			continue
		}
		if (deferredByClientTools && callBlock && REPLAYED_HOSTED_TOOLS.has(tool)) {
			yield {
				type: "server_tool",
				function_id: functionId,
				tool,
				phase: "deferred",
				input: callBlock.input,
				replay: { type: "hosted_tool", protocol: "anthropic_messages", segment: "call", blocks: [{ ...callBlock }] },
			}
			continue
		}
		const ending = stopReason ? `stop_reason: ${stopReason}` : "no stop_reason"
		yield failedServerToolChunk(
			functionId,
			tool,
			deferredByClientTools
				? `Anthropic deferred the hosted ${name} call behind a client tool call, and Dline cannot resume a deferred hosted ${name} call.`
				: `Anthropic response ended (${ending}) before the hosted ${name} call returned a result.`,
		)
	}
	state.startedServerToolCallIds.clear()
	state.serverToolUseBlocks.clear()
	state.resumedServerToolCallIds.clear()
}

function failedServerToolChunk(functionId: string, tool: ServerTool, error: string): ApiRawStreamServerToolChunk {
	return { type: "server_tool", function_id: functionId, tool, phase: "failed", error }
}

/**
 * Callers permitted to invoke the hosted tools below.
 *
 * `direct` means the model itself. Stating it explicitly keeps the request
 * independent of whatever the API defaults to, and rules out the sandbox
 * invoking web search on the model's behalf, which would charge every search
 * against the sandbox's per-turn execution budget.
 */
const directCallerOnly = (): ["direct"] => ["direct"]

/** Hosted web search, invoked by the model rather than through the sandbox. */
const anthropicWebSearchTool = (): WebSearchTool20260318 => ({
	type: "web_search_20260318",
	name: "web_search",
	allowed_callers: directCallerOnly(),
})

/** Provider-run sandbox, declared alongside web search rather than under it. */
const anthropicCodeExecutionTool = (): CodeExecutionTool20260120 => ({
	type: "code_execution_20260120",
	name: "code_execution",
	allowed_callers: directCallerOnly(),
})

/**
 * Hosted page fetch, invoked by the model rather than through the sandbox.
 *
 * Direct-only also keeps dynamic filtering off: filtering runs the fetch inside the
 * sandbox, which this request never declares on the model's behalf.
 */
const anthropicWebFetchTool = (): WebFetchTool20260318 => ({
	type: "web_fetch_20260318",
	name: "web_fetch",
	allowed_callers: directCallerOnly(),
})

interface AnthropicServerToolUsage {
	server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null
}

interface AnthropicOutputTokenDetails {
	output_tokens_details?: { thinking_tokens?: number } | null
}

/**
 * Reasoning share of `output_tokens`, which stays the inclusive billed total.
 * Returned only when the provider reports it so absent detail never reads as zero thinking.
 */
export function getThinkingTokens(usage: AnthropicOutputTokenDetails): { thoughtsTokenCount: number } | undefined {
	const thinkingTokens = usage.output_tokens_details?.thinking_tokens
	return typeof thinkingTokens === "number" && Number.isFinite(thinkingTokens)
		? { thoughtsTokenCount: Math.max(0, thinkingTokens) }
		: undefined
}

function getServerToolUsage(usage: AnthropicServerToolUsage) {
	const webSearchRequests = usage.server_tool_use?.web_search_requests
	const webFetchRequests = usage.server_tool_use?.web_fetch_requests
	const hasSearch = typeof webSearchRequests === "number"
	const hasFetch = typeof webFetchRequests === "number"
	if (!hasSearch && !hasFetch) return undefined
	return {
		...(hasSearch ? { webSearchRequests } : {}),
		...(hasFetch ? { webFetchRequests } : {}),
	}
}

/**
 * Hosted tool names this adapter maps onto a Dline server-tool lifecycle.
 *
 * The sandbox reports itself under three names depending on which surface the
 * model used, and each one closes with its own result block type below. Missing
 * any of them strands the call until the response ends.
 */
const SERVER_TOOL_BY_PROVIDER_NAME: Readonly<Record<string, ServerTool>> = {
	web_search: ServerTool.WEB_SEARCH,
	web_fetch: ServerTool.WEB_FETCH,
	code_execution: ServerTool.CODE_EXECUTION,
	bash_code_execution: ServerTool.CODE_EXECUTION,
	text_editor_code_execution: ServerTool.CODE_EXECUTION,
}

/** Result block types that terminate a hosted sandbox call. */
const CODE_EXECUTION_RESULT_BLOCK_TYPES = new Set([
	"code_execution_tool_result",
	"bash_code_execution_tool_result",
	"text_editor_code_execution_tool_result",
])

/** Every sandbox surface reports failure with its own `*_error` content type. */
function isCodeExecutionError(result: unknown): boolean {
	return (
		typeof result === "object" &&
		result !== null &&
		typeof (result as { type?: unknown }).type === "string" &&
		(result as { type: string }).type.endsWith("_tool_result_error")
	)
}

/**
 * A call issued by the sandbox rather than by the model.
 *
 * Filtering web search runs nested inside code execution, and its own result block
 * is withheld when the request excludes raw results. Such a call is therefore
 * reported through its owning sandbox call instead of as a lifecycle of its own.
 */
function isSandboxIssuedCall(caller: unknown): boolean {
	return (
		typeof caller === "object" &&
		caller !== null &&
		typeof (caller as { type?: unknown }).type === "string" &&
		(caller as { type: string }).type !== "direct"
	)
}

/** Local tool names that a hosted tool replaces while it is declared. */
const LOCAL_TOOL_REPLACED_BY_HOSTED: ReadonlyArray<readonly [ServerTool, string]> = [
	[ServerTool.WEB_SEARCH, "web_search"],
	[ServerTool.WEB_FETCH, "web_fetch"],
]

/** Names of local tools that must be withheld because a hosted tool of the same name is declared. */
function localToolsReplacedByHosted(serverTools?: readonly ServerTool[]): ReadonlySet<string> {
	return new Set(LOCAL_TOOL_REPLACED_BY_HOSTED.filter(([tool]) => serverTools?.includes(tool) === true).map(([, name]) => name))
}

/** Merge resolved hosted declarations with local Anthropic tools without exposing two tools of one name. */
export function mergeAnthropicServerTools(
	tools?: readonly AnthropicTool[],
	serverTools?: readonly ServerTool[],
): AnthropicToolUnion[] | undefined {
	const replaced = localToolsReplacedByHosted(serverTools)
	const merged: AnthropicToolUnion[] = (tools ?? []).filter((tool) => !replaced.has(tool.name)).map((tool) => ({ ...tool }))

	if (serverTools?.includes(ServerTool.WEB_SEARCH) === true) {
		merged.push(anthropicWebSearchTool())
	}
	if (serverTools?.includes(ServerTool.CODE_EXECUTION) === true) {
		merged.push(anthropicCodeExecutionTool())
	}
	if (serverTools?.includes(ServerTool.WEB_FETCH) === true) {
		merged.push(anthropicWebFetchTool())
	}

	return merged.length > 0 ? merged : undefined
}

/**
 * Native names of the hosted tools a request declares, read from the same declarations the request sends,
 * so stored hosted calls are replayed only for tools the request actually exposes.
 */
export function declaredAnthropicHostedToolNames(serverTools?: readonly ServerTool[]): ReadonlySet<string> {
	const declarations = mergeAnthropicServerTools(undefined, serverTools) ?? []
	return new Set(declarations.flatMap((tool) => ("name" in tool && typeof tool.name === "string" ? [tool.name] : [])))
}

export async function* handleAnthropicMessagesApiStreamResponse(
	stream: AsyncIterable<AnthropicMessagesStreamEvent>,
	state?: AnthropicMessagesStreamState,
): ApiStream {
	const lastStartedToolCall = { id: "", name: "", arguments: "" }
	const activeServerToolCall = { id: "", name: "", arguments: "", input: undefined as unknown }
	const startedServerToolCallIds = state?.startedServerToolCallIds ?? new Set<string>()
	const serverToolUseBlocks = state?.serverToolUseBlocks ?? new Map<string, Record<string, unknown>>()
	const resumedServerToolCallIds = state?.resumedServerToolCallIds

	for await (const chunk of stream) {
		switch (chunk?.type) {
			case "message_start": {
				const usage = chunk.message.usage
				const serverToolUsage = getServerToolUsage(usage)
				yield {
					type: "usage",
					inputTokens: usage.input_tokens || 0,
					outputTokens: usage.output_tokens || 0,
					cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
					cacheReadTokens: usage.cache_read_input_tokens || undefined,
					...getThinkingTokens(usage),
					...(serverToolUsage === undefined ? {} : { serverToolUsage }),
				}
				break
			}
			case "message_delta": {
				const serverToolUsage = getServerToolUsage(chunk.usage)
				yield {
					type: "usage",
					inputTokens: 0,
					outputTokens: chunk.usage.output_tokens || 0,
					...getThinkingTokens(chunk.usage),
					...(serverToolUsage === undefined ? {} : { serverToolUsage }),
				}
				if (chunk.delta?.stop_reason === "max_tokens") {
					throw new OutputLimitExceededError("anthropic_messages", "max_tokens")
				}
				break
			}
			case "message_stop":
				break
			case "content_block_start":
				switch (chunk.content_block.type) {
					case "thinking":
						yield {
							type: "reasoning",
							reasoning: chunk.content_block.thinking || "",
							signature: chunk.content_block.signature,
						}
						break
					case "redacted_thinking":
						// Content is encrypted, and we don't want to pass placeholder text back to the API
						yield {
							type: "reasoning",
							reasoning: "[Redacted thinking block]",
							redacted_data: chunk.content_block.data,
						}
						break
					case "tool_use":
						if (chunk.content_block.id && chunk.content_block.name) {
							activeServerToolCall.id = ""
							activeServerToolCall.name = ""
							activeServerToolCall.arguments = ""
							activeServerToolCall.input = undefined
							lastStartedToolCall.id = chunk.content_block.id
							lastStartedToolCall.name = chunk.content_block.name
							lastStartedToolCall.arguments = ""
						}
						break
					case "server_tool_use": {
						const startedTool = SERVER_TOOL_BY_PROVIDER_NAME[chunk.content_block.name]
						// A nested call has no result block of its own to close it, so opening a
						// lifecycle here would leave the UI showing work that never finishes.
						if (startedTool === undefined || isSandboxIssuedCall(chunk.content_block.caller)) {
							break
						}
						startedServerToolCallIds.add(chunk.content_block.id)
						serverToolUseBlocks.set(chunk.content_block.id, { ...chunk.content_block })
						lastStartedToolCall.id = ""
						lastStartedToolCall.name = ""
						lastStartedToolCall.arguments = ""
						activeServerToolCall.id = chunk.content_block.id
						activeServerToolCall.name = chunk.content_block.name
						activeServerToolCall.arguments = ""
						activeServerToolCall.input = chunk.content_block.input
						yield {
							type: "server_tool",
							function_id: chunk.content_block.id,
							tool: startedTool,
							phase: "started",
							input: chunk.content_block.input,
						}
						break
					}
					case "web_search_tool_result": {
						if (!startedServerToolCallIds.delete(chunk.content_block.tool_use_id)) break
						const result = chunk.content_block.content
						const failed = !Array.isArray(result) && result.type === "web_search_tool_result_error"
						const replay = takeHostedToolReplay(
							ServerTool.WEB_SEARCH,
							chunk.content_block,
							serverToolUseBlocks,
							resumedServerToolCallIds,
						)
						yield {
							type: "server_tool",
							function_id: chunk.content_block.tool_use_id,
							tool: ServerTool.WEB_SEARCH,
							phase: failed ? "failed" : "completed",
							...(failed ? { error: result } : { result }),
							...(replay ? { replay } : {}),
						}
						break
					}
					case "web_fetch_tool_result": {
						if (!startedServerToolCallIds.delete(chunk.content_block.tool_use_id)) break
						const result = chunk.content_block.content
						const failed = result.type === "web_fetch_tool_result_error"
						const replay = takeHostedToolReplay(
							ServerTool.WEB_FETCH,
							chunk.content_block,
							serverToolUseBlocks,
							resumedServerToolCallIds,
						)
						yield {
							type: "server_tool",
							function_id: chunk.content_block.tool_use_id,
							tool: ServerTool.WEB_FETCH,
							phase: failed ? "failed" : "completed",
							...(failed ? { error: result } : { result }),
							...(replay ? { replay } : {}),
						}
						break
					}
					case "code_execution_tool_result":
					case "bash_code_execution_tool_result":
					case "text_editor_code_execution_tool_result": {
						if (!startedServerToolCallIds.delete(chunk.content_block.tool_use_id)) break
						serverToolUseBlocks.delete(chunk.content_block.tool_use_id)
						resumedServerToolCallIds?.delete(chunk.content_block.tool_use_id)
						const result = chunk.content_block.content
						const failed = isCodeExecutionError(result)
						yield {
							type: "server_tool",
							function_id: chunk.content_block.tool_use_id,
							tool: ServerTool.CODE_EXECUTION,
							phase: failed ? "failed" : "completed",
							...(failed ? { error: result } : { result }),
						}
						break
					}
					case "text":
						if (chunk.index > 0) {
							yield {
								type: "text",
								text: "\n",
							}
						}
						yield {
							type: "text",
							text: chunk.content_block.text,
						}
						break
				}
				break
			case "content_block_delta":
				switch (chunk.delta.type) {
					case "thinking_delta":
						yield {
							type: "reasoning",
							reasoning: chunk.delta.thinking,
						}
						break
					case "signature_delta":
						if (chunk.delta.signature) {
							yield {
								type: "reasoning",
								reasoning: "",
								signature: chunk.delta.signature,
							}
						}
						break
					case "text_delta":
						yield {
							type: "text",
							text: chunk.delta.text,
						}
						break
					case "input_json_delta":
						if (activeServerToolCall.id && activeServerToolCall.name && chunk.delta.partial_json) {
							activeServerToolCall.arguments += chunk.delta.partial_json
						} else if (lastStartedToolCall.id && lastStartedToolCall.name && chunk.delta.partial_json) {
							yield {
								type: "tool_calls",
								function_id: lastStartedToolCall.id,
								tool_call: {
									function: {
										name: lastStartedToolCall.name,
										arguments: chunk.delta.partial_json,
									},
								},
							}
						}
						break
				}
				break
			case "content_block_stop": {
				const activeTool = SERVER_TOOL_BY_PROVIDER_NAME[activeServerToolCall.name]
				if (activeServerToolCall.id && activeTool !== undefined && activeServerToolCall.arguments) {
					try {
						const streamedInput = JSON.parse(activeServerToolCall.arguments) as unknown
						const initialInput = activeServerToolCall.input
						const input =
							initialInput &&
							typeof initialInput === "object" &&
							streamedInput &&
							typeof streamedInput === "object" &&
							!Array.isArray(initialInput) &&
							!Array.isArray(streamedInput)
								? { ...initialInput, ...streamedInput }
								: streamedInput
						const callBlock = serverToolUseBlocks.get(activeServerToolCall.id)
						if (callBlock) callBlock.input = input
						yield {
							type: "server_tool",
							function_id: activeServerToolCall.id,
							tool: activeTool,
							phase: activeTool === ServerTool.WEB_SEARCH ? "searching" : "in_progress",
							input,
						}
					} catch {
						// Ignore malformed partial input; the provider result still completes the lifecycle.
					}
				}
				lastStartedToolCall.id = ""
				lastStartedToolCall.name = ""
				lastStartedToolCall.arguments = ""
				activeServerToolCall.id = ""
				activeServerToolCall.name = ""
				activeServerToolCall.arguments = ""
				activeServerToolCall.input = undefined
				break
			}
		}
	}
}

export function convertOpenAIToolsToAnthropicTools(
	tools?: OpenAITool[],
	serverTools?: readonly ServerTool[],
): AnthropicToolUnion[] | undefined {
	const replaced = localToolsReplacedByHosted(serverTools)

	const anthropicTools: AnthropicTool[] = []

	for (const tool of tools ?? []) {
		if (tool?.type !== "function" || !tool.function?.name) {
			continue
		}
		if (replaced.has(tool.function.name)) {
			continue
		}

		const fn = tool.function

		const hasSchemaObject = fn.parameters && typeof fn.parameters === "object"
		const inputSchema = hasSchemaObject ? { ...fn.parameters } : {}
		if (typeof (inputSchema as { type?: unknown }).type !== "string") {
			;(inputSchema as { type: string }).type = "object"
		}

		anthropicTools.push({
			name: fn.name,
			description: fn.description || undefined,
			input_schema: inputSchema as AnthropicTool["input_schema"],
		})
	}

	return mergeAnthropicServerTools(anthropicTools, serverTools)
}
