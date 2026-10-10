/**
 * Baseten `GET /v1/models`.
 *
 * Baseten follows the OpenAI listing shape but reports per-token prices as
 * strings and uses `context_length` for the input window.
 */
import type { ModelPricing } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { ModelListingSource, readPerMillionPrice, readPositiveNumber } from "../model-listing-source"

export class BasetenModelSource extends ModelListingSource {
    readonly providerId = "baseten"
    readonly providerName = "Baseten"
    override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
    protected override readonly defaultBaseUrl = "https://inference.baseten.co/v1"

    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "context_length")
    }

    protected override readPricing(raw: unknown): ModelPricing | undefined {
        const inputPrice = readPerMillionPrice(raw, "pricing.prompt")
        const outputPrice = readPerMillionPrice(raw, "pricing.completion")
        if (inputPrice === undefined && outputPrice === undefined) {
            return undefined
        }
        return { inputPrice, outputPrice }
    }
}

export const basetenModelSource = new BasetenModelSource()
