/**
 * Anthropic `GET /v1/models`.
 *
 * Anthropic differs from the OpenAI-style listing in three ways: it
 * authenticates with `x-api-key`, it paginates with an opaque cursor, and it
 * reports capabilities as a tree of `{ supported: boolean }` leaves. It also
 * publishes no prices, so pricing stays with the built-in catalog.
 */
import type { ModelCapabilities, ModelInfo } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

const ANTHROPIC_VERSION = "2023-06-01"
const PAGE_LIMIT = 1000
const MAX_PAGES = 20

/** Read a `capabilities.<name>.supported` leaf. The tree is a dict, so index it. */
function readCapabilityLeaf(raw: unknown, name: string): boolean | undefined {
	if (!isRecord(raw)) {
		return undefined
	}
	const capabilities = raw.capabilities
	if (!isRecord(capabilities)) {
		return undefined
	}
	const leaf = capabilities[name]
	if (!isRecord(leaf)) {
		return undefined
	}
	const supported = leaf.supported
	return typeof supported === "boolean" ? supported : undefined
}

/** Prompt caching shows up under context management rather than a single flag. */
function readPromptCacheSupport(raw: unknown): boolean | undefined {
	if (!isRecord(raw)) {
		return undefined
	}
	const capabilities = raw.capabilities
	if (!isRecord(capabilities)) {
		return undefined
	}
	const contextManagement = capabilities.context_management
	if (!isRecord(contextManagement)) {
		return undefined
	}
	return Object.values(contextManagement).some((leaf) => isRecord(leaf) && leaf.supported === true)
}

export class AnthropicModelSource extends ModelListingSource {
	// Declared as the contract types rather than literals so a vendor that
	// shares this wire format can subclass it with its own identity.
	readonly providerId: string = "anthropic"
	readonly providerName: string = "Anthropic"
	override readonly requiresApiKey: boolean = true
	/** The listing supplements the built-in catalog; it must not drop local pricing. */
	override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
	protected override readonly defaultBaseUrl = "https://api.anthropic.com"

	protected override buildHeaders(context: ProviderRemoteContext): Record<string, string> {
		const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION }
		if (context.apiKey) {
			headers["x-api-key"] = context.apiKey
		}
		return headers
	}

	protected override async fetchAllPages(context: ProviderRemoteContext): Promise<unknown[]> {
		const entries: unknown[] = []
		let afterId: string | undefined

		for (let page = 0; page < MAX_PAGES; page++) {
			const url = new URL(this.buildListingUrl(context))
			url.searchParams.set("limit", String(PAGE_LIMIT))
			if (afterId) {
				url.searchParams.set("after_id", afterId)
			}

			const payload = await this.requestJson(url.toString(), context)
			entries.push(...this.readPageEntries(payload))

			if (!isRecord(payload) || payload.has_more !== true) {
				break
			}
			const lastId = readString(payload, "last_id")
			if (!lastId || lastId === afterId) {
				break
			}
			afterId = lastId
		}

		return entries
	}

	protected override isChatModel(raw: unknown): boolean {
		return isRecord(raw) && raw.type === "model" && typeof raw.id === "string" && raw.id.length > 0
	}

	protected override readDescription(raw: unknown): string | undefined {
		return readString(raw, "display_name")
	}

	protected override readContextWindow(raw: unknown): number | undefined {
		return readPositiveNumber(raw, "max_input_tokens")
	}

	protected override readMaxTokens(raw: unknown): number | undefined {
		return readPositiveNumber(raw, "max_tokens")
	}

	protected override readCapabilities(raw: unknown): ModelCapabilities {
		return {
			contextWindow: this.readContextWindow(raw),
			maxTokens: this.readMaxTokens(raw),
			supportsImages: readCapabilityLeaf(raw, "image_input"),
			supportsReasoning: readCapabilityLeaf(raw, "thinking"),
			supportsPromptCache: readPromptCacheSupport(raw),
		}
	}

	/** Anthropic does not return prices, so stored pricing must survive the merge. */
	protected override readPricing(): undefined {
		return undefined
	}

	protected override toModelInfo(raw: unknown, modelId: string): ModelInfo {
		return {
			id: modelId,
			name: modelId,
			description: this.readDescription(raw),
			capabilities: this.readCapabilities(raw),
		}
	}
}

export const anthropicModelSource = new AnthropicModelSource()
