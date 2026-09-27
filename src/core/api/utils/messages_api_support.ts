import { Anthropic } from "@anthropic-ai/sdk"
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type {
	CodeExecutionTool20260120,
	WebFetchTool20260318,
	WebSearchTool20260318,
} from "@anthropic-ai/sdk/resources/messages/messages"
import { Tool as AnthropicTool, type ToolUnion as AnthropicToolUnion } from "@anthropic-ai/sdk/resources/messages/messages"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ServerTool } from "@/shared/proto/dline/models/metadata"
import { OutputLimitExceededError } from "../stream/OutputLimitExceededError"
import { ApiStream } from "../transform/stream"

type AnthropicMessagesStreamEvent = Anthropic.RawMessageStreamEvent | BetaRawMessageStreamEvent

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

export async function* handleAnthropicMessagesApiStreamResponse(stream: AsyncIterable<AnthropicMessagesStreamEvent>): ApiStream {
	const lastStartedToolCall = { id: "", name: "", arguments: "" }
	const activeServerToolCall = { id: "", name: "", arguments: "", input: undefined as unknown }
	const startedServerToolCallIds = new Set<string>()

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
						yield {
							type: "server_tool",
							function_id: chunk.content_block.tool_use_id,
							tool: ServerTool.WEB_SEARCH,
							phase: failed ? "failed" : "completed",
							...(failed ? { error: result } : { result }),
						}
						break
					}
					case "web_fetch_tool_result": {
						if (!startedServerToolCallIds.delete(chunk.content_block.tool_use_id)) break
						const result = chunk.content_block.content
						const failed = result.type === "web_fetch_tool_result_error"
						yield {
							type: "server_tool",
							function_id: chunk.content_block.tool_use_id,
							tool: ServerTool.WEB_FETCH,
							phase: failed ? "failed" : "completed",
							...(failed ? { error: result } : { result }),
						}
						break
					}
					case "code_execution_tool_result":
					case "bash_code_execution_tool_result":
					case "text_editor_code_execution_tool_result": {
						if (!startedServerToolCallIds.delete(chunk.content_block.tool_use_id)) break
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
