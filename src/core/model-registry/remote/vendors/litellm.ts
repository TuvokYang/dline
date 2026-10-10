/**
 * LiteLLM `GET /v1/model/info`.
 *
 * A LiteLLM deployment is user-hosted, so the listing is the only description
 * of what it serves. Every field lives under a nested `model_info` object and
 * prices are already numeric per-token values.
 *
 * A model is published under both `model_name` and `litellm_params.model`
 * because the latter carries region prefixes (for example `us.` on Bedrock)
 * that users actually select.
 */

import { fetchLiteLlmModelsInfo } from "@core/api/providers/litellm"
import type { ModelCapabilities, ModelInfo, ModelPricing } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** Fallbacks preserved from the previous handler for deployments that omit sizes. */
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_CONTEXT_WINDOW = 8192

function readFlag(raw: unknown, field: string): boolean {
    return isRecord(raw) && isRecord(raw.model_info) && raw.model_info[field] === true
}

/** LiteLLM reports costs per token as plain numbers. */
function readPerMillionCost(raw: unknown, field: string): number | undefined {
    const perToken = readPositiveNumber(raw, `model_info.${field}`)
    return perToken === undefined ? undefined : perToken * 1_000_000
}

export class LiteLlmModelSource extends ModelListingSource {
    readonly providerId = "litellm"
    readonly providerName = "LiteLLM"
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = "http://localhost:4000"

    /** LiteLLM exposes model info through its own endpoint, reached via the shared client. */
    protected override async fetchAllPages(context: ProviderRemoteContext): Promise<unknown[]> {
        const data = await fetchLiteLlmModelsInfo(context.baseUrl || this.defaultBaseUrl, context.apiKey ?? "")
        return Array.isArray(data?.data) ? data.data : []
    }

    protected override isChatModel(raw: unknown): boolean {
        return this.readModelId(raw) !== undefined
    }

    protected override readModelId(raw: unknown): string | undefined {
        return readString(raw, "model_name")
    }

    protected override readContextWindow(raw: unknown): number {
        return readPositiveNumber(raw, "model_info.max_input_tokens", "model_info.max_tokens") ?? DEFAULT_CONTEXT_WINDOW
    }

    protected override readMaxTokens(raw: unknown): number {
        return readPositiveNumber(raw, "model_info.max_output_tokens", "model_info.max_tokens") ?? DEFAULT_MAX_TOKENS
    }

    protected override readDescription(): undefined {
        return undefined
    }

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        return {
            maxTokens: this.readMaxTokens(raw),
            contextWindow: this.readContextWindow(raw),
            supportsImages: readFlag(raw, "supports_vision"),
            supportsPromptCache: readFlag(raw, "supports_prompt_caching"),
            supportsReasoning: readFlag(raw, "supports_reasoning"),
        }
    }

    protected override readPricing(raw: unknown): ModelPricing {
        return {
            inputPrice: readPerMillionCost(raw, "input_cost_per_token") ?? 0,
            outputPrice: readPerMillionCost(raw, "output_cost_per_token") ?? 0,
            cacheWritesPrice: readPerMillionCost(raw, "cache_creation_input_token_cost"),
            cacheReadsPrice: readPerMillionCost(raw, "cache_read_input_token_cost"),
        }
    }

    /**
     * Indexes each model under both its name and its deployment id in a single
     * pass, so the listing is requested only once.
     */
    override async fetchModels(context: ProviderRemoteContext): Promise<Record<string, ModelInfo>> {
        const models: Record<string, ModelInfo> = {}

        for (const entry of await this.fetchAllPages(context)) {
            const modelName = this.readModelId(entry)
            if (!modelName) {
                continue
            }
            const modelInfo = this.toModelInfo(entry, modelName)
            models[modelName] = modelInfo

            const deploymentId = readString(entry, "litellm_params.model")
            if (deploymentId) {
                models[deploymentId] = modelInfo
            }
        }
        return models
    }
}

export const liteLlmModelSource = new LiteLlmModelSource()
