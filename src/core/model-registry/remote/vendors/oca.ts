/**
 * OCA `GET /v1/model/info`.
 *
 * OCA speaks the LiteLLM proxy shape: the model id lives in `litellm_params`
 * and the metadata in `model_info`. The listing is authoritative — an account
 * only reaches the models its entitlements expose — so it replaces the catalog.
 *
 * Banner, survey, and reasoning-effort options are OCA-specific and stay out of
 * `ModelInfo`; the OCA handler reads them from the raw listing itself.
 */

import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import type { ModelInfo } from "@shared/providers/types"
import { CHAT_COMPLETIONS_API, MESSAGES_API, RESPONSES_API } from "@/services/auth/oca/utils/constants"
import { createOcaHeaders } from "@/services/auth/oca/utils/utils"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPerMillionPrice, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** OCA reports no token limit for some models; the runtime treats -1 as unbounded. */
const UNKNOWN_MAX_TOKENS = -1

export class OcaModelSource extends ModelListingSource {
    readonly providerId = "oca"
    readonly providerName = "OCA"
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = ""

    protected override buildListingUrl(context: ProviderRemoteContext): string {
        return `${context.baseUrl ?? ""}/v1/model/info`
    }

    /**
     * OCA rejects requests without its correlation and tenancy headers, so the
     * listing reuses the same header builder as the rest of the OCA client.
     */
    protected override async buildHeaders(context: ProviderRemoteContext): Promise<Record<string, string>> {
        return createOcaHeaders(context.apiKey ?? "", "models-refresh")
    }

    protected override readModelId(raw: unknown): string | undefined {
        return readString(raw, "litellm_params.model")
    }

    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "model_info.context_window")
    }

    protected override readMaxTokens(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "litellm_params.max_tokens") ?? UNKNOWN_MAX_TOKENS
    }

    protected override readDescription(raw: unknown): string | undefined {
        return readString(raw, "model_info.description")
    }

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        return {
            contextWindow: this.readContextWindow(raw),
            maxTokens: this.readMaxTokens(raw),
            supportsImages: readModelInfoFlag(raw, "supports_vision"),
            supportsPromptCache: readModelInfoFlag(raw, "supports_caching"),
            supportsReasoning: readModelInfoFlag(raw, "is_reasoning_model"),
        }
    }

    protected override readPricing(raw: unknown): ModelPricing {
        return {
            inputPrice: readPerMillionPrice(raw, "model_info.input_price") ?? 0,
            outputPrice: readPerMillionPrice(raw, "model_info.output_price") ?? 0,
            cacheWritesPrice: readPerMillionPrice(raw, "model_info.caching_price") ?? 0,
            cacheReadsPrice: readPerMillionPrice(raw, "model_info.cached_price") ?? 0,
        }
    }

    /** The accepted API is part of the model contract, so it travels with the catalog entry. */
    protected override toModelInfo(raw: unknown, modelId: string): ModelInfo {
        return {
            ...super.toModelInfo(raw, modelId),
            apiFormats: [resolveOcaApiFormat(readSupportedApiList(raw))],
        }
    }

    /**
     * Catalog entries plus the OCA-only presentation fields, from a single
     * request. The shared `ModelInfo` contract cannot carry banner, survey or
     * reasoning-effort options, and refetching the listing to recover them would
     * double the round trips.
     */
    async fetchModelsWithExtras(context: ProviderRemoteContext): Promise<OcaListing> {
        const models: Record<string, ModelInfo> = {}
        const extras: Record<string, OcaModelExtras> = {}
        for (const entry of await this.fetchAllPages(context)) {
            const modelId = this.readModelId(entry)
            if (!modelId) {
                continue
            }
            models[modelId] = this.toModelInfo(entry, modelId)
            extras[modelId] = {
                banner: readString(entry, "model_info.banner"),
                surveyId: readString(entry, "model_info.survey_id"),
                surveyContent: readString(entry, "model_info.survey_content"),
                reasoningEffortOptions: readReasoningEffortOptions(entry),
            }
        }
        return { models, extras }
    }
}

/** OCA-only presentation data that has no place in the shared model contract. */
export interface OcaModelExtras {
    readonly banner?: string
    readonly surveyId?: string
    readonly surveyContent?: string
    readonly reasoningEffortOptions: string[]
}

export interface OcaListing {
    readonly models: Record<string, ModelInfo>
    readonly extras: Record<string, OcaModelExtras>
}

function readReasoningEffortOptions(raw: unknown): string[] {
    const modelInfo = readModelInfo(raw)
    if (!isRecord(modelInfo) || !Array.isArray(modelInfo.reasoning_effort_options)) {
        return []
    }
    return modelInfo.reasoning_effort_options.filter((entry): entry is string => typeof entry === "string")
}

/**
 * OCA advertises the APIs a model accepts; the first supported one wins so a
 * model reachable through several APIs keeps the historical preference order.
 */
export function resolveOcaApiFormat(supportedApiList: readonly string[]): ApiFormat {
    if (supportedApiList.includes(CHAT_COMPLETIONS_API)) {
        return ApiFormat.OPENAI_CHAT
    }
    if (supportedApiList.includes(RESPONSES_API)) {
        return ApiFormat.OPENAI_RESPONSES
    }
    if (supportedApiList.includes(MESSAGES_API)) {
        return ApiFormat.ANTHROPIC_CHAT
    }
    return ApiFormat.OPENAI_CHAT
}

function readModelInfo(raw: unknown): unknown {
    return isRecord(raw) ? raw.model_info : undefined
}

/** OCA publishes capabilities as plain booleans on `model_info`. */
function readModelInfoFlag(raw: unknown, field: string): boolean {
    const modelInfo = readModelInfo(raw)
    return isRecord(modelInfo) && modelInfo[field] === true
}

/** Defaults to chat completions, matching OCA models that omit the field. */
function readSupportedApiList(raw: unknown): string[] {
    const modelInfo = readModelInfo(raw)
    if (!isRecord(modelInfo) || !Array.isArray(modelInfo.supported_api_list)) {
        return [CHAT_COMPLETIONS_API]
    }
    return modelInfo.supported_api_list.filter((entry): entry is string => typeof entry === "string")
}

export const ocaModelSource = new OcaModelSource()
