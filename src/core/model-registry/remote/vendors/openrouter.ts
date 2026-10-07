/**
 * OpenRouter `GET /v1/models`.
 *
 * The catalog is fully derived from the listing, so it replaces the stored one
 * rather than overlaying it. OpenRouter publishes prices as per-token strings
 * and reports modality instead of explicit capability flags.
 *
 * Vendor-specific corrections (restricted context windows, cache prices the
 * listing omits, the `:1m` Sonnet variants) live in the handler's post-process
 * step so that this class stays a plain listing reader.
 */

import type { ModelCapabilities, ModelPricing } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPerMillionPrice, readPositiveNumber, readString } from "../model-listing-source"

function readSupportedParameters(raw: unknown): string[] {
	if (!isRecord(raw)) {
		return []
	}
	const parameters = raw.supported_parameters
	return Array.isArray(parameters) ? parameters.filter((value): value is string => typeof value === "string") : []
}

/** OpenRouter reports modality either as `"text+image->text"` or as a list of modalities. */
function supportsImageModality(raw: unknown): boolean {
	if (!isRecord(raw) || !isRecord(raw.architecture)) {
		return false
	}
	const modality = raw.architecture.modality
	if (typeof modality === "string") {
		return modality.includes("image")
	}
	return Array.isArray(modality) && modality.some((value) => typeof value === "string" && value.includes("image"))
}

// Vendors that republish an OpenRouter-shaped catalog subclass this, so the
// identity fields stay widened rather than narrowed to literal types.
export class OpenRouterModelSource extends ModelListingSource {
	readonly providerId: string = "openrouter"
	readonly providerName: string = "OpenRouter"
	/** OpenRouter lists its catalog publicly. */
	override readonly requiresApiKey: boolean = false
	override readonly reconciliation: ProviderModelReconciliationMode = "replace"
	protected override readonly defaultBaseUrl: string = "https://openrouter.ai/api/v1"

	protected override isChatModel(raw: unknown): boolean {
		return isRecord(raw) && typeof raw.id === "string" && raw.id.length > 0
	}

	protected override readMaxTokens(raw: unknown): number | undefined {
		return readPositiveNumber(raw, "top_provider.max_completion_tokens")
	}

	protected override readContextWindow(raw: unknown): number | undefined {
		return readPositiveNumber(raw, "context_length")
	}

	protected override readDescription(raw: unknown): string {
		return readString(raw, "description") ?? ""
	}

	protected override readModelName(raw: unknown, modelId: string): string {
		return readString(raw, "name") ?? modelId
	}

	protected override readCapabilities(raw: unknown): ModelCapabilities {
		const parameters = readSupportedParameters(raw)
		const supportsReasoning =
			isRecord(raw) && Array.isArray(raw.supported_parameters)
				? parameters.includes("include_reasoning") || parameters.includes("reasoning")
				: undefined

		return {
			maxTokens: this.readMaxTokens(raw) ?? 0,
			contextWindow: this.readContextWindow(raw) ?? 0,
			supportsImages: supportsImageModality(raw),
			supportsPromptCache: false,
			supportsTools: parameters.includes("tools"),
			// Parameter support does not declare a thinking mode or its bounds.
			supportsReasoning,
			supportsGlobalEndpoint:
				isRecord(raw) && typeof raw.supports_global_endpoint === "boolean" ? raw.supports_global_endpoint : undefined,
		}
	}

	protected override readPricing(raw: unknown): ModelPricing | undefined {
		return {
			inputPrice: readPerMillionPrice(raw, "pricing.prompt") ?? 0,
			outputPrice: readPerMillionPrice(raw, "pricing.completion") ?? 0,
			cacheWritesPrice: readPerMillionPrice(raw, "pricing.input_cache_write"),
			cacheReadsPrice: readPerMillionPrice(raw, "pricing.input_cache_read"),
			tiers: isRecord(raw) && Array.isArray(raw.tiers) ? raw.tiers : undefined,
		}
	}

	protected override readModelId(raw: unknown): string | undefined {
		return readString(raw, "id") ?? readString(raw, "name")
	}
}

export const openRouterModelSource = new OpenRouterModelSource()
