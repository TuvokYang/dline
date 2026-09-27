import { randomUUID } from "node:crypto"
import {
	type CompactionWireDiagnosticSnapshot,
	createCompactionWireDiagnosticSnapshot,
	findCompactionWireFirstDivergence,
	hashCompactionDiagnosticValue,
	isCompactionDevDiagnosticsEnabled,
} from "@core/context/context-management/compaction-dev-diagnostics"
import { ModelInfo, OpenAiCodexModelId, openAiCodexDefaultModelId, openAiCodexModels } from "@shared/api"
import { providerFetch } from "@shared/net"
import { observeProviderStream } from "@shared/provider-attempt-observer"
import { normalizeOpenAiServiceTier, normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import OpenAI from "openai"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import * as os from "os"
import { MessageEvent as UndiciMessageEvent, WebSocket as UndiciWebSocket } from "undici"
import { type OpenAiCodexCredentialContext, openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { resolveOpenAiCodexRuntimeConfig } from "@/integrations/openai-codex/runtime-config"
import { openAiCodexUsageClient, toAccountUsage } from "@/integrations/openai-codex/usage"
import { ExtensionRegistryInfo } from "@/registry"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { Logger } from "@/shared/services/Logger"
import { redactDiagnosticString } from "@/shared/services/logging/safe-diagnostic-value"
import { AccountUsage, type AccountUsageResetResult, ApiHandler, ApiHandlerContext, type ApiRequestOptions } from "../"
import { isOutputLimitExceededError, OutputLimitExceededError } from "../stream/OutputLimitExceededError"
import { projectOpenAIResponsesPromptCache } from "../transform/openai-prompt-cache"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { ApiStream } from "../transform/stream"
import { handleResponsesApiStreamResponse } from "../utils/responses_api_support"
import { openAiCodexModelInfoSaneDefaults } from "./models/openai-codex"
import { canonicalizeOpenAiCodexResponseEvents } from "./openai-codex-response-events"

const SAFE_CODEX_ERROR_CODES = new Set([
	"authentication_error",
	"invalid_request_error",
	"invalid_token",
	"previous_response_not_found",
	"provider_failure",
	"rate_limit_exceeded",
	"unauthorized",
	"websocket_closed",
	"websocket_concurrency_limit",
	"websocket_error",
	"websocket_parse_error",
])

/**
 * OpenAiCodexHandler - Uses OpenAI Responses API with OAuth authentication
 *
 * Key differences from OpenAiHandler:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Routes requests to Codex backend (chatgpt.com/backend-api/codex)
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset
 * - Custom headers for Codex backend
 */
export class OpenAiCodexHandler implements ApiHandler {
	private client?: OpenAI
	private responsesWs: UndiciWebSocket | undefined
	private responsesWsCredentialContext: OpenAiCodexCredentialContext | undefined
	private websocketRequestInFlight = false
	// Abort controller for cancelling ongoing requests
	private abortController?: AbortController
	private accountUsageController?: AbortController
	private accountUsageActionController?: AbortController
	private readonly profileId: string
	private runtimeMutationDispose?: () => void
	private latestOrdinaryCodexDiagnostic?: {
		primary: CompactionWireDiagnosticSnapshot
		fallback: CompactionWireDiagnosticSnapshot
	}
	private activeRuntimeOperations = 0
	private readonly runtimeConfig = resolveOpenAiCodexRuntimeConfig()

	constructor(private ctx: ApiHandlerContext) {
		if (!ctx.profile.id?.trim()) throw new Error("OpenAI Codex requires a non-empty Profile ID.")
		this.profileId = ctx.profile.id
	}

	private get config() {
		// Provider config fields are generated from proto as camelCase members.
		return this.ctx.profile.openaiCodex
	}
	private get modelId() {
		return this.ctx.profile.modelId || ""
	}
	private get modelInfo() {
		return this.ctx.profile.modelInfo as ModelInfo | undefined
	}
	private get reasoningConfig() {
		return this.config?.reasoning
	}
	private get reasoningEffort() {
		return this.reasoningConfig?.effort
	}
	private get serviceTier() {
		return this.config?.serviceTierEnabled === false ? undefined : normalizeOpenAiServiceTier(this.config?.serviceTier)
	}
	private get userAgent(): string {
		return `dline/${ExtensionRegistryInfo.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`
	}

	private recordCodexCompactionDiagnostic(input: {
		requestKind: "ordinary" | "compaction"
		modelId: string
		taskNamespace?: string
		useWebsocketMode: boolean
		primaryBody: Record<string, unknown>
		fallbackBody: Record<string, unknown>
	}): void {
		if (!isCompactionDevDiagnosticsEnabled()) return

		const createSnapshot = (body: Record<string, unknown>) =>
			createCompactionWireDiagnosticSnapshot({
				requestKind: input.requestKind,
				promptCacheKey: String(body.prompt_cache_key ?? ""),
				instructions: body.instructions,
				tools: Array.isArray(body.tools) ? body.tools : [],
				previousResponseId: typeof body.previous_response_id === "string" ? body.previous_response_id : undefined,
				wireInput: body.input,
			})
		const primary = createSnapshot(input.primaryBody)
		const fallback = createSnapshot(input.fallbackBody)
		const ordinaryBaseline = input.requestKind === "ordinary" ? undefined : this.latestOrdinaryCodexDiagnostic
		Logger.debug("[CompactionDiag] openai-codex-wire", {
			requestKind: input.requestKind,
			modelId: input.modelId,
			taskNamespaceHash: hashCompactionDiagnosticValue(input.taskNamespace ?? null),
			useWebsocketMode: input.useWebsocketMode,
			primaryPreviousResponseIdPresent: typeof input.primaryBody.previous_response_id === "string",
			fallbackPreviousResponseIdPresent: typeof input.fallbackBody.previous_response_id === "string",
			primaryPromptCacheKeyHash: primary.promptCacheKeyHash,
			fallbackPromptCacheKeyHash: fallback.promptCacheKeyHash,
			primaryInputCount: primary.inputHashes.length,
			fallbackInputCount: fallback.inputHashes.length,
			ordinaryBaselineAvailable: ordinaryBaseline !== undefined,
			primaryFirstDivergence: ordinaryBaseline
				? findCompactionWireFirstDivergence(ordinaryBaseline.primary, primary)
				: null,
			fallbackFirstDivergence: ordinaryBaseline
				? findCompactionWireFirstDivergence(ordinaryBaseline.fallback, fallback)
				: null,
			primaryToFallbackDivergence: findCompactionWireFirstDivergence(primary, fallback),
		})
		if (input.requestKind === "ordinary") this.latestOrdinaryCodexDiagnostic = { primary, fallback }
	}

	private buildCodexHeaders(credential: OpenAiCodexCredentialContext): Record<string, string> {
		const headers: Record<string, string> = {
			originator: "dline",
			"User-Agent": this.userAgent,
			...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
			...buildExternalBasicHeaders(),
		}
		if (this.ctx.workspaceId) {
			headers["session-id"] = this.ctx.workspaceId
		}
		if (this.ctx.ulid) {
			headers["thread-id"] = this.ctx.ulid
			headers["x-client-request-id"] = this.ctx.ulid
		}
		return headers
	}

	private beginRuntimeOperation(): () => void {
		this.activeRuntimeOperations++
		this.ensureRuntimeMutationSubscription()
		let released = false
		return () => {
			if (released) return
			released = true
			this.activeRuntimeOperations--
			this.releaseRuntimeMutationSubscriptionIfIdle()
		}
	}

	private ensureRuntimeMutationSubscription(): void {
		this.runtimeMutationDispose ??= openAiCodexOAuthManager.subscribeToRuntimeMutations((event) => {
			if (event.profileId === this.profileId) this.abort()
		})
	}

	private releaseRuntimeMutationSubscriptionIfIdle(): void {
		const websocketOpen =
			this.responsesWs?.readyState === UndiciWebSocket.OPEN || this.responsesWs?.readyState === UndiciWebSocket.CONNECTING
		if (this.activeRuntimeOperations > 0 || websocketOpen) return
		this.runtimeMutationDispose?.()
		this.runtimeMutationDispose = undefined
	}

	private isSameCredentialContext(
		left: OpenAiCodexCredentialContext | undefined,
		right: OpenAiCodexCredentialContext,
	): boolean {
		return left?.accessToken === right.accessToken && left.accountId === right.accountId
	}

	private safeErrorStatus(error: unknown): number | undefined {
		if (typeof error !== "object" || error === null || !("status" in error)) return undefined
		const status = (error as { status?: unknown }).status
		return typeof status === "number" && Number.isInteger(status) ? status : undefined
	}

	private safeErrorCode(error: unknown): string | undefined {
		if (typeof error !== "object" || error === null || !("code" in error)) return undefined
		const code = (error as { code?: unknown }).code
		return typeof code === "string" && SAFE_CODEX_ERROR_CODES.has(code) ? code : undefined
	}

	private redactProviderErrorText(value: string): string {
		return redactDiagnosticString(value).replace(
			/(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|account[_-]?payload|chatgpt[_-]?account[_-]?id)\b(?:["']?\s*[:=]\s*["']?))([^"'&,\s}\]]+)/gi,
			"$1[REDACTED]",
		)
	}

	private redactProviderErrorValue(value: unknown, depth = 0): unknown {
		if (typeof value === "string") return this.redactProviderErrorText(value)
		if (value === null || typeof value !== "object" || depth >= 6) return value
		if (Array.isArray(value)) return value.map((entry) => this.redactProviderErrorValue(entry, depth + 1))
		const redacted: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value)) {
			const normalizedKey = key.toLowerCase().replaceAll("-", "").replaceAll("_", "")
			redacted[key] = /^(?:accesstoken|refreshtoken|idtoken|apikey|clientsecret|password|authorization|cookie)$/.test(
				normalizedKey,
			)
				? "[REDACTED]"
				: this.redactProviderErrorValue(entry, depth + 1)
		}
		return redacted
	}

	private getProviderErrorMessage(error: unknown): string {
		let message: string
		if (error instanceof Error && error.message) message = error.message
		else if (typeof error === "string" && error) message = error
		else if (typeof error === "object" && error !== null && "message" in error) {
			const candidate = (error as { message?: unknown }).message
			message = typeof candidate === "string" && candidate ? candidate : JSON.stringify(error)
		} else {
			try {
				message = JSON.stringify(error) || String(error)
			} catch {
				message = String(error)
			}
		}
		return this.redactProviderErrorText(message)
	}

	private toProviderError(error: unknown): Error & { status?: number; code?: string; responseBody?: string } {
		const providerError = new Error(this.getProviderErrorMessage(error)) as Error & {
			status?: number
			code?: string
			responseBody?: string
		}
		const redacted = this.redactProviderErrorValue(error)
		if (typeof redacted === "object" && redacted !== null) Object.assign(providerError, redacted)
		providerError.message = this.getProviderErrorMessage(error)
		return providerError
	}

	private isAuthenticationFailure(error: unknown): boolean {
		if (typeof error === "object" && error !== null) {
			const status = "status" in error ? (error as { status?: unknown }).status : undefined
			if (status === 401) return true
			const code = "code" in error ? (error as { code?: unknown }).code : undefined
			if (typeof code === "string" && /^(?:401|unauthorized|invalid_token|authentication_error)$/i.test(code)) return true
		}
		const message = error instanceof Error ? error.message : String(error)
		return /unauthorized|invalid token|not authenticated|authentication|401/i.test(message)
	}

	supportsServerTool(tool: ServerTool): boolean {
		if (tool !== ServerTool.WEB_SEARCH) {
			return false
		}
		const apiFormat = this.getModel().info.apiFormats?.[0]
		return apiFormat === ApiFormat.OPENAI_RESPONSES || apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
	}

	/**
	 * The usage endpoint is served by the same subscription as conversations,
	 * so it is read once per Profile and then only on an explicit refresh.
	 */
	readonly supportsAccountUsagePolling = false

	/** Fetch current ChatGPT Codex quota windows for this OAuth account. */
	async getAccountUsage(): Promise<AccountUsage | undefined> {
		const releaseRuntime = this.beginRuntimeOperation()
		this.accountUsageController?.abort()
		const controller = new AbortController()
		this.accountUsageController = controller
		try {
			return toAccountUsage(await openAiCodexUsageClient.getUsage(this.profileId, { signal: controller.signal }))
		} finally {
			if (this.accountUsageController === controller) {
				this.accountUsageController = undefined
			}
			releaseRuntime()
		}
	}

	async consumeAccountUsageResetCredit(creditId: string): Promise<AccountUsageResetResult> {
		const releaseRuntime = this.beginRuntimeOperation()
		this.accountUsageActionController?.abort()
		const controller = new AbortController()
		this.accountUsageActionController = controller
		try {
			const result = await openAiCodexUsageClient.consumeRateLimitResetCredit(this.profileId, creditId, randomUUID(), {
				signal: controller.signal,
			})
			if (!result) throw new Error("OpenAI Codex authentication is unavailable.")
			return { outcome: result.outcome, quotaTypesReset: result.windowsReset }
		} finally {
			if (this.accountUsageActionController === controller) {
				this.accountUsageActionController = undefined
			}
			releaseRuntime()
		}
	}

	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: ChatCompletionTool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const releaseRuntime = this.beginRuntimeOperation()
		try {
			const model = this.getModel()

			// Resolve token and account identity from one Profile-owned snapshot.
			let credential = await openAiCodexOAuthManager.getCredentialContext(this.profileId)
			if (!credential) {
				throw new Error(
					"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow in settings.",
				)
			}
			const useWebsocketMode = this.shouldUseWebsocketMode(this.getSelectedApiFormat())
			const { input, previousResponseId } = convertToOpenAIResponsesInput(messages, {
				usePreviousResponseId: useWebsocketMode,
			})
			const usePreviousResponseId = useWebsocketMode && !!previousResponseId

			// Build request body
			const requestBody = this.buildRequestBody(model, input, systemPrompt, tools, previousResponseId, options)
			const fallbackRequestBody = this.buildRequestBody(model, input, systemPrompt, tools, undefined, options)
			this.recordCodexCompactionDiagnostic({
				requestKind: options?.generation?.purpose === "compaction" ? "compaction" : "ordinary",
				modelId: model.id,
				taskNamespace: options?.taskNamespace,
				useWebsocketMode,
				primaryBody: requestBody,
				fallbackBody: fallbackRequestBody,
			})

			// Make the request with retry on auth failure
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					yield* this.executeRequest(requestBody, fallbackRequestBody, model, credential, usePreviousResponseId)
					return
				} catch (error) {
					if (this.isAuthenticationFailure(error)) {
						if (attempt === 0) {
							const refreshed = await openAiCodexOAuthManager.forceRefreshCredentialContext(this.profileId)
							if (refreshed) {
								credential = refreshed
								continue
							}
						}
						throw Object.assign(new Error("Not authenticated with OpenAI Codex. Sign in to this Profile again."), {
							status: 401,
						})
					}
					if (isOutputLimitExceededError(error)) throw error
					throw this.toProviderError(error)
				}
			}
		} finally {
			releaseRuntime()
		}
	}

	private shouldUseWebsocketMode(apiFormat?: ApiFormat): boolean {
		return apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
	}

	private buildRequestBody(
		model: { id: string; info: ModelInfo },
		formattedInput: any,
		systemPrompt: string,
		tools?: ChatCompletionTool[],
		previousResponseId?: string,
		options?: ApiRequestOptions,
	): any {
		// Determine reasoning effort. Explicit enableThinking=false disables Responses reasoning entirely.
		const enableThinking = this.reasoningConfig?.enableThinking ?? true
		const reasoningEffort = normalizeOpenaiReasoningEffort(this.reasoningEffort)
		const includeReasoning = enableThinking && reasoningEffort !== "none"
		const hostedWebSearch = options?.serverTools?.includes(ServerTool.WEB_SEARCH) === true
		const responseTools: OpenAI.Responses.Tool[] = (tools ?? [])
			.filter((tool) => tool.type === "function")
			.filter((tool) => !hostedWebSearch || tool.function.name !== "web_search")
			.map((tool) => ({
				type: "function" as const,
				name: tool.function.name,
				description: tool.function.description,
				parameters: tool.function.parameters ?? null,
				strict: tool.function.strict ?? true,
			}))
		if (hostedWebSearch) responseTools.push({ type: "web_search" })
		const promptCache = projectOpenAIResponsesPromptCache({
			modelId: model.id,
			systemPrompt,
			input: formattedInput as OpenAI.Responses.ResponseInput,
			tools: responseTools,
			taskNamespace: options?.taskNamespace,
		})
		const include = [
			...(includeReasoning ? ["reasoning.encrypted_content"] : []),
			...(hostedWebSearch ? ["web_search_call.results", "web_search_call.action.sources"] : []),
		]

		return {
			model: model.id,
			...(promptCache.instructions === undefined ? {} : { instructions: promptCache.instructions }),
			input: promptCache.input,
			prompt_cache_key: promptCache.promptCacheKey,
			stream: true,
			store: false,
			...(responseTools.length > 0 ? { tools: responseTools } : {}),
			...(this.serviceTier ? { service_tier: this.serviceTier } : {}),
			...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
			// The ChatGPT Codex Responses endpoint rejects `max_output_tokens`.
			// Compaction still uses its output cap for local fitting and budgeting,
			// but the transport must omit this unsupported request parameter.
			...(include.length > 0 ? { include } : {}),
			...(includeReasoning
				? {
						reasoning: {
							effort: reasoningEffort,
							summary: "auto",
						},
					}
				: {}),
		}
	}

	private async *executeRequest(
		requestBody: any,
		fallbackRequestBody: any,
		model: { id: string; info: ModelInfo },
		credential: OpenAiCodexCredentialContext,
		useWebsocketMode: boolean,
	): ApiStream {
		// Create AbortController for cancellation
		this.abortController = new AbortController()

		try {
			// Build Codex-specific headers from the same credential and task identity snapshot.
			const codexHeaders = this.buildCodexHeaders(credential)

			if (useWebsocketMode) {
				try {
					yield* this.createResponseStreamWebsocket(requestBody, fallbackRequestBody, credential, codexHeaders, model)
					return
				} catch (error) {
					if (isOutputLimitExceededError(error) || this.isAuthenticationFailure(error)) {
						throw error
					}
					const diagnostic = this.toProviderError(error)
					Logger.error(
						`OpenAI Codex websocket mode failed; falling back to HTTP Responses API (status=${diagnostic.status ?? "unknown"}, code=${diagnostic.code ?? "unknown"}).`,
					)
					this.closeResponsesWebsocket()
				}
			}

			// Try using OpenAI SDK first
			try {
				const client =
					this.client ??
					new OpenAI({
						apiKey: credential.accessToken,
						baseURL: this.runtimeConfig.apiBaseUrl,
						defaultHeaders: codexHeaders,
						fetch: providerFetch,
					})

				const stream = (await (client as any).responses.create(requestBody, {
					signal: this.abortController.signal,
					headers: codexHeaders,
				})) as AsyncIterable<any>

				if (typeof (stream as any)?.[Symbol.asyncIterator] !== "function") {
					throw new Error("OpenAI SDK did not return an AsyncIterable")
				}

				yield* this.handleResponseEvents(stream, model)
			} catch (error) {
				if (isOutputLimitExceededError(error) || this.isAuthenticationFailure(error)) {
					throw error
				}
				// Fallback to manual SSE via fetch
				yield* this.makeCodexRequest(requestBody, model, credential)
			}
		} finally {
			this.abortController = undefined
		}
	}

	private async *createResponseStreamWebsocket(
		primaryParams: OpenAI.Responses.ResponseCreateParamsStreaming,
		fallbackParams: OpenAI.Responses.ResponseCreateParamsStreaming,
		credential: OpenAiCodexCredentialContext,
		codexHeaders: Record<string, string>,
		model: { id: string; info: ModelInfo },
	): ApiStream {
		try {
			yield* this.handleResponseEvents(
				this.createResponseEventsViaWebsocket(primaryParams, credential, codexHeaders),
				model,
			)
		} catch (error) {
			if (this.shouldRetryWebsocketWithFullContext(error, !!primaryParams.previous_response_id)) {
				Logger.log(
					"Retrying Codex websocket response with full context after previous_response_not_found or socket reset",
				)
				this.closeResponsesWebsocket()
				yield* this.handleResponseEvents(
					this.createResponseEventsViaWebsocket(fallbackParams, credential, codexHeaders),
					model,
				)
				return
			}
			throw error
		}
	}

	private async *handleResponseEvents(events: AsyncIterable<unknown>, model: { id: string; info: ModelInfo }): ApiStream {
		yield* handleResponsesApiStreamResponse(canonicalizeOpenAiCodexResponseEvents(events), model.info, async () => 0)
	}

	private shouldRetryWebsocketWithFullContext(error: unknown, hadPreviousResponseId: boolean): boolean {
		const errorCode =
			typeof error === "object" && error && "code" in error && typeof (error as { code: unknown }).code === "string"
				? (error as { code: string }).code
				: undefined

		if (hadPreviousResponseId && errorCode === "previous_response_not_found") {
			return true
		}
		if (errorCode === "websocket_closed" || errorCode === "websocket_error") {
			return true
		}
		return false
	}

	private async ensureResponsesWebsocket(
		credential: OpenAiCodexCredentialContext,
		codexHeaders: Record<string, string>,
	): Promise<UndiciWebSocket> {
		if (
			this.responsesWs &&
			this.responsesWs.readyState === UndiciWebSocket.OPEN &&
			this.isSameCredentialContext(this.responsesWsCredentialContext, credential)
		) {
			return this.responsesWs
		}

		this.closeResponsesWebsocket()

		const ws = new UndiciWebSocket(this.runtimeConfig.responsesWebsocketUrl, {
			headers: {
				Authorization: `Bearer ${credential.accessToken}`,
				"OpenAI-Beta": "responses_websockets=2026-02-06",
				...codexHeaders,
			},
		})

		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				ws.removeEventListener("open", handleOpen)
				ws.removeEventListener("error", handleError)
				ws.removeEventListener("close", handleClose)
			}
			const handleOpen = () => {
				cleanup()
				resolve()
			}
			const handleError = () => {
				cleanup()
				reject(new Error("Failed to open Codex Responses websocket"))
			}
			const handleClose = () => {
				cleanup()
				reject(new Error("Codex Responses websocket closed before opening"))
			}
			ws.addEventListener("open", handleOpen)
			ws.addEventListener("error", handleError)
			ws.addEventListener("close", handleClose)
		})

		this.responsesWs = ws
		this.responsesWsCredentialContext = { ...credential }
		this.ensureRuntimeMutationSubscription()
		return ws
	}

	private closeResponsesWebsocket() {
		if (this.responsesWs) {
			try {
				this.responsesWs.close()
			} catch {}
			this.responsesWs = undefined
			this.responsesWsCredentialContext = undefined
		}
		this.releaseRuntimeMutationSubscriptionIfIdle()
	}

	private async *createResponseEventsViaWebsocket(
		params: OpenAI.Responses.ResponseCreateParamsStreaming,
		credential: OpenAiCodexCredentialContext,
		codexHeaders: Record<string, string>,
	): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
		if (this.websocketRequestInFlight) {
			const error: Error & { code?: string } = new Error("Websocket response.create is already in progress")
			error.code = "websocket_concurrency_limit"
			throw error
		}

		const ws = await this.ensureResponsesWebsocket(credential, codexHeaders)
		this.websocketRequestInFlight = true

		const eventQueue: OpenAI.Responses.ResponseStreamEvent[] = []
		let resolver: (() => void) | undefined
		let completed = false
		let failure: (Error & { code?: string }) | undefined

		const wake = () => {
			const next = resolver
			resolver = undefined
			next?.()
		}

		const handleMessage = (evt: UndiciMessageEvent) => {
			try {
				let raw = ""
				if (typeof evt.data === "string") {
					raw = evt.data
				} else if (evt.data instanceof ArrayBuffer) {
					raw = new TextDecoder().decode(new Uint8Array(evt.data))
				} else if (ArrayBuffer.isView(evt.data)) {
					raw = new TextDecoder().decode(new Uint8Array(evt.data.buffer, evt.data.byteOffset, evt.data.byteLength))
				} else {
					raw = String(evt.data)
				}

				const parsed = JSON.parse(raw)
				if (parsed?.type === "error" && parsed?.error) {
					const error = this.toProviderError(parsed.error)
					error.responseBody = this.redactProviderErrorText(raw)
					failure = error
					completed = true
					wake()
					return
				}

				if (parsed?.type === "response.failed") {
					const responseError = parsed.response?.error
					const failedError = this.toProviderError(responseError ?? parsed.response ?? parsed)
					failedError.responseBody = this.redactProviderErrorText(raw)
					failure = failedError
					completed = true
					wake()
					return
				}
				if (parsed?.type === "response.incomplete") {
					failure =
						parsed.response?.incomplete_details?.reason === "max_output_tokens"
							? new OutputLimitExceededError("openai_responses", "max_output_tokens")
							: new Error("Codex Responses websocket request was incomplete")
					completed = true
					wake()
					return
				}

				eventQueue.push(parsed as OpenAI.Responses.ResponseStreamEvent)
				if (parsed?.type === "response.completed") completed = true
				wake()
			} catch (error) {
				const parseError: Error & { code?: string } = new Error(
					`Failed to parse websocket event: ${error instanceof Error ? error.message : String(error)}`,
				)
				parseError.code = "websocket_parse_error"
				failure = parseError
				completed = true
				wake()
			}
		}

		const handleError = () => {
			const error: Error & { code?: string } = new Error("Codex Responses websocket emitted an error event")
			error.code = "websocket_error"
			failure = error
			completed = true
			wake()
		}

		const handleClose = () => {
			if (!completed) {
				const error: Error & { code?: string } = new Error("Codex Responses websocket closed during response stream")
				error.code = "websocket_closed"
				failure = error
				completed = true
				wake()
			}
		}

		ws.addEventListener("message", handleMessage)
		ws.addEventListener("error", handleError)
		ws.addEventListener("close", handleClose)

		try {
			const responseEvents = await observeProviderStream(
				() =>
					(async function* () {
						const websocketParams = { ...params } as Record<string, unknown>
						delete websocketParams.stream
						ws.send(
							JSON.stringify({
								type: "response.create",
								...websocketParams,
							}),
						)

						while (!completed || eventQueue.length > 0) {
							if (eventQueue.length === 0) {
								await new Promise<void>((resolve) => {
									resolver = resolve
								})
								continue
							}

							const event = eventQueue.shift()
							if (event) yield event
						}

						if (failure) throw failure
					})(),
				this.abortController?.signal ? { signal: this.abortController.signal } : {},
			)
			yield* responseEvents
		} finally {
			ws.removeEventListener("message", handleMessage)
			ws.removeEventListener("error", handleError)
			ws.removeEventListener("close", handleClose)
			this.websocketRequestInFlight = false
		}
	}

	private async *makeCodexRequest(
		requestBody: any,
		model: { id: string; info: ModelInfo },
		credential: OpenAiCodexCredentialContext,
	): ApiStream {
		const url = `${this.runtimeConfig.apiBaseUrl}/responses`

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${credential.accessToken}`,
			...this.buildCodexHeaders(credential),
		}

		try {
			const response = await providerFetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: this.abortController?.signal,
			})

			if (!response.ok) {
				const responseBody = await response.text()
				let payload: unknown
				try {
					payload = responseBody ? JSON.parse(responseBody) : undefined
				} catch {
					payload = undefined
				}
				const errorPayload =
					typeof payload === "object" && payload !== null && "error" in payload
						? (payload as { error?: unknown }).error
						: payload
				const providerError = this.toProviderError(
					errorPayload ?? responseBody ?? `Codex API request rejected with status ${response.status}`,
				)
				providerError.status = response.status
				providerError.responseBody = this.redactProviderErrorText(responseBody)
				throw providerError
			}

			if (!response.body) {
				throw new Error("No response body from Codex API")
			}

			yield* this.handleStreamResponse(response.body, model)
		} catch (error) {
			if (isOutputLimitExceededError(error)) {
				throw error
			}
			throw this.toProviderError(error)
		}
	}

	private async *handleStreamResponse(body: ReadableStream<Uint8Array>, model: { id: string; info: ModelInfo }): ApiStream {
		yield* this.handleResponseEvents(this.readStreamEvents(body), model)
	}

	private async *readStreamEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let reachedEof = false
		let terminalReason: unknown

		try {
			while (true) {
				if (this.abortController?.signal.aborted) {
					terminalReason = new DOMException("Codex request aborted", "AbortError")
					return
				}

				const { done, value } = await reader.read()
				if (done) {
					reachedEof = true
					break
				}

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim()
						if (data === "[DONE]") {
							continue
						}

						try {
							yield JSON.parse(data)
						} catch (e) {
							if (!(e instanceof SyntaxError)) {
								throw e
							}
						}
					}
				}
			}
		} catch (error) {
			terminalReason = error
			throw error
		} finally {
			try {
				if (!reachedEof) await reader.cancel(terminalReason)
			} finally {
				reader.releaseLock()
			}
		}
	}

	abort(): void {
		this.closeResponsesWebsocket()
		this.abortController?.abort()
		this.accountUsageController?.abort()
		this.accountUsageActionController?.abort()
		this.runtimeMutationDispose?.()
		this.runtimeMutationDispose = undefined
	}

	getSelectedApiFormat(): ApiFormat {
		return this.getModel().info.apiFormats?.[0] ?? ApiFormat.OPENAI_RESPONSES
	}

	getModel(): { id: OpenAiCodexModelId; info: ModelInfo } {
		const id = (this.modelId || openAiCodexDefaultModelId) as OpenAiCodexModelId
		const bundled = openAiCodexModels[id] ?? { ...openAiCodexModelInfoSaneDefaults, id }
		const override = this.modelInfo
		const info: ModelInfo = override
			? {
					...bundled,
					...override,
					id,
					capabilities:
						bundled.capabilities || override.capabilities
							? { ...bundled.capabilities, ...override.capabilities }
							: undefined,
					pricing: bundled.pricing || override.pricing ? { ...bundled.pricing, ...override.pricing } : undefined,
				}
			: bundled

		return { id, info }
	}
}
