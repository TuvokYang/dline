/**
 * Shared implementation for vendors that expose an OpenAI-style
 * `GET /v1/models` listing returning `{ data: [...] }`.
 *
 * Subclasses override only what their vendor does differently. Everything they
 * do not override is handled here, so adding a vendor is normally a matter of
 * declaring an endpoint and a couple of field readers.
 */
import type { ModelCapabilities, ModelInfo, ModelPricing } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
import { fetch } from "@/shared/net"
import type { ProviderModelReconciliationMode } from "../provider-model-reconciliation"
import type { ProviderRemoteContext, ProviderRemoteSource } from "./model-source"

/** Guards against a malformed cursor turning pagination into an endless loop. */
const MAX_LISTING_PAGES = 20

const REQUEST_TIMEOUT_MS = 15_000

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read a dotted path and return it only when it is a usable positive number. */
export function readPositiveNumber(source: unknown, ...paths: string[]): number | undefined {
    for (const path of paths) {
        let current: unknown = source
        for (const segment of path.split(".")) {
            if (!isRecord(current)) {
                current = undefined
                break
            }
            current = current[segment]
        }
        if (typeof current === "number" && Number.isFinite(current) && current > 0) {
            return current
        }
    }
    return undefined
}

export function readString(source: unknown, ...paths: string[]): string | undefined {
    for (const path of paths) {
        let current: unknown = source
        for (const segment of path.split(".")) {
            if (!isRecord(current)) {
                current = undefined
                break
            }
            current = current[segment]
        }
        if (typeof current === "string" && current.length > 0) {
            return current
        }
    }
    return undefined
}

/**
 * Read a per-token price and convert it to the per-million-token unit the
 * catalog stores. Vendors publish these either as numbers or as strings.
 */
export function readPerMillionPrice(source: unknown, path: string): number | undefined {
    const asNumber = readPositiveNumber(source, path)
    if (asNumber !== undefined) {
        return asNumber * 1_000_000
    }
    const asText = readString(source, path)
    if (asText === undefined) {
        return undefined
    }
    const parsed = Number.parseFloat(asText)
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1_000_000 : undefined
}

/** Model ids that never belong in a chat model picker. */
const NON_CHAT_MARKERS = ["whisper", "tts", "embedding", "moderation"]

export abstract class ModelListingSource implements ProviderRemoteSource {
    abstract readonly providerId: string
    abstract readonly providerName: string

    readonly requiresApiKey: boolean = true
    readonly reconciliation: ProviderModelReconciliationMode = "replace"
    readonly billingMode: string = "token"
    readonly preferredDefaultModelId?: string

    /** Endpoint used when the profile does not carry its own base URL. */
    protected abstract readonly defaultBaseUrl: string

    async fetchModels(context: ProviderRemoteContext): Promise<Record<string, ModelInfo>> {
        if (this.requiresApiKey && !context.apiKey) {
            return {}
        }

        const entries = await this.fetchAllPages(context)
        const models: Record<string, ModelInfo> = {}
        for (const entry of entries) {
            if (!this.isChatModel(entry)) {
                continue
            }
            const modelId = this.readModelId(entry)
            if (!modelId) {
                continue
            }
            models[modelId] = this.toModelInfo(entry, modelId)
        }
        return models
    }

    /** Single-page `{ data: [...] }`. Cursor-based vendors override this. */
    protected async fetchAllPages(context: ProviderRemoteContext): Promise<unknown[]> {
        const payload = await this.requestJson(this.buildListingUrl(context), context)
        return this.readPageEntries(payload)
    }

    protected readPageEntries(payload: unknown): unknown[] {
        if (!isRecord(payload)) {
            return []
        }
        const data = payload.data
        return Array.isArray(data) ? data : []
    }

    protected async requestJson(url: string, context: ProviderRemoteContext): Promise<unknown> {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout

        const response = await fetch(url, { headers: await this.buildHeaders(context), signal })
        if (!response.ok) {
            throw new Error(`${this.providerName} model listing failed with status ${response.status}`)
        }
        return response.json()
    }

    protected buildListingUrl(context: ProviderRemoteContext): string {
        return joinListingPath(context.baseUrl || this.defaultBaseUrl)
    }

    /** Async so vendors whose credentials require a round trip can build headers. */
    protected buildHeaders(context: ProviderRemoteContext): Record<string, string> | Promise<Record<string, string>> {
        return context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}
    }

    protected readModelId(raw: unknown): string | undefined {
        return readString(raw, "id")
    }

    protected isChatModel(raw: unknown): boolean {
        if (!isRecord(raw)) {
            return false
        }
        if (Object.hasOwn(raw, "active") && raw.active === false) {
            return false
        }
        const modelId = this.readModelId(raw)?.toLowerCase()
        if (!modelId) {
            return false
        }
        return !NON_CHAT_MARKERS.some((marker) => modelId.includes(marker))
    }

    protected readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "context_window", "context_length", "max_input_tokens")
    }

    protected readMaxTokens(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "max_completion_tokens", "max_output_tokens", "max_tokens")
    }

    protected readDescription(raw: unknown): string | undefined {
        return readString(raw, "description", "display_name")
    }

    /** Human-readable label; vendors that publish one override this. */
    protected readModelName(_raw: unknown, modelId: string): string {
        return modelId
    }

    /** Undefined means "this vendor does not publish prices", which keeps stored pricing intact. */
    protected readPricing(_raw: unknown): ModelPricing | undefined {
        return undefined
    }

    protected readCapabilities(raw: unknown): ModelCapabilities {
        return {
            contextWindow: this.readContextWindow(raw),
            maxTokens: this.readMaxTokens(raw),
            supportsTools: readSupportedFeature(raw, "tools"),
            supportsReasoning: readSupportedFeature(raw, "reasoning", "reasoning_effort"),
        }
    }

    protected toModelInfo(raw: unknown, modelId: string): ModelInfo {
        const pricing = this.readPricing(raw)
        return {
            id: modelId,
            name: this.readModelName(raw, modelId),
            description: this.readDescription(raw),
            capabilities: this.readCapabilities(raw),
            ...(pricing ? { pricing } : {}),
        }
    }

    protected logFailure(error: unknown): void {
        Logger.error(`[${this.providerId}] Failed to list models:`, error)
    }
}

/** Append the listing path without duplicating a version segment the user already typed. */
export function joinListingPath(baseUrl: string): string {
    const url = new URL(baseUrl)
    const pathName = url.pathname.replace(/\/+$/, "")
    if (/\/models$/i.test(pathName)) {
        url.pathname = pathName
    } else if (/\/v\d+$/i.test(pathName)) {
        url.pathname = `${pathName}/models`
    } else {
        url.pathname = `${pathName}/v1/models`
    }
    url.search = ""
    url.hash = ""
    return url.toString()
}

/**
 * Read a capability flag from the two shapes vendors use: a list of feature
 * names, or an object keyed by feature name.
 */
export function readSupportedFeature(raw: unknown, ...featureNames: string[]): boolean | undefined {
    if (!isRecord(raw)) {
        return undefined
    }
    const features = raw.supported_features ?? raw.supportedFeatures
    if (Array.isArray(features)) {
        return featureNames.some((name) => features.includes(name))
    }
    if (isRecord(features)) {
        for (const name of featureNames) {
            if (typeof features[name] === "boolean") {
                return features[name]
            }
        }
    }
    return undefined
}
