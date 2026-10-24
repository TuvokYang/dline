import type { ModelInfo } from "@shared/api"
import type { AccountUsageData, AccountUsageQuotaData } from "@shared/ExtensionMessage"
import type { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import type { ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import type { WebToolsMode } from "@shared/proto/dline/provider/common"
import type { Mode } from "@shared/storage/types"
import type { ClineError } from "@/services/error"
import type { DocumentInputLimits } from "@/shared/messages/attached-documents"
import type { ClineStorageMessage, HostedToolReplayProtocol } from "@/shared/messages/content"
import {
    bindProviderAttemptScope,
    observeProviderCall,
    observeProviderStream,
    observeProviderStreamResponse,
    type ProviderAttemptAdapterIdentity,
    type ProviderAttemptIdentity,
    type ProviderAttemptObservationOptions,
    type ProviderAttemptObserver,
    type ProviderTelemetryRole,
    providerAttemptIdentityFromEncodedRequest,
    withProviderAttemptIdentity,
} from "@/shared/provider-attempt-observer"
import type { ClineTool } from "@/shared/tools"
import type { ApiStream, ApiStreamUsageChunk } from "./transform/stream"

export type {
    ProviderAttemptAdapterIdentity,
    ProviderAttemptIdentity,
    ProviderAttemptObservationOptions,
    ProviderAttemptObserver,
    ProviderAttemptTerminalStatus,
    ProviderTelemetryRole,
} from "@/shared/provider-attempt-observer"

/** Runtime and Profile context shared by every Provider adapter. */
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

/** Re-export shared account usage contracts from their canonical message definitions. */
export type UsageQuota = AccountUsageQuotaData
export type AccountUsage = AccountUsageData

/** Provider-neutral result of consuming one account usage reset credit. */
export interface AccountUsageResetResult {
    readonly outcome: string
    readonly quotaTypesReset: readonly string[]
}

/** Request-scoped generation controls resolved above Provider adapters. */
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

/** Immutable request-level capabilities resolved before entering a Provider adapter. */
export interface ApiRequestOptions {
    /** Provider-hosted tools selected for this request. Local tools remain in `tools`. */
    readonly serverTools?: readonly ServerTool[]
    /** Stable Task identity used to isolate Provider-side prompt cache routing. */
    readonly taskNamespace?: string
    /** Upper layer that owns retry orchestration; omitted requests use the Provider decorator. */
    readonly retryOwner?: ApiRetryOwner
    /** Optional generation policy for internal requests; ordinary requests omit this field. */
    readonly generation?: ApiGenerationOptions
    /** Ephemeral task-owned image inputs for Provider-hosted generation/editing. */
    readonly imageGeneration?: ApiImageGenerationOptions
    /** Semantic execution role consumed by the mandatory ApiHandler telemetry boundary. */
    readonly telemetryRole?: ProviderTelemetryRole
    /** Stable logical request identity shared by retries of the same execution. */
    readonly telemetryRequestId?: string
    /** Zero-based caller retry index; real sends are still counted independently by the Provider boundary. */
    readonly telemetryAttempt?: number
}

export interface ApiHandlerModel {
    id: string
    info: ModelInfo
}

export interface ApiProviderInfo {
    providerId: string
    model: ApiHandlerModel
    mode: Mode
    customPrompt?: string
}

export interface SingleCompletionHandler {
    completePrompt(prompt: string): Promise<string>
}

/**
 * Common Provider contract and the single implementation owner of real-send observation.
 * Provider adapters extend this class and implement only Provider-specific behavior.
 */
export abstract class ApiHandler {
    /** Identify the effective Provider/model/thinking tuple from the final encoded request. */
    static identifyProviderAttempt(provider: string, encodedRequest: unknown): ProviderAttemptIdentity | undefined {
        return providerAttemptIdentityFromEncodedRequest(provider, encodedRequest)
    }

    /** Observe one real non-streaming SDK send. */
    static observeProviderCall<T>(
        identity: ProviderAttemptIdentity | undefined,
        send: () => T | PromiseLike<T>,
        options?: ProviderAttemptObservationOptions,
    ): Promise<T> {
        const observe = () => observeProviderCall(send, options)
        return identity ? withProviderAttemptIdentity(identity, observe) : observe()
    }

    /** Observe one real SDK send whose result is an AsyncIterable. */
    static observeProviderStream<T>(
        identity: ProviderAttemptIdentity | undefined,
        send: () => AsyncIterable<T> | PromiseLike<AsyncIterable<T>>,
        options?: ProviderAttemptObservationOptions,
    ): Promise<AsyncIterable<T>> {
        const observe = () => observeProviderStream(send, options)
        return identity ? withProviderAttemptIdentity(identity, observe) : observe()
    }

    /** Observe one real SDK send whose response exposes the stream separately. */
    static observeProviderStreamResponse<TResponse, TChunk>(
        identity: ProviderAttemptIdentity | undefined,
        send: () => TResponse | PromiseLike<TResponse>,
        selectStream: (response: TResponse) => AsyncIterable<TChunk> | undefined,
        options?: ProviderAttemptObservationOptions,
    ): Promise<{ response: TResponse; stream: AsyncIterable<TChunk> | undefined }> {
        const observe = () => observeProviderStreamResponse(send, selectStream, options)
        return identity ? withProviderAttemptIdentity(identity, observe) : observe()
    }

    /** Bind the Task-owned attempt observer around lazy ApiStream iteration. */
    static bindProviderAttemptScope<T>(
        iterable: AsyncIterable<T>,
        observer: ProviderAttemptObserver,
        adapter?: ProviderAttemptAdapterIdentity,
    ): AsyncIterable<T> {
        return bindProviderAttemptScope(iterable, observer, adapter)
    }

    abstract createMessage(
        systemPrompt: string,
        messages: ClineStorageMessage[],
        tools?: ClineTool[],
        options?: ApiRequestOptions,
    ): ApiStream

    abstract getModel(): ApiHandlerModel

    countInputTokens?(input: {
        readonly systemPrompt: string
        readonly messages: ClineStorageMessage[]
        /** Provider adapters receive their own encoded tool shape at this boundary. */
        readonly tools?: any[]
        readonly options?: ApiRequestOptions
    }): Promise<number | undefined>
    supportsServerTool?(tool: ServerTool): boolean
    getHostedToolReplayProtocol?(): HostedToolReplayProtocol | undefined
    getDocumentInputLimits?(): DocumentInputLimits | undefined
    getApiStreamUsage?(): Promise<ApiStreamUsageChunk | undefined>
    getAccountUsage?(): Promise<AccountUsage | undefined>
    declare readonly supportsAccountUsagePolling?: boolean
    consumeAccountUsageResetCredit?(creditId: string): Promise<AccountUsageResetResult>
    abort?(): void
    parseError?(error: any, modelId?: string): ClineError
    getProviderId?(): string
    isCustomModel?(): boolean
    getWebToolsMode?(): WebToolsMode | undefined
    getSelectedApiFormat?(): ApiFormat | undefined
    getDisabledServerTools?(): readonly ServerTool[] | undefined
    getImageGenerationSource?(): ImageGenerationSource | undefined
}
