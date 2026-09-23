import { findEnabledProfileByName } from "@core/controller/file/getApiProfiles"
import { ApiConfiguration, ModelInfo } from "@shared/api"
import type { AccountUsageData, AccountUsageQuotaData } from "@shared/ExtensionMessage"
import type { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import type { ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import type { WebToolsMode } from "@shared/proto/dline/provider/common"
import { resolveProfileDisabledServerTools } from "@shared/providers/profile-model-info"
import { Mode } from "@shared/storage/types"
import { ClineError } from "@/services/error"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ClineTool } from "@/shared/tools"
import { getProfileModelInfo } from "./model-info"
import { instrumentApiHandler } from "./observability/instrument-api-handler"
import { AIhubmixHandler } from "./providers/aihubmix"
import { AnthropicHandler } from "./providers/anthropic"
import { AskSageHandler } from "./providers/asksage"
import { BasetenHandler } from "./providers/baseten"
import { AwsBedrockHandler } from "./providers/bedrock"
import { CerebrasHandler } from "./providers/cerebras"
import { ClaudeCodeHandler } from "./providers/claude-code"
import { ClineHandler } from "./providers/cline"
import { DeepSeekHandler } from "./providers/deepseek"
import { DifyHandler } from "./providers/dify"
import { DoubaoHandler } from "./providers/doubao"
import { FireworksHandler } from "./providers/fireworks"
import { GeminiHandler } from "./providers/gemini"
import { GroqHandler } from "./providers/groq"
import { HicapHandler } from "./providers/hicap"
import { HuaweiCloudMaaSHandler } from "./providers/huawei-cloud-maas"
import { HuggingFaceHandler } from "./providers/huggingface"
import { LiteLlmHandler } from "./providers/litellm"
import { LmStudioHandler } from "./providers/lmstudio"
import { MinimaxHandler } from "./providers/minimax"
import { MistralHandler } from "./providers/mistral"
import { MoonshotHandler } from "./providers/moonshot"
import { NebiusHandler } from "./providers/nebius"
import { NousResearchHandler } from "./providers/nousresearch"
import { OcaHandler } from "./providers/oca"
import { OllamaHandler } from "./providers/ollama"
import { OpenAiHandler } from "./providers/openai"
import { OpenAiCodexHandler } from "./providers/openai-codex"
import { OpenRouterHandler } from "./providers/openrouter"
import { QwenHandler } from "./providers/qwen"
import { QwenCodeHandler } from "./providers/qwen-code"
import { RequestyHandler } from "./providers/requesty"
import { SambanovaHandler } from "./providers/sambanova"
import { SapAiCoreHandler } from "./providers/sapaicore"
import { TogetherHandler } from "./providers/together"
import { VercelAIGatewayHandler } from "./providers/vercel-ai-gateway"
import { VertexHandler } from "./providers/vertex"
import { VsCodeLmHandler } from "./providers/vscode-lm"
import { WandbHandler } from "./providers/wandb"
import { XAIHandler } from "./providers/xai"
import { ZAiHandler } from "./providers/zai"
import { applyTaskRuntimeOverrides } from "./runtime-profile"
import { ApiStream, ApiStreamUsageChunk } from "./transform/stream"

/** @deprecated Use ApiHandlerContext instead */
export type CommonApiHandlerOptions = {
	onRetryAttempt?: ApiConfiguration["onRetryAttempt"]
}

/**
 * Context passed to every API handler. Contains the full ApiProfile
 * so handlers can read model capabilities from profile.modelInfo and
 * runtime reasoning config from profile.[provider].reasoning directly.
 */
export interface ApiHandlerContext {
	profile: ApiProfile
	mode: Mode
	workspaceId?: string
	ulid?: string
	onRetryAttempt?: (attempt: number, maxRetries: number, delay: number, error: unknown) => void
	requestTimeoutMs?: number
	enableParallelToolCalling?: boolean
	onStreamEstimatedTokens?: (tokens: number) => void
}

/**
 * Re-export shared types for account usage.
 * Single source of truth: @shared/ExtensionMessage.
 */
export type UsageQuota = AccountUsageQuotaData
export type AccountUsage = AccountUsageData

/** Provider-neutral result of consuming one account usage reset credit. */
export interface AccountUsageResetResult {
	readonly outcome: string
	readonly quotaTypesReset: readonly string[]
}

/** Request-scoped generation controls resolved above provider adapters. */
export interface ApiGenerationOptions {
	readonly purpose: "compaction"
	readonly maxOutputTokens: number
}

/** Owner responsible for retrying one logical Provider request. */
export type ApiRetryOwner = "task" | "subagent" | "compaction"

export interface ApiImageArtifactReference {
	readonly artifactId: string
	readonly mimeType: string
	readonly base64: string
}

export interface ApiImageGenerationOptions {
	readonly references: readonly ApiImageArtifactReference[]
	readonly size?: { readonly width: number; readonly height: number }
	readonly partialImages?: number
}

/** Immutable request-level capabilities resolved before entering a provider adapter. */
export interface ApiRequestOptions {
	/** Provider-hosted tools selected for this request. Local tools remain in `tools`. */
	readonly serverTools?: readonly ServerTool[]
	/** Stable Task identity used to isolate provider-side prompt cache routing. */
	readonly taskNamespace?: string
	/** Upper layer that owns retry orchestration; omitted requests use the Provider decorator. */
	readonly retryOwner?: ApiRetryOwner
	/** Optional generation policy for internal requests; ordinary requests omit this field. */
	readonly generation?: ApiGenerationOptions
	/** Ephemeral task-owned image inputs for provider-hosted generation/editing. */
	readonly imageGeneration?: ApiImageGenerationOptions
}

export interface ApiHandler {
	createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: ClineTool[],
		options?: ApiRequestOptions,
	): ApiStream
	getModel(): ApiHandlerModel
	/** Report protocol-adapter support without consulting provider or model identifiers. */
	supportsServerTool?(tool: ServerTool): boolean
	getApiStreamUsage?(): Promise<ApiStreamUsageChunk | undefined>
	/** Query account-level usage/balance from the provider. Returns undefined if not supported. */
	getAccountUsage?(): Promise<AccountUsage | undefined>
	/**
	 * Whether background polling may call `getAccountUsage()`.
	 *
	 * Defaults to true. A provider sets this to false when its usage endpoint is
	 * metered, rate limited, or otherwise too costly to query on a timer; the
	 * value then stays available through an explicit user refresh instead of
	 * being fetched once per interval per window.
	 */
	readonly supportsAccountUsagePolling?: boolean
	/** Consume one opaque reset-credit ID exposed by getAccountUsage(). */
	consumeAccountUsageResetCredit?(creditId: string): Promise<AccountUsageResetResult>
	abort?(): void
	/** Parse a provider-specific error into a ClineError. Falls back to generic ClineError.transform if not implemented. */
	parseError?(error: any, modelId?: string): ClineError
	/** Return the provider ID this handler was built for (from profile.provider). */
	getProviderId?(): string
	/** Return the web-tools routing mode captured by this handler's profile. */
	getWebToolsMode?(): WebToolsMode | undefined
	/**
	 * Return the wire protocol this handler will actually use.
	 *
	 * Routing has to judge hosted transport against the same format the request
	 * is sent with. A model's declared formats are only a fallback, and a profile
	 * running a free-form model id declares none at all.
	 */
	getSelectedApiFormat?(): ApiFormat | undefined
	/** Return the hosted server tools this handler's profile switched off. */
	getDisabledServerTools?(): readonly ServerTool[] | undefined
	/** Return the image source captured by this handler's profile when Image use is enabled. */
	getImageGenerationSource?(): ImageGenerationSource | undefined
}

export interface ApiHandlerModel {
	id: string
	info: ModelInfo
}

export interface ApiProviderInfo {
	providerId: string
	model: ApiHandlerModel
	mode: Mode
	customPrompt?: string // "compact"
}

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}

/**
 * Pure dispatch — each handler receives the full ApiHandlerContext and reads
 * what it needs directly from ctx.profile.[provider] and ctx.profile.modelInfo.
 */
function createHandlerForProvider(ctx: ApiHandlerContext): ApiHandler {
	const { profile } = ctx
	const providerId = profile.provider

	let handler: ApiHandler
	switch (profile.provider) {
		case "anthropic":
			handler = new AnthropicHandler(ctx)
			break
		case "openrouter":
			handler = new OpenRouterHandler(ctx)
			break
		case "bedrock":
			handler = new AwsBedrockHandler(ctx)
			break
		case "vertex":
			handler = new VertexHandler(ctx)
			break
		case "openai":
			handler = new OpenAiHandler(ctx)
			break
		case "ollama":
			handler = new OllamaHandler(ctx)
			break
		case "lmstudio":
			handler = new LmStudioHandler(ctx)
			break
		case "gemini":
			handler = new GeminiHandler(ctx)
			break
		case "openai-codex":
			handler = new OpenAiCodexHandler(ctx)
			break
		case "deepseek":
			handler = new DeepSeekHandler(ctx)
			break
		case "requesty":
			handler = new RequestyHandler(ctx)
			break
		case "fireworks":
			handler = new FireworksHandler(ctx)
			break
		case "together":
			handler = new TogetherHandler(ctx)
			break
		case "qwen":
			handler = new QwenHandler(ctx)
			break
		case "qwen-code":
			handler = new QwenCodeHandler(ctx)
			break
		case "doubao":
			handler = new DoubaoHandler(ctx)
			break
		case "mistral":
			handler = new MistralHandler(ctx)
			break
		case "vscode-lm":
			handler = new VsCodeLmHandler(ctx)
			break
		case "cline":
			handler = new ClineHandler(ctx)
			break
		case "litellm":
			handler = new LiteLlmHandler(ctx)
			break
		case "moonshot":
			handler = new MoonshotHandler(ctx)
			break
		case "nebius":
			handler = new NebiusHandler(ctx)
			break
		case "asksage":
			handler = new AskSageHandler(ctx)
			break
		case "xai":
			handler = new XAIHandler(ctx)
			break
		case "sambanova":
			handler = new SambanovaHandler(ctx)
			break
		case "cerebras":
			handler = new CerebrasHandler(ctx)
			break
		case "groq":
			handler = new GroqHandler(ctx)
			break
		case "sapaicore":
			handler = new SapAiCoreHandler(ctx)
			break
		case "baseten":
			handler = new BasetenHandler(ctx)
			break
		case "huggingface":
			handler = new HuggingFaceHandler(ctx)
			break
		case "huawei-cloud-maas":
			handler = new HuaweiCloudMaaSHandler(ctx)
			break
		case "claude-code":
			handler = new ClaudeCodeHandler(ctx)
			break
		case "dify":
			handler = new DifyHandler(ctx)
			break
		case "vercel-ai-gateway":
			handler = new VercelAIGatewayHandler(ctx)
			break
		case "zai":
			handler = new ZAiHandler(ctx)
			break
		case "oca":
			handler = new OcaHandler(ctx)
			break
		case "aihubmix":
			handler = new AIhubmixHandler(ctx)
			break
		case "minimax":
			handler = new MinimaxHandler(ctx)
			break
		case "hicap":
			handler = new HicapHandler(ctx)
			break
		case "nousResearch":
			handler = new NousResearchHandler(ctx)
			break
		case "wandb":
			handler = new WandbHandler(ctx)
			break
		default:
			throw new Error(`Unknown provider: ${profile.provider}`)
	}
	// Inject provider ID so callers can get it without going through global StateManager
	Object.assign(handler, {
		getProviderId: () => providerId,
		getWebToolsMode: () => profile.webToolsMode,
		getDisabledServerTools: () => resolveProfileDisabledServerTools(profile),
	})
	return instrumentApiHandler(handler, ctx)
}

export function resolveProviderFromProfile(profileName?: string): string | undefined {
	if (!profileName) return undefined
	const profile = findEnabledProfileByName(profileName)
	return profile?.provider
}

export function resolveProvider(config: ApiConfiguration, mode: Mode): string | undefined {
	const profileName = mode === "plan" ? config.planModeProfile : config.actModeProfile
	if (!profileName) return undefined
	const profile = findEnabledProfileByName(profileName)
	return profile?.provider
}

/**
 * Build an API handler for the given mode from the configured profile.
 * Looks up the profile by name from api_profiles.json and passes the full
 * ApiProfile into the handler via ApiHandlerContext.
 */
export function buildApiHandlerFromProfile(configuration: ApiConfiguration, mode: Mode, profile: ApiProfile): ApiHandler {
	const runtimeProfile = applyTaskRuntimeOverrides({ ...profile, modelInfo: getProfileModelInfo(profile) }, configuration, mode)
	return createHandlerForProvider({
		profile: runtimeProfile,
		mode,
		workspaceId: configuration.workspaceId,
		ulid: configuration.ulid,
		onRetryAttempt: configuration.onRetryAttempt,
		requestTimeoutMs: configuration.requestTimeoutMs,
		enableParallelToolCalling: configuration.enableParallelToolCalling,
		onStreamEstimatedTokens: configuration.onStreamEstimatedTokens,
	})
}

export function buildApiHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	const profileName = mode === "plan" ? configuration.planModeProfile : configuration.actModeProfile
	if (!profileName) {
		throw new Error(`No profile configured for ${mode} mode`)
	}
	const profile = findEnabledProfileByName(profileName)
	if (!profile) {
		throw new Error(`Profile "${profileName}" not found`)
	}
	return buildApiHandlerFromProfile(configuration, mode, profile)
}
