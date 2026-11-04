/**
 * Alibaba Qwen `GET {base}/models`.
 *
 * Verified against the live gateway: every regional
 * `https://<region>.maas.qwencloudapi.com/compatible-mode/v1/models` host and
 * both legacy `dashscope*.aliyuncs.com/compatible-mode/v1/models` hosts answer
 * on that path. The listing carries ids only, so `overlay-remote` keeps the
 * local prices and capabilities and adds ids this build has not seeded yet.
 *
 * Qwen also serves several data centres whose hosts are region-specific. A
 * Profile selects a line rather than a URL, so the catalog key picks the
 * regional default; an explicit base URL still wins, which is what lets a user
 * point the provider at any of the newer `maas.qwencloudapi.com` hosts.
 */
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { joinListingPath, ModelListingSource } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

const QWEN_DEFAULT_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"

/** The mainland host, selected by the Profile's region rather than by a base URL. */
const QWEN_CATALOG_BASE_URLS: Readonly<Record<string, string>> = {
    "qwen-cn": "https://dashscope.aliyuncs.com/compatible-mode/v1",
}

export class QwenModelSource extends ModelListingSource {
    readonly providerId = "qwen"
    readonly providerName = "Alibaba Qwen"
    /** The listing states ids only, so stored pricing and capabilities must survive. */
    override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
    protected override readonly defaultBaseUrl = QWEN_DEFAULT_BASE_URL

    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const regionalDefault = context.catalogKey ? QWEN_CATALOG_BASE_URLS[context.catalogKey] : undefined
        return joinListingPath(context.baseUrl || regionalDefault || this.defaultBaseUrl)
    }
}

export const qwenModelSource = new QwenModelSource()
