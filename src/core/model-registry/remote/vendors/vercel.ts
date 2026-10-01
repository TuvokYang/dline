/**
 * Vercel AI Gateway `GET /v1/models`.
 *
 * The gateway aggregates other vendors, so the listing is authoritative and
 * replaces the stored catalog. Reasoning tags declare coarse support only;
 * absent mode, effort and budget metadata stays unknown.
 */
import type { ModelCapabilities, ModelPricing } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPerMillionPrice, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

function readTags(raw: unknown): string[] {
	if (!isRecord(raw) || !Array.isArray(raw.tags)) {
		return []
	}
	return raw.tags.filter((value): value is string => typeof value === "string")
}

export class VercelAiGatewayModelSource extends ModelListingSource {
	readonly providerId = "vercel-ai-gateway"
	readonly providerName = "Vercel AI Gateway"
	/** The gateway lists its catalog publicly. */
	override readonly requiresApiKey = false
	override readonly reconciliation: ProviderModelReconciliationMode = "replace"
	protected override readonly defaultBaseUrl = "https://ai-gateway.vercel.sh/v1"

	/** `include_mappings` makes the gateway report the upstream model ids. */
	protected override buildListingUrl(context: ProviderRemoteContext): string {
		return `${super.buildListingUrl(context)}?include_mappings=true`
	}

	protected override isChatModel(raw: unknown): boolean {
		if (!isRecord(raw) || raw.type === "embedding") {
			return false
		}
		return typeof raw.id === "string" && raw.id.length > 0
	}

	protected override readModelName(raw: unknown, modelId: string): string {
		return readString(raw, "name") ?? modelId
	}

	protected override readDescription(raw: unknown): string {
		return readString(raw, "description") ?? ""
	}

	protected override readContextWindow(raw: unknown): number | undefined {
		return readPositiveNumber(raw, "context_window")
	}

	protected override readMaxTokens(raw: unknown): number | undefined {
		return readPositiveNumber(raw, "max_tokens")
	}

	protected override readCapabilities(raw: unknown): ModelCapabilities {
		const supportsReasoning = isRecord(raw) && Array.isArray(raw.tags) ? readTags(raw).includes("reasoning") : undefined
		const cacheReadsPrice = readPerMillionPrice(raw, "pricing.input_cache_read")
		const cacheWritesPrice = readPerMillionPrice(raw, "pricing.input_cache_write")

		return {
			maxTokens: this.readMaxTokens(raw) ?? 0,
			contextWindow: this.readContextWindow(raw) ?? 0,
			// The gateway does not report image support, so assume every model has it.
			supportsImages: true,
			supportsPromptCache: cacheReadsPrice !== undefined && cacheWritesPrice !== undefined,
			supportsReasoning,
		}
	}

	protected override readPricing(raw: unknown): ModelPricing {
		return {
			inputPrice: readPerMillionPrice(raw, "pricing.input") ?? 0,
			outputPrice: readPerMillionPrice(raw, "pricing.output") ?? 0,
			cacheWritesPrice: readPerMillionPrice(raw, "pricing.input_cache_write") ?? 0,
			cacheReadsPrice: readPerMillionPrice(raw, "pricing.input_cache_read") ?? 0,
		}
	}
}

export const vercelAiGatewayModelSource = new VercelAiGatewayModelSource()
