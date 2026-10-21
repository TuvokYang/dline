import type { ApiHandler } from "@core/api"
import type { UsageServedModel } from "./UsageSettlement"

/**
 * The provider and model a handler serves, for the usage ranking split.
 *
 * A handler that does not report its provider is still counted under its
 * model; one without a model ID is left out of the split rather than guessed.
 * Only a handler that reports the Profile's custom-model switch as on serves a
 * custom model; one that cannot say is counted under its model ID.
 */
export function servedModelOf(
    api: Pick<ApiHandler, "getModel" | "getProviderId" | "isCustomModel">,
): UsageServedModel | undefined {
    const model = api.getModel().id
    if (!model) return undefined
    const custom = api.isCustomModel?.() === true
    return { provider: api.getProviderId?.() || "unknown", model, ...(custom ? { custom } : {}) }
}
