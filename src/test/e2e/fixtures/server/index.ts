import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { v4 as uuidv4 } from "uuid"
import type { BalanceResponse, OrganizationBalanceResponse, UserResponse } from "../../../../shared/ClineAccount"
import {
	E2E_MOCK_API_RESPONSES,
	E2E_MOCK_PROVIDER_ROUTES,
	E2E_OPENAI_IMAGE_ROUTE,
	E2E_REGISTERED_MOCK_ENDPOINTS,
	type E2EMockApiProtocol,
	type E2EMockProviderTarget,
} from "./api"
import { ClineDataMock } from "./data"
import { type MockCacheDiagnostic, type MockCacheWarning, OpenAiCacheDiagnostics } from "./openai-cache-diagnostics"
import { E2E_WORKSPACE_MCP_PATH, handleE2EWorkspaceMcpRequest } from "./workspace-mcp"

const E2E_API_SERVER_HOST = "127.0.0.1"

const useVerboseLogging = process.env.DLINE_E2E_TESTS_VERBOSE === "true"
function log(...args: unknown[]) {
	if (useVerboseLogging) {
		console.log("[ClineApiServerMock]", ...args)
	}
}

export type MockApiProtocol = E2EMockApiProtocol
export type MockApiTarget = E2EMockProviderTarget
export type { MockCacheDiagnostic, MockCacheWarning, MockCacheWarningCode } from "./openai-cache-diagnostics"

function normalizeRequestHeaders(request: IncomingMessage): Readonly<Record<string, string | string[]>> {
	return Object.fromEntries(
		Object.entries(request.headers).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
	)
}

export interface MockTokenUsage {
	/** Input tokens excluding cache reads and writes. */
	inputTokens: number
	outputTokens: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	reasoningTokens?: number
}

export interface MockToolResultExpectation {
	callId?: string
	contentIncludes: string | readonly string[]
}

export interface MockObservedToolResult {
	callId?: string
	content: string
}

export interface MockToolPairingDiagnostic {
	callIds: string[]
	outputIds: string[]
	missingOutputIds: string[]
	orphanOutputIds: string[]
	duplicateCallIds: string[]
	duplicateOutputIds: string[]
	complete: boolean
}

export interface MockToolCall {
	id?: string
	name: string
	arguments: Record<string, unknown>
}

export interface MockHostedWebSearchResult {
	title: string
	url: string
	snippet?: string
}

interface MockHostedWebSearchSource {
	url: string
	title?: string
	snippet?: string
}

type MockHostedWebSearchAction =
	| {
			type: "search"
			queries?: readonly string[]
			query?: string
			sources?: readonly MockHostedWebSearchSource[]
	  }
	| { type: "open_page"; url: string; sources?: readonly MockHostedWebSearchSource[] }
	| { type: "find_in_page"; url: string; pattern: string; sources?: readonly MockHostedWebSearchSource[] }

interface MockHostedWebSearchActionCall {
	id?: string
	action: MockHostedWebSearchAction
	results?: readonly MockHostedWebSearchResult[]
}

export interface MockSearxngSearchRequest {
	receivedAtMs: number
	query: string
	format?: string
	authorization?: string
}

export interface MockWebFetchPageRequest {
	receivedAtMs: number
	closedAtMs?: number
	authorization?: string
}

interface MockResponseOptions {
	reasoning?: string
	hiddenReasoning?: string
	delayMs?: number
	/** Keep a chat-family stream open after its first content or tool-call chunk. */
	afterChatContentDelayMs?: number
	afterReasoningDelayMs?: number
	/**
	 * Emit this many distinct Responses `reasoning` items carrying `encrypted_content`
	 * before any other output item. Long high-effort reasoning turns produce hundreds of
	 * such items, each with its own item id.
	 */
	encryptedReasoningItemCount?: number
	/** Byte length of each emitted `encrypted_content` payload. */
	encryptedReasoningChunkSize?: number
	/**
	 * In-progress snapshots emitted per reasoning item before its completed item.
	 *
	 * A real Responses stream reports one reasoning item as an `output_item.added` snapshot whose
	 * `encrypted_content` may still be incomplete, followed by the authoritative `output_item.done`.
	 * Defaults to 1.
	 */
	encryptedReasoningSnapshotsPerItem?: number
	/** Keep the stream open after all encrypted reasoning items are emitted. */
	afterEncryptedReasoningHoldMs?: number
	/** Emit a provider reasoning item after a completed function-call item. */
	afterToolCompletionReasoning?: string
	/** Delay before the post-tool reasoning item is emitted. */
	afterToolCompletionDelayMs?: number
	/** Keep the response open after the post-tool reasoning item is emitted. */
	afterToolCompletionHoldMs?: number
	/** Delay the final Provider usage event after all response content is emitted. */
	beforeUsageDelayMs?: number
	/** Keep the stream open after the final Provider usage event. */
	afterUsageHoldMs?: number
	/** Split native tool arguments into multiple provider stream events. */
	toolArgumentChunkSize?: number
	/** Delay between native tool argument stream events. */
	toolArgumentChunkDelayMs?: number
	/** Select this response by request contract instead of strict FIFO order. */
	matchRequestContract?: boolean
	usage?: MockTokenUsage
	expectedToolResults?: readonly MockToolResultExpectation[]
	expectedToolResultCount?: number
	expectedRequestIncludes?: readonly string[]
	expectedRequestExcludes?: readonly string[]
	/** Reject incomplete historical tool-call pairing like strict production Providers do. */
	requireCompleteToolPairing?: boolean
}

export type OpenAiMockResponse =
	| ({ type: "message"; text: string } & MockResponseOptions)
	| ({ type: "truncated-message"; text: string; truncateAfter?: number } & MockResponseOptions)
	| ({ type: "tool" } & MockToolCall & MockResponseOptions)
	| ({ type: "tool-with-completion-snapshots" } & MockToolCall & MockResponseOptions)
	| ({ type: "truncated-tool"; truncateAfter: number } & MockToolCall & MockResponseOptions)
	| ({ type: "tools"; tools: readonly MockToolCall[] } & MockResponseOptions)
	| ({
			type: "hosted-web-search"
			id?: string
			query: string
			results: readonly MockHostedWebSearchResult[]
			/** OpenAI Responses action sequence; other protocols keep the legacy single-search fixture. */
			actions?: readonly MockHostedWebSearchActionCall[]
			followupTools?: readonly MockToolCall[]
	  } & MockResponseOptions)
	| ({
			type: "hosted-image-generation"
			id?: string
			b64Json: string
			partialImages?: readonly string[]
			afterPartialImageDelayMs?: number
			revisedPrompt?: string
			followupTools?: readonly MockToolCall[]
	  } & MockResponseOptions)
	| ({
			type: "anthropic-orphan-web-search-result"
			id?: string
			results: readonly MockHostedWebSearchResult[]
			followupTools?: readonly MockToolCall[]
	  } & MockResponseOptions)
	| ({
			type: "usage-then-error"
			status: number
			message: string
			code?: string
			requestId?: string
			details?: Readonly<Record<string, string | number | boolean>>
	  } & MockResponseOptions)
	| {
			type: "error"
			status: number
			message: string
			code?: string
			delayMs?: number
			disconnect?: boolean
			requestId?: string
			details?: Readonly<Record<string, string | number | boolean>>
	  }

export type MockThinkingConfig = { mode: "effort"; effort: string } | { mode: "budget"; budget: number }

export interface MockApiConsumption {
	receivedAtMs: number
	authorization?: string
	requestHeaders: Readonly<Record<string, string | string[]>>
	abortedAtMs?: number
	target: MockApiTarget
	provider: string
	protocol: MockApiProtocol
	path: string
	requestBody: unknown
	requestToolResults: MockObservedToolResult[]
	requestToolPairing: MockToolPairingDiagnostic
	responseType: OpenAiMockResponse["type"]
	toolName?: string
	toolCallId?: string
	toolArguments?: Record<string, unknown>
	responseToolCalls?: readonly MockToolCall[]
	status?: number
	contractError?: string
	thinking?: MockThinkingConfig
	responseReasoning?: string
	usage?: MockTokenUsage
	cacheDiagnostic?: MockCacheDiagnostic
}

export interface MockOpenAIImageResponse {
	b64Json: string
	revisedPrompt?: string
}

export interface MockOpenAIImageConsumption {
	receivedAtMs: number
	authorization?: string
	requestHeaders: Readonly<Record<string, string | string[]>>
	path: string
	requestBody: unknown
	response: MockOpenAIImageResponse
}

export interface MockModelListRequest {
	receivedAtMs: number
	target: MockApiTarget
	path: string
	authorization?: string
	/** Anthropic authenticates model listing with `x-api-key` instead of a bearer token. */
	apiKey?: string
}

function createResponseQueues(): Record<MockApiTarget, OpenAiMockResponse[]> {
	return Object.fromEntries(Object.keys(E2E_MOCK_PROVIDER_ROUTES).map((target) => [target, []])) as Record<
		MockApiTarget,
		OpenAiMockResponse[]
	>
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4))
}

function getResponseUsage(
	response: Exclude<OpenAiMockResponse, { type: "error" }>,
	requestText: string,
	derivedCacheUsage?: Pick<MockTokenUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): MockTokenUsage {
	if (response.usage) return response.usage

	const inputTokens = derivedCacheUsage?.inputTokens ?? estimateTokens(requestText)
	const cacheReadTokens = derivedCacheUsage?.cacheReadTokens ?? 0
	const cacheWriteTokens = derivedCacheUsage?.cacheWriteTokens ?? 0
	const reasoningText = response.reasoning ?? response.hiddenReasoning ?? ""
	const reasoningTokens = reasoningText ? estimateTokens(reasoningText) : 0
	const responseText =
		response.type === "message" || response.type === "truncated-message"
			? response.text
			: getResponseToolCalls(response)
					.map((tool) => `${tool.name}\n${JSON.stringify(tool.arguments)}`)
					.join("\n")
	const outputTokens = estimateTokens(`${reasoningText}\n${responseText}`)

	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }
}

function getResponseToolCalls(response: Exclude<OpenAiMockResponse, { type: "error" }>): readonly MockToolCall[] {
	if (response.type === "tool" || response.type === "tool-with-completion-snapshots" || response.type === "truncated-tool") {
		return [response]
	}
	if (response.type === "tools") return response.tools
	if (
		response.type === "hosted-web-search" ||
		response.type === "hosted-image-generation" ||
		response.type === "anthropic-orphan-web-search-result"
	) {
		return response.followupTools ?? []
	}
	return []
}

function splitStreamText(text: string, chunkSize?: number): string[] {
	if (!chunkSize || chunkSize <= 0 || text.length <= chunkSize) return [text]
	const chunks: string[] = []
	for (let offset = 0; offset < text.length; offset += chunkSize) {
		chunks.push(text.slice(offset, offset + chunkSize))
	}
	return chunks
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringifyToolResultContent(value: unknown): string {
	if (typeof value === "string") return value
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				const record = asRecord(item)
				return typeof record?.text === "string" ? record.text : JSON.stringify(item)
			})
			.join("\n")
	}
	return value === undefined ? "" : JSON.stringify(value)
}

function duplicateIds(ids: readonly string[]): string[] {
	const counts = new Map<string, number>()
	for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
	return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
}

/** Summarize the bidirectional tool-call pairing contract of one Provider request. */
function extractRequestToolPairing(requestBody: unknown): MockToolPairingDiagnostic {
	const body = asRecord(requestBody)
	const callIds: string[] = []
	const outputIds: string[] = []
	if (body) {
		for (const value of Array.isArray(body.input) ? body.input : []) {
			const item = asRecord(value)
			if (item?.type === "function_call" && typeof item.call_id === "string") callIds.push(item.call_id)
			if (item?.type === "function_call_output" && typeof item.call_id === "string") outputIds.push(item.call_id)
		}

		for (const value of Array.isArray(body.messages) ? body.messages : []) {
			const message = asRecord(value)
			if (!message) continue
			if (message.role === "assistant") {
				for (const toolCallValue of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
					const toolCall = asRecord(toolCallValue)
					if (typeof toolCall?.id === "string") callIds.push(toolCall.id)
				}
			}
			if (message.role === "tool" && typeof message.tool_call_id === "string") outputIds.push(message.tool_call_id)
			for (const contentValue of Array.isArray(message.content) ? message.content : []) {
				const content = asRecord(contentValue)
				if (content?.type === "tool_use" && typeof content.id === "string") callIds.push(content.id)
				if (content?.type === "tool_result" && typeof content.tool_use_id === "string")
					outputIds.push(content.tool_use_id)
			}
		}
	}

	const callIdSet = new Set(callIds)
	const outputIdSet = new Set(outputIds)
	const missingOutputIds = [...callIdSet].filter((id) => !outputIdSet.has(id))
	const orphanOutputIds = [...outputIdSet].filter((id) => !callIdSet.has(id))
	const duplicateCallIds = duplicateIds(callIds)
	const duplicateOutputIds = duplicateIds(outputIds)
	return {
		callIds,
		outputIds,
		missingOutputIds,
		orphanOutputIds,
		duplicateCallIds,
		duplicateOutputIds,
		complete:
			missingOutputIds.length === 0 &&
			orphanOutputIds.length === 0 &&
			duplicateCallIds.length === 0 &&
			duplicateOutputIds.length === 0,
	}
}

function extractRequestToolResults(requestBody: unknown): MockObservedToolResult[] {
	const body = asRecord(requestBody)
	if (!body) return []
	const results: MockObservedToolResult[] = []

	for (const value of Array.isArray(body.messages) ? body.messages : []) {
		const message = asRecord(value)
		if (!message) continue
		if (message.role === "tool") {
			results.push({
				...(typeof message.tool_call_id === "string" ? { callId: message.tool_call_id } : {}),
				content: stringifyToolResultContent(message.content),
			})
		}
		for (const contentValue of Array.isArray(message.content) ? message.content : []) {
			const content = asRecord(contentValue)
			if (content?.type !== "tool_result") continue
			results.push({
				...(typeof content.tool_use_id === "string" ? { callId: content.tool_use_id } : {}),
				content: stringifyToolResultContent(content.content),
			})
		}
	}

	for (const value of Array.isArray(body.input) ? body.input : []) {
		const item = asRecord(value)
		if (item?.type !== "function_call_output") continue
		results.push({
			...(typeof item.call_id === "string" ? { callId: item.call_id } : {}),
			content: stringifyToolResultContent(item.output),
		})
	}

	return results
}

type MockRequestContractFailure = {
	kind: "request" | "tool-pairing"
	message: string
}

function validateMockRequestContract(
	response: Exclude<OpenAiMockResponse, { type: "error" }>,
	requestText: string,
	toolResults: readonly MockObservedToolResult[],
	toolPairing?: MockToolPairingDiagnostic,
): MockRequestContractFailure | undefined {
	if (response.requireCompleteToolPairing && toolPairing && !toolPairing.complete) {
		if (toolPairing.missingOutputIds[0]) {
			return {
				kind: "tool-pairing",
				message: `No tool output found for function call ${toolPairing.missingOutputIds[0]}.`,
			}
		}
		if (toolPairing.orphanOutputIds[0]) {
			return {
				kind: "tool-pairing",
				message: `No tool call found for function output ${toolPairing.orphanOutputIds[0]}.`,
			}
		}
		return {
			kind: "tool-pairing",
			message: `Duplicate tool identity found in Provider request: ${[
				...toolPairing.duplicateCallIds,
				...toolPairing.duplicateOutputIds,
			].join(", ")}`,
		}
	}
	for (const marker of response.expectedRequestIncludes ?? []) {
		if (!requestText.includes(marker)) return { kind: "request", message: `Request is missing required text: ${marker}` }
	}
	for (const marker of response.expectedRequestExcludes ?? []) {
		if (requestText.includes(marker)) return { kind: "request", message: `Request contains forbidden text: ${marker}` }
	}
	if (response.expectedToolResultCount !== undefined && toolResults.length !== response.expectedToolResultCount) {
		return {
			kind: "request",
			message: `Expected ${response.expectedToolResultCount} tool results, observed ${toolResults.length}`,
		}
	}

	for (const expectation of response.expectedToolResults ?? []) {
		const markers = Array.isArray(expectation.contentIncludes) ? expectation.contentIncludes : [expectation.contentIncludes]
		const candidates = expectation.callId ? toolResults.filter((result) => result.callId === expectation.callId) : toolResults
		if (candidates.length === 0) {
			const observedIds = toolResults.map((result) => result.callId ?? "<missing>").join(", ") || "<none>"
			return {
				kind: "request",
				message: `Tool result ${expectation.callId ?? "<any>"} was not observed; observed call IDs: ${observedIds}`,
			}
		}
		for (const marker of markers) {
			if (!candidates.some((candidate) => candidate.content.includes(marker))) {
				return {
					kind: "request",
					message: `Tool result ${expectation.callId ?? "<any>"} is missing required text: ${marker}`,
				}
			}
		}
	}
	return undefined
}

function takeMockResponse(
	queue: OpenAiMockResponse[],
	requestText: string,
	toolResults: readonly MockObservedToolResult[],
	toolPairing: MockToolPairingDiagnostic,
): OpenAiMockResponse | undefined {
	const first = queue[0]
	if (!first || first.type === "error" || !first.matchRequestContract) return queue.shift()

	const matchingIndex = queue.findIndex(
		(response) =>
			response.type !== "error" &&
			response.matchRequestContract === true &&
			validateMockRequestContract(response, requestText, toolResults, toolPairing) === undefined,
	)
	if (matchingIndex < 0) return queue.shift()
	return queue.splice(matchingIndex, 1)[0]
}

function getRequestThinking(requestBody: unknown): MockThinkingConfig | undefined {
	const body = asRecord(requestBody)
	if (!body) return undefined

	const anthropicThinking = asRecord(body.thinking)
	if (typeof anthropicThinking?.budget_tokens === "number") {
		return { mode: "budget", budget: anthropicThinking.budget_tokens }
	}
	if (typeof body.thinking_budget === "number") {
		return { mode: "budget", budget: body.thinking_budget }
	}

	const responsesReasoning = asRecord(body.reasoning)
	if (typeof responsesReasoning?.effort === "string") {
		return { mode: "effort", effort: responsesReasoning.effort }
	}
	if (typeof body.reasoning_effort === "string") {
		return { mode: "effort", effort: body.reasoning_effort }
	}

	const outputConfig = asRecord(body.output_config)
	if (typeof outputConfig?.effort === "string") {
		return { mode: "effort", effort: outputConfig.effort }
	}
	return undefined
}

function toOpenAiUsage(usage: MockTokenUsage) {
	const cacheReadTokens = usage.cacheReadTokens ?? 0
	const cacheWriteTokens = usage.cacheWriteTokens ?? 0
	const promptTokens = usage.inputTokens + cacheReadTokens + cacheWriteTokens
	return {
		prompt_tokens: promptTokens,
		completion_tokens: usage.outputTokens,
		total_tokens: promptTokens + usage.outputTokens,
		prompt_tokens_details: {
			cached_tokens: cacheReadTokens,
			cache_miss_tokens: cacheWriteTokens,
		},
		completion_tokens_details: {
			reasoning_tokens: usage.reasoningTokens ?? 0,
		},
	}
}

export class ClineApiServerMock {
	static globalSharedServer: ClineApiServerMock | null = null
	static globalSockets: Set<Socket> = new Set()

	private currentUser: UserResponse | null = null
	private userBalance = 100.5 // Default sufficient balance
	private orgBalance = 500.0
	private userHasOrganization = false
	private spendLimitExceeded = false
	private mockResponses = createResponseQueues()
	private mockConsumptions: MockApiConsumption[] = []
	private mockOpenAIImageResponses: MockOpenAIImageResponse[] = []
	private mockOpenAIImageConsumptions: MockOpenAIImageConsumption[] = []
	private mockModelListRequests: MockModelListRequest[] = []
	private mockSearxngSearchRequests: MockSearxngSearchRequest[] = []
	private mockWebFetchPageRequests: MockWebFetchPageRequest[] = []
	private readonly openAiCacheDiagnostics = new OpenAiCacheDiagnostics()
	public generationCounter = 0

	public readonly API_USER = new ClineDataMock("personal")

	constructor(
		public readonly server: Server,
		public readonly baseUrl: string,
	) {}

	// Test helper methods
	public setUserBalance(balance: number) {
		this.userBalance = balance
	}

	public setUserHasOrganization(hasOrg: boolean) {
		this.userHasOrganization = hasOrg
		const user = this.currentUser
		if (!user) {
			return
		}
		user.organizations[0].active = hasOrg
		this.setCurrentUser(user)
	}

	public setOrgBalance(balance: number) {
		this.orgBalance = balance
	}

	/**
	 * Puts the mock server into "spend limit exceeded" mode.
	 * While true, POST /api/v1/chat/completions returns 429 SPEND_LIMIT_EXCEEDED
	 * instead of a normal streaming response.
	 * Toggle off to resume normal behaviour.
	 */
	public setSpendLimitExceeded(exceeded: boolean) {
		this.spendLimitExceeded = exceeded
	}

	public enqueueOpenAiResponses(...responses: OpenAiMockResponse[]): void {
		this.enqueueResponses("openai-compatible-chat", ...responses)
	}

	public enqueueResponses(target: MockApiTarget, ...responses: OpenAiMockResponse[]): void {
		this.mockResponses[target].push(...responses)
	}

	public clearPendingResponses(target: MockApiTarget): void {
		this.mockResponses[target] = []
	}

	public enqueueOpenAIImageResponses(...responses: MockOpenAIImageResponse[]): void {
		this.mockOpenAIImageResponses.push(...responses)
	}

	public getOpenAIImageConsumptions(): readonly MockOpenAIImageConsumption[] {
		return this.mockOpenAIImageConsumptions
	}

	public resetOpenAiMock(): void {
		this.mockResponses = createResponseQueues()
		this.mockConsumptions = []
		this.mockOpenAIImageResponses = []
		this.mockOpenAIImageConsumptions = []
		this.mockModelListRequests = []
		this.mockSearxngSearchRequests = []
		this.mockWebFetchPageRequests = []
		this.openAiCacheDiagnostics.reset()
	}

	public getModelListRequests(): readonly MockModelListRequest[] {
		return this.mockModelListRequests
	}

	public getSearxngSearchRequests(): readonly MockSearxngSearchRequest[] {
		return this.mockSearxngSearchRequests
	}

	public getWebFetchPageRequests(): readonly MockWebFetchPageRequest[] {
		return this.mockWebFetchPageRequests
	}

	public get openAiRequestCount(): number {
		return this.getRequestCount("openai-compatible-chat")
	}

	public getOpenAiRequestBodies(): readonly unknown[] {
		return this.mockConsumptions
			.filter((consumption) => consumption.target === "openai-compatible-chat")
			.map((consumption) => consumption.requestBody)
	}

	public getRequestCount(target: MockApiTarget): number {
		return this.mockConsumptions.filter((consumption) => consumption.target === target).length
	}

	public getMockConsumptions(target?: MockApiTarget): readonly MockApiConsumption[] {
		return target ? this.mockConsumptions.filter((consumption) => consumption.target === target) : this.mockConsumptions
	}

	public getCacheWarnings(target?: MockApiTarget): readonly MockCacheWarning[] {
		return this.openAiCacheDiagnostics.getWarnings(target)
	}

	/** Return the complete isolated E2E cache report, including test-owned request text. */
	public getCacheDiagnosticReport(): {
		readonly generatedAt: string
		readonly requests: readonly Record<string, unknown>[]
		readonly warnings: readonly MockCacheWarning[]
	} {
		return {
			generatedAt: new Date().toISOString(),
			requests: this.mockConsumptions.flatMap((consumption, requestIndex) =>
				consumption.cacheDiagnostic
					? [
							{
								requestIndex,
								receivedAtMs: consumption.receivedAtMs,
								target: consumption.target,
								protocol: consumption.protocol,
								responseType: consumption.responseType,
								...(consumption.toolName ? { toolName: consumption.toolName } : {}),
								...(consumption.toolCallId ? { toolCallId: consumption.toolCallId } : {}),
								requestBody: consumption.requestBody,
								usage: consumption.usage,
								cacheDiagnostic: consumption.cacheDiagnostic,
							},
						]
					: [],
			),
			warnings: this.openAiCacheDiagnostics.getWarnings(),
		}
	}

	public setCurrentUser(user: UserResponse | null) {
		this.API_USER.setCurrentUser(user)
		this.currentUser = user
	}

	private consumeMockResponse(
		target: MockApiTarget,
		path: string,
		requestBody: unknown,
		authorization: string | undefined,
		requestHeaders: Readonly<Record<string, string | string[]>>,
	) {
		const receivedAtMs = Date.now()
		const route = E2E_MOCK_PROVIDER_ROUTES[target]
		const requestText = JSON.stringify(requestBody)
		const requestToolResults = extractRequestToolResults(requestBody)
		const requestToolPairing = extractRequestToolPairing(requestBody)
		const scriptedResponse = takeMockResponse(
			this.mockResponses[target],
			requestText,
			requestToolResults,
			requestToolPairing,
		) ?? {
			type: "error",
			status: 500,
			code: "e2e_mock_queue_exhausted",
			message: `No scripted E2E response remains for ${target}`,
			requestId: `req_queue_${target.replaceAll("-", "_")}`,
			details: { target, retryable: true },
		}
		const thinking = getRequestThinking(requestBody)
		const contractFailure =
			scriptedResponse.type === "error" || scriptedResponse.type === "usage-then-error"
				? undefined
				: validateMockRequestContract(scriptedResponse, requestText, requestToolResults, requestToolPairing)
		const contractError = contractFailure?.message
		const toolPairingContractFailed = contractFailure?.kind === "tool-pairing"
		const contractedResponse: OpenAiMockResponse = contractFailure
			? {
					type: "error",
					status: toolPairingContractFailed ? 400 : 500,
					code: toolPairingContractFailed ? "e2e_tool_pairing_contract_failed" : "e2e_tool_result_contract_failed",
					message: contractFailure.message,
				}
			: scriptedResponse
		const scriptedToolCall =
			scriptedResponse.type === "error" || scriptedResponse.type === "usage-then-error"
				? undefined
				: getResponseToolCalls(scriptedResponse)[0]
		log(
			"Mock provider consumption:",
			JSON.stringify({
				target,
				scriptedResponseType: scriptedResponse.type,
				scriptedToolName: scriptedToolCall?.name,
				scriptedToolCallId: scriptedToolCall?.id,
				contractError,
				remainingResponses: this.mockResponses[target].length,
				requestBytes: Buffer.byteLength(requestText, "utf8"),
			}),
		)
		const response = contractedResponse
		const derivedCacheUsage =
			response.type === "error" ? undefined : this.openAiCacheDiagnostics.deriveUsage(target, route.protocol, requestBody)
		const usage = response.type === "error" ? undefined : getResponseUsage(response, requestText, derivedCacheUsage)
		const cacheDiagnostic = usage
			? this.openAiCacheDiagnostics.observe(target, route.protocol, requestBody, usage)
			: undefined
		if (cacheDiagnostic) {
			log(
				"OpenAI cache diagnostic:",
				JSON.stringify({
					target,
					identity: cacheDiagnostic.identity,
					requestIndex: cacheDiagnostic.requestIndex,
					previousRequestIndex: cacheDiagnostic.previousRequestIndex,
					totalInputTokens: cacheDiagnostic.totalInputTokens,
					inputGrowthTokens: cacheDiagnostic.inputGrowthTokens,
					reusablePrefixTokens: cacheDiagnostic.reusablePrefixTokens,
					cacheReadTokens: cacheDiagnostic.cacheReadTokens,
					cacheReadGrowthTokens: cacheDiagnostic.cacheReadGrowthTokens,
					stablePrefixTokens: cacheDiagnostic.stablePrefixTokens,
					expectedPrefixHash: cacheDiagnostic.expectedPrefixHash,
					actualPrefixHash: cacheDiagnostic.actualPrefixHash,
					prefixHashMatched: cacheDiagnostic.prefixHashMatched,
					firstDivergence: cacheDiagnostic.firstDivergence,
					warnings: cacheDiagnostic.warnings.map(({ code }) => code),
				}),
			)
		}
		const responseToolCalls =
			response.type === "error" || response.type === "usage-then-error" ? [] : getResponseToolCalls(response)
		const consumption: MockApiConsumption = {
			receivedAtMs,
			...(authorization ? { authorization } : {}),
			requestHeaders,
			target,
			provider: route.provider,
			protocol: route.protocol,
			path,
			requestBody,
			requestToolResults,
			requestToolPairing,
			responseType: response.type,
			...(response.type === "tool" ? { toolName: response.name } : {}),
			...(response.type === "tool" && response.id ? { toolCallId: response.id } : {}),
			...(response.type === "tool" ? { toolArguments: response.arguments } : {}),
			...(responseToolCalls.length > 0
				? {
						responseToolCalls: responseToolCalls.map((tool) => ({
							...(tool.id ? { id: tool.id } : {}),
							name: tool.name,
							arguments: tool.arguments,
						})),
					}
				: {}),
			...(response.type === "error" || response.type === "usage-then-error" ? { status: response.status } : {}),
			...(contractError ? { contractError } : {}),
			...(thinking ? { thinking } : {}),
			...(route.protocol !== "openai-chat" &&
			response.type !== "error" &&
			response.type !== "usage-then-error" &&
			response.reasoning
				? { responseReasoning: response.reasoning }
				: {}),
			...(usage ? { usage } : {}),
			...(cacheDiagnostic ? { cacheDiagnostic } : {}),
		}
		this.mockConsumptions.push(consumption)
		return { response, usage, consumption }
	}

	// Helper to match routes against registered endpoints and extract parameters
	private static matchRoute(
		path: string,
		method: string,
	): {
		matched: boolean
		baseRoute?: string
		endpoint?: string
		params?: Record<string, string>
	} {
		for (const [baseRoute, methods] of Object.entries(E2E_REGISTERED_MOCK_ENDPOINTS)) {
			const methodEndpoints = methods[method as keyof typeof methods]
			if (!methodEndpoints) {
				continue
			}

			for (const endpoint of methodEndpoints) {
				const fullPattern = `${baseRoute}${endpoint}`
				const params: Record<string, string> = {}

				// Convert pattern like "/users/{userId}/balance" to a regex
				const regexPattern = fullPattern.replace(/\{([^}]+)\}/g, () => {
					return "([^/]+)"
				})

				const regex = new RegExp(`^${regexPattern}$`)
				const match = path.match(regex)

				if (match) {
					// Extract parameter names from the pattern
					const paramNames: string[] = []
					const paramRegex = /\{([^}]+)\}/g
					let paramMatch: RegExpExecArray | null = paramRegex.exec(fullPattern)
					while (paramMatch !== null) {
						paramNames.push(paramMatch[1])
						paramMatch = paramRegex.exec(fullPattern)
					}

					// Map captured groups to parameter names
					for (let i = 0; i < paramNames.length; i++) {
						params[paramNames[i]] = match[i + 1]
					}

					return {
						matched: true,
						baseRoute,
						endpoint,
						params,
					}
				}
			}
		}

		return { matched: false }
	}

	private static matchMockProviderRoute(path: string, method: string) {
		if (method !== "POST") return undefined
		for (const target of Object.keys(E2E_MOCK_PROVIDER_ROUTES) as MockApiTarget[]) {
			const route = E2E_MOCK_PROVIDER_ROUTES[target]
			if (path === `${route.basePath}${route.endpoint}`) return { target, route }
		}
		return undefined
	}

	/**
	 * Model listing endpoints mirror each vendor's real discovery path:
	 * OpenAI-compatible and DeepSeek list under `<basePath>/models`, while
	 * Anthropic lists under `<basePath>/v1/models`.
	 */
	private static matchMockModelListRoute(path: string, method: string): MockApiTarget | undefined {
		if (method !== "GET") return undefined
		for (const target of Object.keys(E2E_MOCK_PROVIDER_ROUTES) as MockApiTarget[]) {
			const route = E2E_MOCK_PROVIDER_ROUTES[target]
			if (route.provider === "anthropic") {
				if (path === `${route.basePath}/v1/models`) return target
				continue
			}
			if (path === `${route.basePath}/models`) return target
		}
		return undefined
	}

	// Starts the global shared server
	public static async startGlobalServer(): Promise<ClineApiServerMock> {
		log("=== SERVER FIXTURE CALLED ===")
		if (ClineApiServerMock.globalSharedServer) {
			log("Using existing global server")
			return ClineApiServerMock.globalSharedServer
		}

		log("Starting global server...")
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			// Parse URL and method
			const parsedUrl = new URL(req.url || "/", `http://${req.headers.host ?? E2E_API_SERVER_HOST}`)
			const path = parsedUrl.pathname
			const query = Object.fromEntries(parsedUrl.searchParams.entries())
			const method = req.method || "GET"

			// Helper to read request body
			const readBody = (): Promise<string> => {
				return new Promise((resolve) => {
					let body = ""
					req.on("data", (chunk) => {
						body += chunk.toString()
					})
					req.on("end", () => resolve(body))
				})
			}

			// Helper to send JSON response
			const sendJson = (data: unknown, status = 200, headers: Record<string, string> = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers })
				res.end(JSON.stringify(data))
			}

			// Helper to send API response
			const sendApiResponse = (data: unknown, status = 200) => {
				log(`API Response: ${JSON.stringify(data)}`)
				sendJson({ success: true, data }, status)
			}

			const sendApiError = (error: string, status = 400) => {
				sendJson({ success: false, error }, status)
			}

			// Authentication middleware
			const authHeader = req.headers.authorization
			const hasApiCredential = authHeader?.startsWith("Bearer ") || typeof req.headers["x-api-key"] === "string"
			const isAuthRequired =
				!path.startsWith("/.test/") &&
				!path.startsWith("/mock/searxng/") &&
				!path.startsWith("/mock/web-fetch/") &&
				path !== E2E_WORKSPACE_MCP_PATH &&
				path !== "/health" &&
				path !== "/api/v1/auth/token"

			if (isAuthRequired && !hasApiCredential) {
				return sendApiError("Unauthorized", 401)
			}

			const authToken = authHeader?.substring(7) // Remove "Bearer " prefix

			// Authenticate the token and set current user
			if (path.startsWith("/api/v1") && isAuthRequired && authToken) {
				log(`Authenticating token: ${authToken}`)
				const user = ClineApiServerMock.globalSharedServer?.API_USER.getUserByToken(authToken)
				if (!user) {
					return sendApiError("Invalid token", 401)
				}
				ClineApiServerMock.globalSharedServer?.setCurrentUser(user)
			}

			log("=== MOCK SERVER REQUEST ===")
			log("Method:", method)
			log("Path:", path)
			log("Query:", JSON.stringify(query))
			log("Headers:", JSON.stringify(req.headers))
			log("===============")

			// Route handling
			const handleRequest = async () => {
				const mockProviderRoute = ClineApiServerMock.matchMockProviderRoute(path, method)
				const mockModelListTarget = ClineApiServerMock.matchMockModelListRoute(path, method)
				const mockOpenAIImageRoute =
					method === "POST" && path === `${E2E_OPENAI_IMAGE_ROUTE.basePath}${E2E_OPENAI_IMAGE_ROUTE.endpoint}`
				const workspaceMcpRoute = path === E2E_WORKSPACE_MCP_PATH
				const routeMatch = ClineApiServerMock.matchRoute(path, method)

				if (
					!mockProviderRoute &&
					!mockModelListTarget &&
					!mockOpenAIImageRoute &&
					!workspaceMcpRoute &&
					!routeMatch.matched
				) {
					return sendJson({ error: "Not found" }, 404)
				}

				if (workspaceMcpRoute) {
					const body = method === "POST" ? await readBody() : ""
					await handleE2EWorkspaceMcpRequest(req, res, body ? JSON.parse(body) : undefined)
					return
				}

				const { baseRoute, endpoint, params = {} } = routeMatch
				const controller = ClineApiServerMock.globalSharedServer!

				if (baseRoute === "/mock/web-fetch" && endpoint === "/page" && method === "GET") {
					const pageRequest: MockWebFetchPageRequest = {
						receivedAtMs: Date.now(),
						...(authHeader ? { authorization: authHeader } : {}),
					}
					controller.mockWebFetchPageRequests.push(pageRequest)
					const delayMs = Number.parseInt(parsedUrl.searchParams.get("delayMs") ?? "0", 10)
					if (Number.isFinite(delayMs) && delayMs > 0) {
						await new Promise<void>((resolve) => {
							const onClose = () => {
								pageRequest.closedAtMs = Date.now()
								clearTimeout(timer)
								resolve()
							}
							const timer = setTimeout(() => {
								res.off("close", onClose)
								resolve()
							}, delayMs)
							res.once("close", onClose)
						})
						if (res.destroyed || res.writableEnded) return
					}
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
					const longContent = Array.from(
						{ length: 32 },
						(_, index) => `<p>E2E_WEB_FETCH_PAGE_CONTENT_${index.toString().padStart(2, "0")}</p>`,
					).join("")
					res.end(
						`<!doctype html><html><body><nav>REMOVE_NAVIGATION</nav><main><h1>Dline local Web Fetch</h1>${longContent}</main><script>REMOVE_SCRIPT</script></body></html>`,
					)
					return
				}

				if (baseRoute === "/mock/searxng" && endpoint === "/search" && method === "GET") {
					const searchQuery = parsedUrl.searchParams.get("q")?.trim()
					if (!searchQuery) return sendJson({ error: "Search query is required" }, 400)
					controller.mockSearxngSearchRequests.push({
						receivedAtMs: Date.now(),
						query: searchQuery,
						...(parsedUrl.searchParams.get("format") ? { format: parsedUrl.searchParams.get("format")! } : {}),
						...(authHeader ? { authorization: authHeader } : {}),
					})
					return sendJson({
						results: Array.from({ length: 24 }, (_, index) => ({
							title:
								index === 0
									? `E2E local result for ${searchQuery}`
									: `E2E local result ${index} for ${searchQuery}`,
							url:
								index === 0
									? "https://example.test/dline-local-search"
									: `https://example.test/dline-local-search/${index}`,
							content: `E2E local snippet ${index} for ${searchQuery}`,
						})),
					})
				}

				if (mockOpenAIImageRoute) {
					const body = await readBody()
					const parsed = JSON.parse(body) as Record<string, unknown>
					if (typeof parsed.model !== "string" || typeof parsed.prompt !== "string") {
						return sendJson({ error: { message: "Invalid OpenAI image request shape" } }, 400)
					}
					const response = controller.mockOpenAIImageResponses.shift()
					if (!response) {
						return sendJson(
							{ error: { message: "No scripted E2E image response remains", code: "e2e_image_queue_exhausted" } },
							500,
						)
					}
					controller.mockOpenAIImageConsumptions.push({
						receivedAtMs: Date.now(),
						...(authHeader ? { authorization: authHeader } : {}),
						requestHeaders: normalizeRequestHeaders(req),
						path,
						requestBody: parsed,
						response,
					})
					return sendJson({
						created: Math.floor(Date.now() / 1_000),
						data: [
							{
								b64_json: response.b64Json,
								...(response.revisedPrompt ? { revised_prompt: response.revisedPrompt } : {}),
							},
						],
					})
				}

				if (mockModelListTarget) {
					const listRoute = E2E_MOCK_PROVIDER_ROUTES[mockModelListTarget]
					const apiKeyHeader = req.headers["x-api-key"]
					controller.mockModelListRequests.push({
						receivedAtMs: Date.now(),
						target: mockModelListTarget,
						path,
						...(authHeader ? { authorization: authHeader } : {}),
						...(typeof apiKeyHeader === "string" ? { apiKey: apiKeyHeader } : {}),
					})
					if (listRoute.provider === "anthropic") {
						return sendJson({
							data: [
								{ type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
								{ type: "model", id: "dline-e2e-discovered-model", display_name: "Dline E2E Discovered" },
							],
							has_more: false,
						})
					}
					if (listRoute.provider === "deepseek") {
						return sendJson({
							object: "list",
							data: [
								{ id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
								{ id: "dline-e2e-discovered-model", object: "model", owned_by: "deepseek" },
							],
						})
					}
					return sendJson({
						object: "list",
						data: [
							{ id: "dline-e2e-model", object: "model" },
							{ id: "dline-e2e-discovered-model", object: "model" },
						],
					})
				}

				if (mockProviderRoute) {
					const { target, route } = mockProviderRoute
					const protocol = route.protocol
					if (route.auth === "bearer" && !authHeader?.startsWith("Bearer ")) {
						return sendJson({ error: { message: "Bearer authentication required" } }, 401)
					}
					if (route.auth === "x-api-key") {
						if (typeof req.headers["x-api-key"] !== "string") {
							return sendJson(
								{ type: "error", error: { type: "authentication_error", message: "x-api-key required" } },
								401,
							)
						}
						if (typeof req.headers["anthropic-version"] !== "string") {
							return sendJson(
								{
									type: "error",
									error: { type: "invalid_request_error", message: "anthropic-version required" },
								},
								400,
							)
						}
					}
					const body = await readBody()
					const parsed = JSON.parse(body) as Record<string, unknown> & { model?: string; stream?: boolean }
					const hasMessages = Array.isArray(parsed.messages)
					const hasResponsesInput = typeof parsed.input === "string" || Array.isArray(parsed.input)
					const validRequest =
						((protocol === "openai-chat" || protocol === "deepseek-chat") && hasMessages) ||
						(protocol === "openai-responses" && hasResponsesInput) ||
						(protocol === "anthropic-messages" && hasMessages && typeof parsed.max_tokens === "number")
					if (!validRequest) {
						return sendJson({ error: { message: `Invalid ${target} request shape` } }, 400)
					}
					const {
						response: scriptedResponse,
						usage,
						consumption,
					} = controller.consumeMockResponse(target, path, parsed, authHeader, normalizeRequestHeaders(req))
					const markAborted = () => {
						if (!res.writableFinished) consumption.abortedAtMs ??= Date.now()
					}
					req.once("aborted", markAborted)
					res.once("close", markAborted)
					const generationId = `e2e_${++controller.generationCounter}_${Date.now()}`
					const model = parsed.model ?? "dline-e2e-model"

					if (scriptedResponse.delayMs) {
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, scriptedResponse.delayMs)
							res.once("close", () => {
								clearTimeout(timer)
								resolve()
							})
						})
						if (res.destroyed || res.writableEnded) return
					}
					if (res.destroyed || res.writableEnded) return

					if (scriptedResponse.type === "error") {
						if (scriptedResponse.disconnect) {
							res.destroy()
							return
						}
						const code = scriptedResponse.code ?? `http_${scriptedResponse.status}`
						const requestMetadata = scriptedResponse.requestId
							? { request_id: scriptedResponse.requestId }
							: undefined
						const headers = {
							...(scriptedResponse.status === 429 ? { "Retry-After": "0" } : {}),
							...(scriptedResponse.requestId ? { "x-request-id": scriptedResponse.requestId } : {}),
						}
						return sendJson(
							protocol === "anthropic-messages"
								? {
										type: "error",
										error: { type: code, message: scriptedResponse.message, ...scriptedResponse.details },
										...requestMetadata,
									}
								: {
										error: {
											message: scriptedResponse.message,
											type: "e2e_mock_error",
											code,
											...scriptedResponse.details,
										},
										...requestMetadata,
									},
							scriptedResponse.status,
							Object.keys(headers).length > 0 ? headers : undefined,
						)
					}

					if (!usage) throw new Error(`Successful ${target} response is missing usage`)
					if (scriptedResponse.type === "usage-then-error" && protocol !== "anthropic-messages") {
						throw new Error(`usage-then-error is only supported for anthropic-messages, received ${protocol}`)
					}
					const openAiUsage = toOpenAiUsage(usage)
					const chatUsage =
						protocol === "deepseek-chat"
							? {
									...openAiUsage,
									prompt_cache_hit_tokens: usage.cacheReadTokens ?? 0,
									prompt_cache_miss_tokens: usage.cacheWriteTokens ?? 0,
								}
							: openAiUsage
					const messageText =
						scriptedResponse.type === "message" || scriptedResponse.type === "truncated-message"
							? scriptedResponse.text
							: ""
					const responseToolCalls = getResponseToolCalls(scriptedResponse)
					const writeSse = (data: unknown, event?: string) => {
						if (res.destroyed || res.writableEnded) return
						res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
					}
					const waitForOpenConnection = async (delayMs?: number): Promise<boolean> => {
						if (!delayMs) return !(res.destroyed || res.writableEnded)
						await new Promise<void>((resolve) => {
							const onClose = () => {
								clearTimeout(timer)
								resolve()
							}
							const timer = setTimeout(() => {
								res.off("close", onClose)
								resolve()
							}, delayMs)
							res.once("close", onClose)
						})
						return !(res.destroyed || res.writableEnded)
					}
					const waitAfterReasoning = (): Promise<boolean> =>
						waitForOpenConnection(scriptedResponse.afterReasoningDelayMs)

					if (protocol === "openai-chat" || protocol === "deepseek-chat") {
						const toolCalls = responseToolCalls.map((tool, index) => ({
							index,
							id: tool.id ?? `call_${generationId}_${index}`,
							type: "function",
							function: {
								name: tool.name,
								arguments: JSON.stringify(tool.arguments),
							},
						}))
						const reasoningContent = protocol === "deepseek-chat" ? scriptedResponse.reasoning : undefined
						const streamedMessageText =
							scriptedResponse.type === "truncated-message"
								? messageText.slice(0, scriptedResponse.truncateAfter ?? messageText.length)
								: messageText
						const responseDelta = {
							role: "assistant",
							...(toolCalls.length > 0 ? { tool_calls: toolCalls } : { content: streamedMessageText }),
						}
						if (parsed.stream !== false) {
							res.writeHead(200, {
								"Content-Type": "text/event-stream",
								"Cache-Control": "no-cache",
								Connection: "keep-alive",
							})
							const writeChunk = (choices: unknown, chunkUsage?: unknown) =>
								writeSse({
									id: generationId,
									object: "chat.completion.chunk",
									created: Math.floor(Date.now() / 1000),
									model,
									choices,
									...(chunkUsage ? { usage: chunkUsage } : {}),
								})
							if (reasoningContent && scriptedResponse.afterReasoningDelayMs) {
								writeChunk([
									{
										index: 0,
										delta: { role: "assistant", reasoning_content: reasoningContent },
										finish_reason: null,
									},
								])
								if (!(await waitAfterReasoning())) return
								writeChunk([{ index: 0, delta: responseDelta, finish_reason: null }])
							} else if (toolCalls.length > 0 && scriptedResponse.toolArgumentChunkSize) {
								for (const [toolIndex, toolCall] of toolCalls.entries()) {
									const argumentChunks = splitStreamText(
										toolCall.function.arguments,
										scriptedResponse.toolArgumentChunkSize,
									)
									for (const [chunkIndex, argumentChunk] of argumentChunks.entries()) {
										writeChunk([
											{
												index: toolIndex,
												delta: {
													...(chunkIndex === 0
														? {
																role: "assistant",
																tool_calls: [
																	{
																		index: toolIndex,
																		id: toolCall.id,
																		type: "function",
																		function: {
																			name: toolCall.function.name,
																			arguments: argumentChunk,
																		},
																	},
																],
															}
														: {
																tool_calls: [
																	{
																		index: toolIndex,
																		function: { arguments: argumentChunk },
																	},
																],
															}),
												},
												finish_reason: null,
											},
										])
										if (!(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) return
									}
								}
							} else {
								writeChunk([
									{
										index: 0,
										delta: {
											...responseDelta,
											...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
										},
										finish_reason: null,
									},
								])
							}
							if (!(await waitForOpenConnection(scriptedResponse.afterChatContentDelayMs))) return
							if (scriptedResponse.type === "truncated-message") {
								res.destroy()
								return
							}
							writeChunk(
								[
									{
										index: 0,
										delta: {},
										finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
									},
								],
								chatUsage,
							)
							res.end("data: [DONE]\n\n")
							return
						}

						return sendJson({
							id: generationId,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model,
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: toolCalls.length > 0 ? null : messageText,
										...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
										...(toolCalls.length > 0
											? { tool_calls: toolCalls.map(({ index: _, ...tool }) => tool) }
											: {}),
									},
									finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
								},
							],
							usage: chatUsage,
						})
					}

					if (protocol === "openai-responses") {
						const reasoningItemId = `reasoning_${generationId}`
						const reasoningItem = scriptedResponse.reasoning
							? {
									id: reasoningItemId,
									type: "reasoning",
									status: "completed",
									summary: [{ type: "summary_text", text: scriptedResponse.reasoning }],
								}
							: undefined
						const outputOffset = reasoningItem ? 1 : 0
						const toolOutputItems = responseToolCalls.map((tool, index) => ({
							id: `item_${generationId}_${index}`,
							type: "function_call",
							status: "completed",
							call_id: tool.id ?? `call_${generationId}_${index}`,
							name: tool.name,
							arguments: JSON.stringify(tool.arguments),
						}))
						const messageOutputItem = {
							id: `item_${generationId}`,
							type: "message",
							status: "completed",
							role: "assistant",
							content: [{ type: "output_text", text: messageText, annotations: [] }],
						}
						const hostedSearchOutputItems =
							scriptedResponse.type === "hosted-web-search"
								? (
										scriptedResponse.actions ?? [
											{
												id: scriptedResponse.id,
												action: { type: "search" as const, query: scriptedResponse.query },
												results: scriptedResponse.results,
											},
										]
									).map((call, index) => ({
										id: call.id ?? `ws_${generationId}_${index}`,
										type: "web_search_call",
										status: "completed",
										action: call.action,
										...(call.results
											? {
													results: call.results.map(({ title, url, snippet }) => ({
														title,
														url,
														...(snippet ? { snippet } : {}),
													})),
												}
											: {}),
									}))
								: []
						const hostedImageOutputItems =
							scriptedResponse.type === "hosted-image-generation"
								? [
										{
											id: scriptedResponse.id ?? `ig_${generationId}`,
											type: "image_generation_call",
											status: "completed",
											result: scriptedResponse.b64Json,
											...(scriptedResponse.revisedPrompt
												? { revised_prompt: scriptedResponse.revisedPrompt }
												: {}),
										},
									]
								: []
						const ordinaryOutputItems = toolOutputItems.length > 0 ? toolOutputItems : [messageOutputItem]
						const outputItems = [...hostedSearchOutputItems, ...hostedImageOutputItems, ...ordinaryOutputItems]
						const response = {
							id: generationId,
							object: "response",
							created_at: Math.floor(Date.now() / 1000),
							status: "completed",
							model,
							output: reasoningItem ? [reasoningItem, ...outputItems] : outputItems,
							output_text: scriptedResponse.type === "message" ? scriptedResponse.text : "",
							usage: {
								input_tokens: openAiUsage.prompt_tokens,
								input_tokens_details: openAiUsage.prompt_tokens_details,
								output_tokens: usage.outputTokens,
								output_tokens_details: openAiUsage.completion_tokens_details,
								total_tokens: openAiUsage.total_tokens,
							},
						}
						if (parsed.stream === false) return sendJson(response)

						res.writeHead(200, {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							Connection: "keep-alive",
						})
						if (reasoningItem) {
							writeSse(
								{
									type: "response.output_item.added",
									output_index: 0,
									item: { ...reasoningItem, status: "in_progress", summary: [] },
								},
								"response.output_item.added",
							)
							writeSse(
								{
									type: "response.reasoning_summary_part.added",
									item_id: reasoningItemId,
									output_index: 0,
									summary_index: 0,
									part: { type: "summary_text", text: "" },
								},
								"response.reasoning_summary_part.added",
							)
							writeSse(
								{
									type: "response.reasoning_summary_text.delta",
									item_id: reasoningItemId,
									output_index: 0,
									summary_index: 0,
									delta: scriptedResponse.reasoning,
								},
								"response.reasoning_summary_text.delta",
							)
							writeSse(
								{
									type: "response.reasoning_summary_part.done",
									item_id: reasoningItemId,
									output_index: 0,
									summary_index: 0,
									part: reasoningItem.summary[0],
								},
								"response.reasoning_summary_part.done",
							)
							writeSse(
								{ type: "response.output_item.done", output_index: 0, item: reasoningItem },
								"response.output_item.done",
							)
							if (!(await waitAfterReasoning())) return
						}
						// Long high-effort reasoning turns stream many separate reasoning items,
						// each carrying its own encrypted_content and item id.
						if (scriptedResponse.encryptedReasoningItemCount) {
							const encryptedPayload = "E".repeat(scriptedResponse.encryptedReasoningChunkSize ?? 1_292)
							const snapshotsPerItem = Math.max(1, scriptedResponse.encryptedReasoningSnapshotsPerItem ?? 1)
							for (let index = 0; index < scriptedResponse.encryptedReasoningItemCount; index++) {
								const encryptedItemId = `rs_${generationId}_${index}`
								// In-progress snapshots carry a growing, still-incomplete payload.
								for (let snapshot = 1; snapshot <= snapshotsPerItem; snapshot++) {
									writeSse(
										{
											type: "response.output_item.added",
											output_index: 0,
											item: {
												id: encryptedItemId,
												type: "reasoning",
												status: "in_progress",
												summary: [],
												encrypted_content: encryptedPayload.slice(
													0,
													Math.max(
														1,
														Math.floor((encryptedPayload.length * snapshot) / snapshotsPerItem),
													),
												),
											},
										},
										"response.output_item.added",
									)
									if (res.destroyed || res.writableEnded) return
								}
								writeSse(
									{
										type: "response.output_item.done",
										output_index: 0,
										item: {
											id: encryptedItemId,
											type: "reasoning",
											status: "completed",
											summary: [],
											encrypted_content: encryptedPayload,
										},
									},
									"response.output_item.done",
								)
								if (res.destroyed || res.writableEnded) return
							}
							if (!(await waitForOpenConnection(scriptedResponse.afterEncryptedReasoningHoldMs))) return
						}
						for (const [index, hostedSearchOutputItem] of hostedSearchOutputItems.entries()) {
							const outputIndex = outputOffset + index
							const startedItem = {
								...hostedSearchOutputItem,
								status: "in_progress",
							}
							writeSse(
								{ type: "response.output_item.added", output_index: outputIndex, item: startedItem },
								"response.output_item.added",
							)
							for (const type of [
								"response.web_search_call.in_progress",
								"response.web_search_call.searching",
								"response.web_search_call.completed",
							]) {
								writeSse({ type, item_id: hostedSearchOutputItem.id, output_index: outputIndex }, type)
							}
							writeSse(
								{ type: "response.output_item.done", output_index: outputIndex, item: hostedSearchOutputItem },
								"response.output_item.done",
							)
						}
						for (const [index, hostedImageOutputItem] of hostedImageOutputItems.entries()) {
							const outputIndex = outputOffset + hostedSearchOutputItems.length + index
							writeSse(
								{
									type: "response.output_item.added",
									output_index: outputIndex,
									item: { ...hostedImageOutputItem, status: "in_progress", result: null },
								},
								"response.output_item.added",
							)
							for (const type of [
								"response.image_generation_call.in_progress",
								"response.image_generation_call.generating",
							]) {
								writeSse({ type, item_id: hostedImageOutputItem.id, output_index: outputIndex }, type)
							}
							if (scriptedResponse.type === "hosted-image-generation") {
								for (const [partialImageIndex, partialImageB64] of (
									scriptedResponse.partialImages ?? []
								).entries()) {
									const type = "response.image_generation_call.partial_image"
									writeSse(
										{
											type,
											item_id: hostedImageOutputItem.id,
											output_index: outputIndex,
											partial_image_b64: partialImageB64,
											partial_image_index: partialImageIndex,
										},
										type,
									)
									if (!(await waitForOpenConnection(scriptedResponse.afterPartialImageDelayMs))) return
								}
							}
							const completedType = "response.image_generation_call.completed"
							writeSse(
								{ type: completedType, item_id: hostedImageOutputItem.id, output_index: outputIndex },
								completedType,
							)
							writeSse(
								{ type: "response.output_item.done", output_index: outputIndex, item: hostedImageOutputItem },
								"response.output_item.done",
							)
						}
						if (toolOutputItems.length > 0) {
							for (const [index, outputItem] of toolOutputItems.entries()) {
								const outputIndex =
									outputOffset + hostedSearchOutputItems.length + hostedImageOutputItems.length + index
								writeSse(
									{
										type: "response.output_item.added",
										output_index: outputIndex,
										item: { ...outputItem, arguments: "" },
									},
									"response.output_item.added",
								)
								const deltaArguments =
									scriptedResponse.type === "truncated-tool"
										? outputItem.arguments.slice(0, scriptedResponse.truncateAfter)
										: outputItem.arguments
								const argumentChunks = splitStreamText(deltaArguments, scriptedResponse.toolArgumentChunkSize)
								for (const argumentChunk of argumentChunks) {
									writeSse(
										{
											type: "response.function_call_arguments.delta",
											item_id: outputItem.id,
											output_index: outputIndex,
											delta: argumentChunk,
										},
										"response.function_call_arguments.delta",
									)
									if (!(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) return
								}
								if (scriptedResponse.type === "tool-with-completion-snapshots") {
									writeSse(
										{
											type: "response.function_call_arguments.done",
											item_id: outputItem.id,
											output_index: outputIndex,
											name: outputItem.name,
											arguments: outputItem.arguments,
										},
										"response.function_call_arguments.done",
									)
									writeSse(
										{ type: "response.output_item.done", output_index: outputIndex, item: outputItem },
										"response.output_item.done",
									)
								}
							}
							if (scriptedResponse.afterToolCompletionReasoning) {
								if (!(await waitForOpenConnection(scriptedResponse.afterToolCompletionDelayMs))) return
								const reasoningOutputIndex =
									outputOffset +
									hostedSearchOutputItems.length +
									hostedImageOutputItems.length +
									toolOutputItems.length
								const postToolReasoningItem = {
									id: `reasoning_after_tool_${generationId}`,
									type: "reasoning",
									status: "completed",
									summary: [{ type: "summary_text", text: scriptedResponse.afterToolCompletionReasoning }],
								}
								writeSse(
									{
										type: "response.output_item.added",
										output_index: reasoningOutputIndex,
										item: { ...postToolReasoningItem, status: "in_progress", summary: [] },
									},
									"response.output_item.added",
								)
								writeSse(
									{
										type: "response.reasoning_summary_part.added",
										item_id: postToolReasoningItem.id,
										output_index: reasoningOutputIndex,
										summary_index: 0,
										part: { type: "summary_text", text: "" },
									},
									"response.reasoning_summary_part.added",
								)
								writeSse(
									{
										type: "response.reasoning_summary_text.delta",
										item_id: postToolReasoningItem.id,
										output_index: reasoningOutputIndex,
										summary_index: 0,
										delta: scriptedResponse.afterToolCompletionReasoning,
									},
									"response.reasoning_summary_text.delta",
								)
								writeSse(
									{
										type: "response.reasoning_summary_part.done",
										item_id: postToolReasoningItem.id,
										output_index: reasoningOutputIndex,
										summary_index: 0,
										part: postToolReasoningItem.summary[0],
									},
									"response.reasoning_summary_part.done",
								)
								writeSse(
									{
										type: "response.output_item.done",
										output_index: reasoningOutputIndex,
										item: postToolReasoningItem,
									},
									"response.output_item.done",
								)
								if (!(await waitForOpenConnection(scriptedResponse.afterToolCompletionHoldMs))) return
							}
						} else {
							const outputIndex = outputOffset + hostedSearchOutputItems.length + hostedImageOutputItems.length
							writeSse(
								{
									type: "response.output_item.added",
									output_index: outputIndex,
									item: messageOutputItem,
								},
								"response.output_item.added",
							)
							writeSse(
								{
									type: "response.output_text.delta",
									item_id: messageOutputItem.id,
									output_index: outputIndex,
									content_index: 0,
									delta: messageText,
								},
								"response.output_text.delta",
							)
						}
						if (scriptedResponse.type === "truncated-tool") {
							writeSse(
								{
									type: "response.incomplete",
									response: {
										...response,
										status: "incomplete",
										incomplete_details: { reason: "max_output_tokens" },
									},
								},
								"response.incomplete",
							)
							res.end()
							return
						}
						if (!(await waitForOpenConnection(scriptedResponse.beforeUsageDelayMs))) return
						writeSse({ type: "response.completed", response }, "response.completed")
						if (!(await waitForOpenConnection(scriptedResponse.afterUsageHoldMs))) return
						res.end()
						return
					}

					const messageUsage = {
						input_tokens: usage.inputTokens,
						output_tokens: 0,
						cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
						cache_read_input_tokens: usage.cacheReadTokens ?? 0,
						...(scriptedResponse.type === "hosted-web-search"
							? {
									server_tool_use: {
										web_search_requests: scriptedResponse.actions?.length ?? 1,
										web_fetch_requests: 0,
									},
								}
							: {}),
					}
					const ordinaryContentBlocks =
						responseToolCalls.length > 0
							? responseToolCalls.map((tool, index) => ({
									id: tool.id ?? `toolu_${generationId}_${index}`,
									type: "tool_use",
									name: tool.name,
									input: tool.arguments,
								}))
							: [{ type: "text", text: messageText }]
					const hostedSearchId =
						scriptedResponse.type === "hosted-web-search" ||
						scriptedResponse.type === "anthropic-orphan-web-search-result"
							? (scriptedResponse.id ?? `srv_web_${generationId}`)
							: undefined
					const hostedResultBlock =
						hostedSearchId &&
						(scriptedResponse.type === "hosted-web-search" ||
							scriptedResponse.type === "anthropic-orphan-web-search-result")
							? {
									type: "web_search_tool_result",
									tool_use_id: hostedSearchId,
									content: scriptedResponse.results.map((result) => ({
										type: "web_search_result",
										url: result.url,
										title: result.title,
										...(result.snippet ? { snippet: result.snippet } : {}),
										page_age: null,
										encrypted_content: `e2e:${result.url}`,
									})),
									caller: { type: "direct" },
								}
							: undefined
					const hostedContentBlocks =
						scriptedResponse.type === "hosted-web-search" && hostedSearchId && hostedResultBlock
							? [
									{
										type: "server_tool_use",
										id: hostedSearchId,
										name: "web_search",
										input: { query: scriptedResponse.query },
										caller: { type: "direct" },
									},
									hostedResultBlock,
								]
							: scriptedResponse.type === "anthropic-orphan-web-search-result" && hostedResultBlock
								? [hostedResultBlock]
								: []
					const contentBlocks = [...hostedContentBlocks, ...ordinaryContentBlocks]
					const thinkingBlock = scriptedResponse.reasoning
						? {
								type: "thinking",
								thinking: scriptedResponse.reasoning,
								signature: `e2e_signature_${generationId}`,
							}
						: undefined
					if (parsed.stream === false) {
						return sendJson({
							id: generationId,
							type: "message",
							role: "assistant",
							model,
							content: thinkingBlock ? [thinkingBlock, ...contentBlocks] : contentBlocks,
							stop_reason: responseToolCalls.length > 0 ? "tool_use" : "end_turn",
							stop_sequence: null,
							usage: { ...messageUsage, output_tokens: usage.outputTokens },
						})
					}

					res.writeHead(200, {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					})
					writeSse(
						{
							type: "message_start",
							message: {
								id: generationId,
								type: "message",
								role: "assistant",
								model,
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: messageUsage,
							},
						},
						"message_start",
					)
					if (scriptedResponse.type === "usage-then-error") {
						const code = scriptedResponse.code ?? `http_${scriptedResponse.status}`
						writeSse(
							{
								type: "error",
								error: { type: code, message: scriptedResponse.message, ...scriptedResponse.details },
								...(scriptedResponse.requestId ? { request_id: scriptedResponse.requestId } : {}),
							},
							"error",
						)
						res.end()
						return
					}
					if (thinkingBlock) {
						writeSse(
							{
								type: "content_block_start",
								index: 0,
								content_block: { type: "thinking", thinking: "", signature: "" },
							},
							"content_block_start",
						)
						writeSse(
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "thinking_delta", thinking: thinkingBlock.thinking },
							},
							"content_block_delta",
						)
						writeSse(
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "signature_delta", signature: thinkingBlock.signature },
							},
							"content_block_delta",
						)
						writeSse({ type: "content_block_stop", index: 0 }, "content_block_stop")
						if (!(await waitAfterReasoning())) return
					}
					const contentBlockOffset = thinkingBlock ? 1 : 0
					for (const [index, block] of hostedContentBlocks.entries()) {
						const contentBlockIndex = contentBlockOffset + index
						const startBlock = block.type === "server_tool_use" ? { ...block, input: {} } : block
						writeSse(
							{ type: "content_block_start", index: contentBlockIndex, content_block: startBlock },
							"content_block_start",
						)
						if (block.type === "server_tool_use") {
							writeSse(
								{
									type: "content_block_delta",
									index: contentBlockIndex,
									delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
								},
								"content_block_delta",
							)
						}
						writeSse({ type: "content_block_stop", index: contentBlockIndex }, "content_block_stop")
					}
					const ordinaryContentBlockOffset = contentBlockOffset + hostedContentBlocks.length
					if (responseToolCalls.length > 0) {
						for (const [index, tool] of responseToolCalls.entries()) {
							const contentBlockIndex = ordinaryContentBlockOffset + index
							writeSse(
								{
									type: "content_block_start",
									index: contentBlockIndex,
									content_block: {
										id: tool.id ?? `toolu_${generationId}_${index}`,
										type: "tool_use",
										name: tool.name,
										input: {},
									},
								},
								"content_block_start",
							)
							const argumentChunks = splitStreamText(
								JSON.stringify(tool.arguments),
								scriptedResponse.toolArgumentChunkSize,
							)
							for (const argumentChunk of argumentChunks) {
								writeSse(
									{
										type: "content_block_delta",
										index: contentBlockIndex,
										delta: { type: "input_json_delta", partial_json: argumentChunk },
									},
									"content_block_delta",
								)
								if (!(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) return
							}
							writeSse({ type: "content_block_stop", index: contentBlockIndex }, "content_block_stop")
						}
					} else {
						const contentBlockIndex = ordinaryContentBlockOffset
						writeSse(
							{
								type: "content_block_start",
								index: contentBlockIndex,
								content_block: { type: "text", text: "" },
							},
							"content_block_start",
						)
						writeSse(
							{
								type: "content_block_delta",
								index: contentBlockIndex,
								delta: { type: "text_delta", text: messageText },
							},
							"content_block_delta",
						)
						writeSse({ type: "content_block_stop", index: contentBlockIndex }, "content_block_stop")
					}
					if (!(await waitForOpenConnection(scriptedResponse.beforeUsageDelayMs))) return
					writeSse(
						{
							type: "message_delta",
							delta: {
								stop_reason: responseToolCalls.length > 0 ? "tool_use" : "end_turn",
								stop_sequence: null,
							},
							usage: { output_tokens: usage.outputTokens },
						},
						"message_delta",
					)
					if (!(await waitForOpenConnection(scriptedResponse.afterUsageHoldMs))) return
					writeSse({ type: "message_stop" }, "message_stop")
					res.end()
					return
				}

				// Health check endpoints
				if (baseRoute === "/health") {
					if (endpoint === "/" && method === "GET") {
						return sendJson({
							status: "ok",
							timestamp: new Date().toISOString(),
						})
					}
				}

				// API v1 endpoints
				if (baseRoute === "/api/v1") {
					// User endpoints
					if (endpoint === "/users/me" && method === "GET") {
						const currentUser = controller.currentUser
						if (!currentUser) {
							return sendApiError("Unauthorized", 401)
						}
						return sendApiResponse(currentUser)
					}

					if (endpoint === "/users/me/remote-config" && method === "GET") {
						return sendApiResponse(null)
					}

					if (endpoint === "/users/me/featurebase-token" && method === "GET") {
						const currentUser = controller.currentUser
						if (!currentUser) {
							return sendApiError("Unauthorized", 401)
						}
						return sendApiResponse({
							featurebaseJwt: `mock-featurebase-jwt-${currentUser.id}`,
						})
					}

					if (endpoint === "/users/{userId}/balance" && method === "GET") {
						const { userId } = params
						const balance: BalanceResponse = {
							balance: controller.userBalance,
							userId,
						}
						return sendApiResponse(balance)
					}

					if (endpoint === "/users/{userId}/usages" && method === "GET") {
						const { userId } = params
						const currentUser = controller.currentUser
						if (currentUser?.id !== userId) {
							return sendApiError("Unauthorized", 401)
						}
						return sendApiResponse({
							items: controller.API_USER.getMockUsageTransactions(userId),
						})
					}

					if (endpoint === "/users/{userId}/payments" && method === "GET") {
						const { userId } = params
						const currentUser = controller.currentUser
						if (currentUser?.id !== userId) {
							return sendApiError("Unauthorized", 401)
						}
						return sendApiResponse({
							paymentTransactions: controller.API_USER.getMockPaymentTransactions(userId),
						})
					}

					// Organization endpoints
					if (endpoint === "/organizations/{orgId}/balance" && method === "GET") {
						const { orgId } = params
						const balance: OrganizationBalanceResponse = {
							balance: controller.orgBalance,
							organizationId: orgId,
						}
						return sendApiResponse(balance)
					}

					if (endpoint === "/organizations/{orgId}/members/{memberId}/usages" && method === "GET") {
						const currentUser = controller.currentUser
						if (!currentUser) {
							return sendApiError("Unauthorized", 401)
						}
						const body = await readBody()
						const { orgId } = params
						log("Fetching organization usage transactions for", {
							orgId,
							body,
						})
						return sendApiResponse({
							items: controller.API_USER.getMockUsageTransactions(currentUser.id, orgId),
						})
					}

					if (endpoint === "/users/active-account" && method === "PUT") {
						const body = await readBody()
						log("Switching active account")
						const { organizationId } = JSON.parse(body)
						controller.setUserHasOrganization(!!organizationId)
						const currentUser = controller.API_USER.getCurrentUser()
						if (!currentUser) {
							return sendApiError("No current user found", 400)
						}
						if (organizationId === null) {
							for (const org of currentUser.organizations) {
								org.active = false
							}
						} else {
							const orgIndex = currentUser.organizations.findIndex((org) => org.organizationId === organizationId)
							if (orgIndex === -1) {
								return sendApiError("Organization not found", 404)
							}
							currentUser.organizations[orgIndex].active = controller.userHasOrganization
						}
						controller.setCurrentUser(currentUser)
						return sendApiResponse("Account switched successfully")
					}

					// Auth token exchange endpoint
					if (endpoint === "/auth/token" && method === "POST") {
						const body = await readBody()
						const parsed = JSON.parse(body)
						const { code, grantType } = parsed

						if (grantType !== "authorization_code" || !code) {
							return sendApiError("Invalid request", 400)
						}

						const user = controller.API_USER.getUserByToken(code)
						if (!user) {
							return sendApiError("Invalid or expired authorization code", 400)
						}

						// Return format matching ClineAuthProvider expectations
						return sendApiResponse({
							accessToken: `${code}_access`,
							refreshToken: `${code}_refresh`,
							tokenType: "Bearer",
							expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour from now
							userInfo: {
								subject: user.id,
								email: user.email,
								name: user.displayName,
								clineUserId: user.id,
								accounts: null,
								organizations: user.organizations,
							},
						})
					}

					// Auth refresh token endpoint
					if (endpoint === "/auth/refresh" && method === "POST") {
						const body = await readBody()
						const parsed = JSON.parse(body)
						const { refreshToken, grantType } = parsed

						if (grantType !== "refresh_token" || !refreshToken) {
							return sendApiError("Invalid request", 400)
						}

						// Extract original token from refresh token
						const originalToken = refreshToken.replace("_refresh", "")
						const user = controller.API_USER.getUserByToken(originalToken)
						if (!user) {
							return sendApiError("Invalid or expired refresh token", 400)
						}

						// Return format matching ClineAuthProvider expectations
						return sendApiResponse({
							accessToken: `${originalToken}_access_refreshed`,
							refreshToken: refreshToken, // Keep same refresh token
							tokenType: "Bearer",
							expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour from now
							userInfo: {
								subject: user.id,
								email: user.email,
								name: user.displayName,
								clineUserId: user.id,
								accounts: null,
							},
						})
					}

					// Budget limit increase request endpoint
					if (endpoint === "/users/me/budget/request" && method === "POST") {
						log("Spend limit increase request received — recording and notifying admin")
						res.writeHead(204)
						res.end()
						return
					}

					// Chat completions endpoint
					if (endpoint === "/chat/completions" && method === "POST") {
						// Spend limit check takes priority — org-enforced budget cap (429)
						if (controller.spendLimitExceeded) {
							log("Returning SPEND_LIMIT_EXCEEDED (429)")
							return sendJson(
								{
									error: {
										code: "SPEND_LIMIT_EXCEEDED",
										limit_scope: "user",
										budget_period: "daily",
										limit_usd: 20.0,
										spent_usd: 20.5,
										resets_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
										message: "Your daily spend limit of $20.00 has been reached.",
									},
								},
								429,
							)
						}

						if (!controller.userHasOrganization && controller.userBalance <= 0) {
							return sendApiError(
								JSON.stringify({
									code: "insufficient_credits",
									current_balance: controller.userBalance,
									message: "Not enough credits available",
								}),
								402,
							)
						}

						const body = await readBody()
						const parsed = JSON.parse(body)
						const { _messages, model = "claude-3-5-sonnet-20241022", stream = true } = parsed
						let responseText = E2E_MOCK_API_RESPONSES.DEFAULT
						if (body.includes("[replace_in_file for 'test.ts'] Result:")) {
							responseText = E2E_MOCK_API_RESPONSES.REPLACE_REQUEST
						}
						if (body.includes("edit_request")) {
							responseText = E2E_MOCK_API_RESPONSES.EDIT_REQUEST
						}
						if (body.includes("[diff.test.ts] Hello, Cline!")) {
							// The playwright test in diff.test.ts needs the "API Request..." text
							// to be on the screen long enough to detect it.  This worked at 100ms
							// too, but setting to 500ms to cover slower CI boxes.
							await new Promise((resolve) => setTimeout(resolve, 500))
						}

						const generationId = `gen_${++controller.generationCounter}_${Date.now()}`

						if (stream) {
							res.writeHead(200, {
								"Content-Type": "text/plain",
								"Cache-Control": "no-cache",
								Connection: "keep-alive",
							})

							const randomUUID = uuidv4()

							responseText += `\n\nGenerated UUID: ${randomUUID}`

							const chunks = responseText.split(" ")
							let chunkIndex = 0

							const sendChunk = () => {
								if (chunkIndex < chunks.length) {
									const chunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {
													content: chunks[chunkIndex] + (chunkIndex < chunks.length - 1 ? " " : ""),
												},
												finish_reason: null,
											},
										],
									}
									res.write(`data: ${JSON.stringify(chunk)}\n\n`)
									chunkIndex++
									setTimeout(sendChunk, 10)
								} else {
									const finalChunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {},
												finish_reason: "stop",
											},
										],
										usage: {
											prompt_tokens: 140,
											completion_tokens: responseText.length,
											total_tokens: 140 + responseText.length,
											cost: (140 + responseText.length) * 0.00015,
										},
									}
									res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
									res.write("data: [DONE]\n\n")
									res.end()
								}
							}

							sendChunk()
							return
						}
						const response = {
							id: generationId,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model,
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: "Hello! I'm a mock Cline API response.",
									},
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 140,
								completion_tokens: responseText.length,
								total_tokens: 140 + responseText.length,
								cost: (140 + responseText.length) * 0.00015,
							},
						}
						return sendJson(response)
					}

					// Generation details endpoint
					if (endpoint === "/generation" && method === "GET") {
						const generationId = parsedUrl.searchParams.get("id") || ""
						const generation = controller.API_USER.getGeneration(generationId)

						if (!generation) {
							return sendJson({ error: "Generation not found" }, 404)
						}

						return sendJson(generation)
					}
				}

				// Test helper endpoints
				if (baseRoute === "/.test") {
					if (endpoint === "/auth" && method === "POST") {
						const user = controller.API_USER.getUserByToken()
						if (!user) {
							return sendApiError("Invalid token", 401)
						}
						controller.setCurrentUser(user)
						return
					}

					if (endpoint === "/setUserBalance" && method === "POST") {
						const body = await readBody()
						const { balance } = JSON.parse(body)
						controller.setUserBalance(balance)
						res.writeHead(200)
						res.end()
						return
					}

					if (endpoint === "/setUserHasOrganization" && method === "POST") {
						const body = await readBody()
						const { hasOrg } = JSON.parse(body)
						controller.setUserHasOrganization(hasOrg)
						res.writeHead(200)
						res.end()
						return
					}

					if (endpoint === "/setOrgBalance" && method === "POST") {
						const body = await readBody()
						const { balance } = JSON.parse(body)
						controller.setOrgBalance(balance)
						res.writeHead(200)
						res.end()
						return
					}

					if (endpoint === "/setSpendLimitExceeded" && method === "POST") {
						const body = await readBody()
						const { exceeded } = JSON.parse(body)
						controller.setSpendLimitExceeded(!!exceeded)
						res.writeHead(200)
						res.end()
						return
					}
				}

				// If we get here, the route was matched but not handled
				return sendJson({ error: "Endpoint not implemented" }, 500)
			}

			handleRequest().catch((err) => {
				console.error("Request handling error:", err)
				sendApiError("Internal server error", 500)
			})
		})

		// Track connections for proper cleanup
		server.on("connection", (socket) => {
			ClineApiServerMock.globalSockets.add(socket)
			socket.on("close", () => {
				ClineApiServerMock.globalSockets.delete(socket)
			})
		})

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error)
			server.once("error", onError)
			server.listen(0, E2E_API_SERVER_HOST, () => {
				server.off("error", onError)
				resolve()
			})
		})

		const address = server.address() as AddressInfo | null
		if (!address) {
			server.close()
			throw new Error("Mock API server started without a network address")
		}

		const baseUrl = `http://${E2E_API_SERVER_HOST}:${address.port}`
		const controller = new ClineApiServerMock(server, baseUrl)
		ClineApiServerMock.globalSharedServer = controller
		log(`ClineApiServerMock listening at ${baseUrl}`)

		return controller
	}

	// Stops the global shared server
	public static async stopGlobalServer(): Promise<void> {
		if (!ClineApiServerMock.globalSharedServer) {
			return
		}

		const server = ClineApiServerMock.globalSharedServer.server

		// Clean shutdown - destroy all socket connections first
		ClineApiServerMock.globalSockets.forEach((socket) => socket.destroy())
		ClineApiServerMock.globalSockets.clear()

		await new Promise<void>((resolve, reject) => {
			server.close((err) => {
				if (err) {
					console.error("Error closing server:", err)
					reject(err)
				}
				log("Server closed successfully")
				resolve()
			})
		})

		ClineApiServerMock.globalSharedServer = null
	}
}
