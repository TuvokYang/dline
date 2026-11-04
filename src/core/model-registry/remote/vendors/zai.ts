/**
 * Z AI `GET {base}/models`.
 *
 * Verified against the live gateway: the endpoint answers
 * `{ object: "list", data: [{ id, object, created, owned_by }] }` for both
 * `api.z.ai` and `open.bigmodel.cn`, and the coding-plan path
 * (`/api/coding/paas/v4/models`) returns the same document. The listing carries
 * no prices, windows or capabilities at all.
 *
 * Because the gateway names a family rather than restating its metadata, a
 * discovered id inherits the declarations of the closest model this build
 * already knows: `glm-5.3-flash` inherits `glm-5.3`, `glm-5-turbo` inherits
 * `glm-5`. `overlay-remote` then keeps the stored value for every model the
 * catalog already carries.
 */
import { mainlandZAiModels } from "@core/api/providers/models/zai-cn"
import { internationalZAiModels } from "@core/api/providers/models/zai-intl"
import type { ModelCapabilities, ModelInfo } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { joinListingPath, ModelListingSource } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4"

/**
 * The mainland host, selected by the Profile's region rather than by a base URL.
 *
 * `joinListingPath` already turns either value into `<base>/models`, so the only
 * regional difference is the host itself.
 */
const ZAI_CATALOG_BASE_URLS: Readonly<Record<string, string>> = {
    "zai-cn": "https://open.bigmodel.cn/api/paas/v4",
}

/**
 * Every model this build has declared, for either endpoint.
 *
 * The two regional catalogs serve the same families, so a model declared in one
 * is a valid ancestor for a listing returned by the other. Merging them keeps a
 * mainland-only or international-only declaration usable as a fallback.
 */
const DECLARED_MODELS: Record<string, ModelInfo> = { ...internationalZAiModels, ...mainlandZAiModels }

/**
 * Find the declaration a discovered id descends from.
 *
 * The gateway suffixes a variant onto its family name (`glm-5.3-flash`,
 * `glm-5.3-flashx`, `glm-5.3-flashx-legal`), so the ancestor is the longest
 * declared id the new id starts with. Matching on `-` keeps `glm-5` from being
 * read as a prefix of `glm-5.3`, which is a separate declaration the listing
 * does name on its own. `glm-5-turbo` needs the same guard, so the separator is
 * required rather than merely preferred.
 */
function findAncestor(modelId: string): ModelInfo | undefined {
    let best: ModelInfo | undefined
    for (const [declaredId, declared] of Object.entries(DECLARED_MODELS)) {
        if (declaredId === modelId || !modelId.startsWith(`${declaredId}-`)) {
            continue
        }
        if (!best || declaredId.length > best.id.length) {
            best = declared
        }
    }
    return best
}

export class ZAiModelSource extends ModelListingSource {
    readonly providerId = "zai"
    readonly providerName = "Z AI"
    /** The listing states ids only, so stored pricing and capabilities must survive. */
    override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
    protected override readonly defaultBaseUrl = ZAI_DEFAULT_BASE_URL

    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const regionalDefault = context.catalogKey ? ZAI_CATALOG_BASE_URLS[context.catalogKey] : undefined
        return joinListingPath(context.baseUrl || regionalDefault || this.defaultBaseUrl)
    }

    /**
     * Fill an unlisted window and output limit from the family declaration.
     *
     * A value the gateway states always wins; this only answers the silence the
     * id-only listing leaves behind, so a discovered variant is usable instead of
     * carrying an empty capability set.
     */
    protected override readCapabilities(raw: unknown): ModelCapabilities {
        // The listing states nothing, so the local declarations are the only
        // statement of these values. The model's own declaration wins; a family
        // fallback covers a variant the catalog has not named yet.
        const declared = this.readDeclaredSource(raw)
        const capabilities = super.readCapabilities(raw)
        return {
            ...capabilities,
            contextWindow: capabilities.contextWindow ?? declared?.capabilities?.contextWindow,
            maxTokens: capabilities.maxTokens ?? declared?.capabilities?.maxTokens,
            // A GLM variant carries its family's protocol switches: the seeded
            // declarations are the only statement of them, because the listing
            // reports nothing beyond the id.
            supportsImages: capabilities.supportsImages ?? declared?.capabilities?.supportsImages,
            supportsPromptCache: capabilities.supportsPromptCache ?? declared?.capabilities?.supportsPromptCache,
            thinking: capabilities.thinking ?? declared?.capabilities?.thinking,
        }
    }

    /** Pricing is never inherited: a variant's rate is its own statement. */
    protected override toModelInfo(raw: unknown, modelId: string): ModelInfo {
        const declared = this.readDeclaredSource(raw)
        const listed = super.toModelInfo(raw, modelId)
        return {
            ...listed,
            // Display name only; pricing and capabilities stay as the listing and
            // the declaration decided them.
            name: listed.name === modelId && declared?.name ? declared.name : listed.name,
        }
    }

    /** The model's own declaration when the catalog has one, else its family's. */
    private readDeclaredSource(raw: unknown): ModelInfo | undefined {
        const modelId = this.readModelId(raw)
        if (!modelId) return undefined
        return DECLARED_MODELS[modelId] ?? findAncestor(modelId)
    }
}

export const zAiModelSource = new ZAiModelSource()
