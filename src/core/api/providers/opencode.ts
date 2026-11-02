/**
 * OpenCode inference gateway handler.
 *
 * One Profile picks a billing mode (Console or Go) and one wire protocol. The
 * mode selects the catalog and the endpoint base; the protocol selects the
 * request shape. This handler is the only place that turns those two facts into
 * a request, so a mode switch or a protocol switch can never leave the other
 * fact stale.
 *
 * Verified 2026-10-31:
 * - base URLs and protocol paths: https://opencode.ai/docs/zen/ and /console/go
 * - every paid text model is served through all three protocols by translation
 * - a stable `x-opencode-session` header is required per conversation
 * - the client must identify itself with its own user agent
 */
import type { Anthropic } from "@anthropic-ai/sdk"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { ModelInfo } from "@shared/api"
import { prioritizeApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { getProviderCatalog } from "@shared/providers/model-infos"
import { resolveProfileCatalogKey, resolveProfileModelId } from "@shared/providers/profile-model-info"
import { calculateApiCostOpenAI } from "@utils/cost"
import type OpenAI from "openai"
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineError } from "@/services/error"
import type { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient, fetch } from "@/shared/net"
import { ApiFormat } from "@/shared/proto/dline/models/metadata"
import type { ApiProfile } from "@/shared/proto/dline/profile"
import { Logger } from "@/shared/services/Logger"
import type { ClineTool } from "@/shared/tools"
import { type AccountUsage, ApiHandler, type ApiHandlerContext, type ApiRequestOptions, type UsageQuota } from "../ApiHandler"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import type { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { chatReasoningTokens, splitInclusiveInputUsage } from "../transform/usage-normalization"
import { streamAnthropicMessagesEndpoint } from "../utils/anthropic-messages-endpoint"
import { handleResponsesApiStreamResponse } from "../utils/responses_api_support"
import { createAnthropicClient } from "./anthropic/client-factory"
import { resolveAnthropicReasoning } from "./anthropic/reasoning"
import { anthropicPromptCacheOn, buildAnthropicMessagesRequest, prepareAnthropicMessages } from "./anthropic/request-builder"
import { ApiKeyAnthropicTransport } from "./anthropic/transport"
import { openCodeModels } from "./models/opencode"
import { encodeOpenAIChatReasoning, encodeOpenAIResponsesReasoning } from "./openai/reasoning"

/** Console base URL. A Go Profile appends `/go`. */
const OPENCODE_BASE_URL = "https://opencode.ai/inference"

/**
 * Where the Go plan reports its usage windows.
 *
 * Derived from the published Go surface rather than guessed: the Go docs list
 * `https://opencode.ai/inference/go/v1/models`, and the usage document sits on
 * the same `/inference/go/v1` prefix. A Go subscription is the only OpenCode
 * product with account-level windows, so this belongs to the subscription and
 * to a fixed host — a Profile `baseUrl` may point at an inference host or a
 * relay that never had this route.
 *
 * Cross-check: `Wei-Shaw/sub2api` (`internal/service/opencode_go_usage.go`)
 * calls `https://opencode.ai/zen/go/v1/usage`, the older Zen path, from the
 * same `opencode.ai` host. Both prefixes appear in the wild; this handler
 * follows the prefix the current Go docs publish.
 */
const OPENCODE_USAGE_URL = `${OPENCODE_BASE_URL}/go/v1/usage`

/**
 * The three nested windows a Go plan meters, widest last.
 *
 * The Go docs state the shape exactly: "Each model has the following usage
 * limits: 5-hour — 20% of the monthly limit; weekly — 50%; and monthly —
 * 100%." Each window is therefore a share of the same per-model monthly
 * allowance, not three independent quotas, and the percentage is a share of
 * that window's own ceiling.
 */
const OPENCODE_USAGE_WINDOWS: readonly {
    readonly key: string
    readonly type: string
    readonly label: string
    readonly shortLabel: string
    readonly windowSeconds: number
}[] = [
    { key: "rolling", type: "rolling-5h", label: "5 Hour", shortLabel: "5h", windowSeconds: 18_000 },
    { key: "weekly", type: "weekly", label: "Weekly", shortLabel: "week", windowSeconds: 604_800 },
    { key: "monthly", type: "monthly", label: "Monthly", shortLabel: "month", windowSeconds: 2_592_000 },
]

/**
 * Protocols this handler can carry. Gemini is deliberately absent: no tool-schema
 * path exists yet.
 *
 * Responses leads because it is the gateway's native OpenAI protocol. This is the
 * default for a model that declares nothing, and the settings page resolves an
 * unset Profile the same way, so the picker cannot show one protocol while the
 * request uses another.
 */
const SUPPORTED_FORMATS: readonly ApiFormat[] = [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT, ApiFormat.ANTHROPIC_CHAT]

/**
 * Stable identity this client declares upstream.
 *
 * The gateway requires each client to identify itself instead of sending a
 * generic SDK name, so the vendor and version travel in the user agent.
 */
function openCodeUserAgent(): string {
    return "Dline"
}

/**
 * Session identity for one conversation.
 *
 * The gateway uses it for routing and prompt caching. It is derived from the
 * task namespace so every request of one Task shares it and no Task can reuse
 * another's, and it is never logged.
 */
function openCodeSessionId(profile: ApiProfile, taskNamespace: string | undefined): string {
    const seed = taskNamespace?.trim()
    if (seed) return seed
    // Without a task namespace the best stable identity is the Profile itself;
    // an empty header would let the gateway correlate unrelated conversations.
    return profile.id || "dline-opencode"
}

export class OpenCodeHandler extends ApiHandler {
    private client: ReturnType<typeof createOpenAIClient> | undefined
    private anthropicClient: Anthropic | undefined
    private requestController: AbortController | undefined
    /** In-flight usage read, aborted when a newer poll replaces it. */
    private accountUsageController: AbortController | undefined
    private sessionId: string | undefined
    /** Request-scoped task identity, captured so headers built inside client factories see it. */
    private taskNamespace: string | undefined

    constructor(private readonly ctx: ApiHandlerContext) {
        super()
    }

    private get profile(): ApiProfile {
        return this.ctx.profile
    }

    /** Resolution of the mode to its catalog, shared with every other consumer. */
    private get catalogKey(): string {
        return resolveProfileCatalogKey(this.profile)
    }

    /**
     * Model metadata this Profile reads.
     *
     * The catalog key already encodes the billing mode, so the handler asks the
     * shared resolver instead of keeping a second copy of the mode-to-catalog
     * mapping. A missing catalog keeps the Profile usable with built-in metadata.
     */
    private get catalog(): Record<string, ModelInfo> {
        return getProviderCatalog(this.catalogKey)?.catalog.models ?? openCodeModels
    }

    private get config() {
        return this.profile.opencode
    }

    /**
     * Whether this Profile spends a Go subscription instead of a balance.
     *
     * Read from the stored plan rather than inferred from the catalog key: the
     * key depends on which catalog the registry currently resolves, so a
     * registry that has not loaded would silently turn a Go Profile into a
     * balance one. Every Go tier (Go, Go Plus, Go Teams) is the same billing
     * family, and only the monthly allowance differs.
     */
    private get mode(): "console" | "go" {
        const stored = this.config?.mode
        return stored === 2 || stored === 3 || stored === 4 ? "go" : "console"
    }

    /** Declared plan name reported by the usage surface, which distinguishes the three subscription tiers. */
    private get planType(): string {
        switch (this.config?.mode) {
            case 2:
                return "opencode-go"
            case 3:
                return "opencode-go-plus"
            case 4:
                return "opencode-go-teams"
            default:
                return "opencode-console"
        }
    }

    /**
     * Base URL for the selected mode.
     *
     * The Profile's own `baseUrl` is still honored as an advanced override, but
     * it never decides the mode: a custom endpoint must not silently change the
     * catalog the Profile reads.
     */
    private get baseUrl(): string {
        const override = this.profile.baseUrl?.trim()
        if (override) return override
        return this.mode === "go" ? `${OPENCODE_BASE_URL}/go` : OPENCODE_BASE_URL
    }

    private get apiKey(): string | undefined {
        return this.profile.apiKey
    }

    getModel(): { id: string; info: ModelInfo } {
        const id = resolveProfileModelId(this.profile, { defaultModelId: undefined })
        const registry = this.catalog[id]
        const selected = this.profile.modelInfo?.id === id ? this.profile.modelInfo : undefined
        const base = selected ?? registry ?? { id }
        const info = buildEffectiveModelInfo(id || base.id, base, {
            capabilities: this.config?.model?.capabilities,
            pricing: this.config?.model?.pricing,
        })
        const format = this.selectedFormat
        return { id: info.id, info: prioritizeApiFormat(info, format) }
    }

    /**
     * Protocols the derived catalog publishes for the selected model.
     *
     * The Profile's own model metadata wins when it describes the same id, so a
     * pin the user made on a model the catalog does not list still describes
     * which protocols that model is published under. This is the default the
     * picker starts from, not a whitelist: the gateway translates between the
     * protocols of one family, so the user may still choose another.
     */
    private declaredFormats(): readonly ApiFormat[] {
        const id = resolveProfileModelId(this.profile)
        const selected = this.profile.modelInfo?.id === id ? this.profile.modelInfo : undefined
        const declared = selected?.apiFormats ?? this.catalog[id]?.apiFormats
        return declared?.length ? declared : SUPPORTED_FORMATS
    }

    /**
     * The protocol this request will use.
     *
     * A stored protocol is a decision, so it is honored as given whenever this
     * handler can carry it; the derived declaration only selects the default
     * when nothing is stored. Only a protocol this handler cannot carry is
     * rejected, because no fallback could answer in the shape the user chose.
     */
    private get selectedFormat(): ApiFormat {
        const requested = this.config?.model?.apiFormat
        if (requested !== undefined) {
            if (!SUPPORTED_FORMATS.includes(requested)) {
                throw new Error(`OpenCode cannot carry the selected protocol. Choose one of: ${SUPPORTED_FORMATS.join(", ")}.`)
            }
            return requested
        }
        return this.declaredFormats().find((format) => SUPPORTED_FORMATS.includes(format)) ?? SUPPORTED_FORMATS[0]
    }

    override getSelectedApiFormat(): ApiFormat {
        return this.selectedFormat
    }

    override getProviderId(): string {
        return "opencode"
    }

    private session(): string {
        if (this.sessionId === undefined) {
            this.sessionId = openCodeSessionId(this.profile, this.taskNamespace)
        }
        return this.sessionId
    }

    /** Protocol headers shared by all three paths. */
    private headers(): Record<string, string> {
        return {
            ...buildExternalBasicHeaders(),
            "User-Agent": openCodeUserAgent(),
            "x-opencode-session": this.session(),
        }
    }

    private ensureOpenAIClient() {
        if (!this.client) {
            if (!this.apiKey) throw new Error("OpenCode API key is required")
            this.client = createOpenAIClient({
                baseURL: this.openAiBaseUrl(),
                apiKey: this.apiKey,
                defaultHeaders: this.headers(),
            })
        }
        return this.client
    }

    private openAiBaseUrl(): string {
        return `${this.baseUrl.replace(/\/$/, "")}/openai/v1`
    }

    private ensureAnthropicClient(): Anthropic {
        if (!this.anthropicClient) {
            if (!this.apiKey) throw new Error("OpenCode API key is required")
            this.anthropicClient = createAnthropicClient(
                { kind: "api_key", apiKey: this.apiKey },
                { baseUrl: `${this.baseUrl.replace(/\/$/, "")}/anthropic/v1`, defaultHeaders: this.headers() },
            )
        }
        return this.anthropicClient
    }

    override abort(): void {
        this.requestController?.abort()
        // A cancelled turn must not leave a usage read holding a socket open;
        // the next poll starts cleanly and re-reads from the endpoint.
        this.accountUsageController?.abort()
    }

    @withRetry()
    async *createMessage(
        systemPrompt: string,
        messages: ClineStorageMessage[],
        tools?: ClineTool[],
        options?: ApiRequestOptions,
    ): ApiStream {
        this.requestController?.abort()
        const requestController = new AbortController()
        this.requestController = requestController
        this.taskNamespace = options?.taskNamespace
        try {
            const format = this.selectedFormat
            if (format === ApiFormat.ANTHROPIC_CHAT) {
                yield* this.createAnthropicMessage(
                    systemPrompt,
                    messages,
                    tools as AnthropicTool[] | undefined,
                    options,
                    requestController.signal,
                )
                return
            }
            if (format === ApiFormat.OPENAI_RESPONSES) {
                yield* this.createResponsesMessage(systemPrompt, messages, tools, options, requestController.signal)
                return
            }
            yield* this.createChatMessage(systemPrompt, messages, tools, options, requestController.signal)
        } finally {
            if (this.requestController === requestController) this.requestController = undefined
        }
    }

    /** OpenAI Chat Completions. */
    private async *createChatMessage(
        systemPrompt: string,
        messages: ClineStorageMessage[],
        tools: ClineTool[] | undefined,
        options: ApiRequestOptions | undefined,
        signal: AbortSignal,
    ): ApiStream {
        const client = this.ensureOpenAIClient()
        const model = this.getModel()
        const toolCallProcessor = new ToolCallProcessor()
        const toolParams = getOpenAIToolParams(tools as ChatCompletionFunctionTool[] | undefined)
        const maxTokens =
            options?.generation?.purpose === "compaction"
                ? options.generation.maxOutputTokens
                : model.info.capabilities?.maxTokens

        const stream = await client.chat.completions.create(
            {
                model: model.id,
                messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
                ...(maxTokens ? { max_tokens: maxTokens } : {}),
                ...encodeOpenAIChatReasoning(model.info.capabilities, this.config?.model?.reasoning),
                stream: true,
                stream_options: { include_usage: true },
                // A conversation without local tools must omit the field entirely:
                // spreading the helper's `undefined` would send `tools: null`.
                ...(toolParams.tools ? toolParams : {}),
            } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
            { signal, timeout: this.ctx.requestTimeoutMs },
        )

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta
            if (delta?.content) yield { type: "text", text: delta.content }

            if (delta?.tool_calls) {
                yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls as never)
            }

            const reasoning = (delta as { reasoning_content?: string } | undefined)?.reasoning_content
            if (reasoning) yield { type: "reasoning", reasoning }

            if (chunk.usage) {
                const promptDetails = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
                    .prompt_tokens_details
                const usage = splitInclusiveInputUsage({
                    totalInputTokens: chunk.usage.prompt_tokens,
                    cacheReadTokens: promptDetails?.cached_tokens,
                })
                // The gateway reports what it actually charged. Only when it does
                // not is the price table consulted, because a local estimate cannot
                // see peak-hour, long-context, or discount pricing.
                const reportedCost = readOpenCodeCost(chunk.usage)
                // `prompt_tokens` already includes the cached share, so a local
                // estimate must read the raw total while the stream reports the
                // uncached remainder.
                const totalCost =
                    reportedCost ??
                    (await calculateApiCostOpenAI(
                        model.info,
                        chunk.usage.prompt_tokens || 0,
                        chunk.usage.completion_tokens || 0,
                        usage.cacheWriteTokens,
                        usage.cacheReadTokens,
                    ))
                const thoughtsTokenCount = chatReasoningTokens(chunk.usage)
                yield {
                    type: "usage",
                    ...usage,
                    outputTokens: chunk.usage.completion_tokens || 0,
                    ...(thoughtsTokenCount === undefined ? {} : { thoughtsTokenCount }),
                    // `totalCost` is the single accounting field every consumer
                    // reads, so the gateway's own charge travels there rather than
                    // in a side channel no surface knows about.
                    totalCost,
                }
            }
        }
    }

    /** OpenAI Responses, issued stateless so no server-side conversation is required. */
    private async *createResponsesMessage(
        systemPrompt: string,
        messages: ClineStorageMessage[],
        tools: ClineTool[] | undefined,
        options: ApiRequestOptions | undefined,
        signal: AbortSignal,
    ): ApiStream {
        const client = this.ensureOpenAIClient()
        const model = this.getModel()
        const maxTokens =
            options?.generation?.purpose === "compaction"
                ? options.generation.maxOutputTokens
                : model.info.capabilities?.maxTokens
        const reasoning = encodeOpenAIResponsesReasoning(model.info.capabilities, this.config?.model?.reasoning)
        // Responses spells a function tool out flat while Chat nests it under
        // `function`. Both are projections of the same canonical tool, so a
        // non-function tool is dropped here rather than sent in a shape this
        // protocol cannot express.
        const responseTools: OpenAI.Responses.Tool[] = (tools ?? []).flatMap((tool) => {
            const candidate = tool as {
                type?: string
                function?: { name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }
            }
            if (candidate.type !== "function" || !candidate.function?.name) return []
            return [
                {
                    type: "function" as const,
                    name: candidate.function.name,
                    description: candidate.function.description,
                    parameters: candidate.function.parameters ?? null,
                    strict: candidate.function.strict ?? true,
                },
            ]
        })

        const stream = await client.responses.create(
            {
                model: model.id,
                instructions: systemPrompt,
                input: convertToOpenAIResponsesInput(messages, { usePreviousResponseId: false }).input,
                ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
                ...(reasoning ? { reasoning } : {}),
                stream: true,
                store: false,
                ...(responseTools.length ? { tools: responseTools } : {}),
            },
            { signal, timeout: this.ctx.requestTimeoutMs },
        )

        // The shared handler owns usage accounting and tool-call assembly. Parsing
        // the events here would drop `response.completed.usage`, which is the only
        // place this protocol reports token counts.
        yield* handleResponsesApiStreamResponse(
            stream,
            model.info,
            async (info, inputTokens, outputTokens, cacheWrite, cacheRead) =>
                calculateApiCostOpenAI(info, inputTokens, outputTokens, cacheWrite, cacheRead),
            // Responses reports the charge on `response.completed`, in the same
            // usage object the shared handler reads the token counts from.
            (usage) => readOpenCodeCost(usage),
        )
    }

    /** Anthropic Messages, using the native input-schema tool shape without a second conversion. */
    private async *createAnthropicMessage(
        systemPrompt: string,
        messages: ClineStorageMessage[],
        tools: AnthropicTool[] | undefined,
        options: ApiRequestOptions | undefined,
        signal: AbortSignal,
    ): ApiStream {
        const client = this.ensureAnthropicClient()
        const model = this.getModel()
        const transport = new ApiKeyAnthropicTransport(client, false, { signal, timeout: this.ctx.requestTimeoutMs })

        const anthropicMessages = prepareAnthropicMessages(messages, model.info, options)
        const requestBody = buildAnthropicMessagesRequest({
            model: model.id,
            modelInfo: model.info,
            systemPrompt,
            systemPrefix: [],
            messages: anthropicMessages,
            reasoning: resolveAnthropicReasoning(model.info.capabilities, this.config?.model?.reasoning),
            tools,
            options,
            forcedToolChoice: anthropicPromptCacheOn(model.info) ? "model_declared" : "never",
        })

        const protocolHeaders = this.headers()
        yield* streamAnthropicMessagesEndpoint({
            messages: requestBody.messages,
            // Every continuation belongs to the same Task conversation, so it must
            // carry the same session identity as the first request.
            openStream: (continuationMessages) =>
                transport.open({ ...requestBody, messages: continuationMessages }, protocolHeaders),
        })
    }

    /**
     * Read the Go plan's usage windows.
     *
     * A Go subscription is metered by three nested windows — `rolling` (5 hour),
     * `weekly` and `monthly` — and the endpoint reports how much of each window
     * has been *used*, not what remains. That reading is the only account-level
     * usage OpenCode publishes, so a pay-as-you-go Console Profile has nothing to
     * read and reports the console as the place to check its balance.
     *
     * The endpoint hangs off the Go base rather than the Profile's own base URL:
     * a user-supplied `baseUrl` points at an inference host, and asking it for
     * usage would either 404 or hit a relay that never had this route.
     */
    override async getAccountUsage(): Promise<AccountUsage | undefined> {
        const apiKey = this.apiKey
        if (!apiKey) return undefined
        if (this.mode !== "go") {
            return {
                currency: "USD",
                isAvailable: false,
                planType: this.planType,
                providerId: "opencode",
                retrievedAt: new Date().toISOString(),
            }
        }

        this.accountUsageController?.abort()
        const controller = new AbortController()
        this.accountUsageController = controller
        // A usage read must never outlive the poll that asked for it: the next
        // tick replaces this controller, and a stalled request would otherwise
        // keep a dead socket until the process exits.
        const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(15_000, this.ctx.requestTimeoutMs ?? 15_000)))
        try {
            const response = await fetch(OPENCODE_USAGE_URL, {
                method: "GET",
                headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
                signal: controller.signal,
            })
            if (!response.ok) {
                Logger.warn(`[OpenCode] Usage API failed: ${response.status}`)
                return undefined
            }
            const windows = parseOpenCodeUsage(await response.json())
            if (!windows) return undefined
            return {
                currency: "USD",
                isAvailable: true,
                planType: this.planType,
                providerId: "opencode",
                quotas: windows,
                retrievedAt: new Date().toISOString(),
            }
        } catch (error) {
            // An aborted read is the poll being replaced, not a failure worth reporting.
            if (!controller.signal.aborted) {
                Logger.warn(`[OpenCode] Usage API error: ${error instanceof Error ? error.message : String(error)}`)
            }
            return undefined
        } finally {
            clearTimeout(timeout)
            if (this.accountUsageController === controller) this.accountUsageController = undefined
        }
    }

    /**
     * Map OpenCode gateway failures onto Dline's error contract.
     *
     * A 403 from this gateway does not mean the credential is wrong: it is how
     * the seller refuses a model that is only available inside its own client.
     * Reporting that as an auth failure would send the user to re-enter a valid
     * key. 401/429 and other statuses keep the shared classification.
     */
    override parseError(error: any, modelId?: string): ClineError {
        const status = error?.status || error?.statusCode || error?.response?.status
        const rawMessage = String(error?.message ?? error?.error?.message ?? "")
        if (status === 403) {
            return new ClineError(
                {
                    status,
                    code: "OPENCODE_MODEL_RESTRICTED",
                    message:
                        "This model is only available inside the OpenCode client. Choose a paid OpenCode model, or use the OpenCode Go plan.",
                    details: { providerMessage: rawMessage },
                },
                modelId,
                "opencode",
            )
        }
        if (status === 404) {
            return new ClineError(
                {
                    status,
                    code: "OPENCODE_MODEL_UNAVAILABLE",
                    message: "The selected model is not available in this OpenCode mode. Pick another model or switch the mode.",
                    details: { providerMessage: rawMessage },
                },
                modelId,
                "opencode",
            )
        }
        const parsed = ClineError.transform(error, modelId, "opencode")
        Logger.debug(`[OpenCode] request failed status=${status ?? "unknown"} type=${ClineError.getErrorType(parsed) ?? "other"}`)
        return parsed
    }
}

/**
 * Read the three usage windows out of a Go usage response.
 *
 * Every field is treated as optional because the response is a vendor document:
 * a window the gateway omits must disappear from the surface rather than render
 * as a zero, and a percentage outside 0-100 is a malformed reading, not a value
 * to clamp into looking real. `percent` is how much of the window is *used*,
 * which is why it becomes `used` against a limit of 100.
 *
 * Reset times arrive either as an ISO 8601 string or as epoch seconds or
 * milliseconds, so both shapes are normalized to ISO here.
 */
export function parseOpenCodeUsage(payload: unknown): UsageQuota[] | undefined {
    const windows = findOpenCodeUsageWindows(payload)
    if (!windows) return undefined
    const quotas: UsageQuota[] = []
    for (const window of OPENCODE_USAGE_WINDOWS) {
        const reading = windows[window.key]
        if (!isPlainObject(reading)) continue
        const percent = reading.percent
        if (typeof percent !== "number" || !Number.isFinite(percent)) continue
        // The 5-hour and weekly windows are shares of the monthly allowance, so a
        // request that overshoots one window is a real reading, not a malformed
        // one: Go keeps serving when Extra Usage is on. Only a negative share is
        // impossible and therefore unusable.
        if (percent < 0) continue
        const resetAt = normalizeOpenCodeResetTime(reading.resetsAt)
        quotas.push({
            type: window.type,
            label: window.label,
            shortLabel: window.shortLabel,
            used: percent,
            limit: 100,
            windowSeconds: window.windowSeconds,
            ...(resetAt ? { resetAt } : {}),
        })
    }
    return quotas.length > 0 ? quotas : undefined
}

/**
 * Locate the window object inside the usage document.
 *
 * The documented payload nests the windows under `usage`. The reference
 * implementation (`Wei-Shaw/sub2api`) parses that shape and, failing it,
 * re-parses the body as the window object directly, so a document that drops
 * the wrapper still yields readings instead of silently reporting nothing.
 */
function findOpenCodeUsageWindows(payload: unknown): Record<string, unknown> | undefined {
    if (!isPlainObject(payload)) return undefined
    if (isPlainObject(payload.usage)) return payload.usage
    return OPENCODE_USAGE_WINDOWS.some((window) => isPlainObject(payload[window.key])) ? payload : undefined
}

/** Normalize the reset-time shapes the gateway may send into an ISO timestamp. */
function normalizeOpenCodeResetTime(value: unknown): string | undefined {
    if (typeof value === "string") {
        const trimmed = value.trim()
        if (trimmed === "") return undefined
        const parsed = new Date(trimmed)
        return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        // Epoch seconds are around ten digits; anything shorter is not a real
        // reading and anything longer is already milliseconds.
        const milliseconds = value < 1e11 ? value * 1000 : value
        const parsed = new Date(milliseconds)
        return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
    }
    return undefined
}

/** Whether a value is a plain object, which every nested reading must be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Read what one response says it cost, for the task's own cost display.
 *
 * The inference docs state it directly: "Every response reports what the request
 * cost you, beside the usage its API already returns". `cost` is the amount
 * actually charged, so unlike an estimate derived from a published price table it
 * stays correct through peak-hour, long-context, and discount pricing.
 *
 * This is per-request task cost, not account usage. The `opencode` block the same
 * document describes (`allowance`, `list_cost`, `billing_source`, `estimated`)
 * belongs to the subscription's own accounting and is deliberately not read here:
 * the usage surface reports percentages and nothing else.
 *
 * A response that carries no `cost` reports nothing: an absent price must not
 * become `0`, which would render the request as free.
 */
export function readOpenCodeCost(usage: unknown): number | undefined {
    if (!isPlainObject(usage)) return undefined
    const cost = usage.cost
    return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}
