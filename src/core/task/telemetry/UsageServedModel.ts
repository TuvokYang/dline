import type { ApiHandler } from "@core/api"
import type { UsageServedModel } from "./UsageSettlement"

/**
 * The provider and model a handler serves, for the usage ranking split.
 *
 * A handler that does not report its provider is still counted under its
 * model; one without a model ID is left out of the split rather than guessed.
 */
export function servedModelOf(api: Pick<ApiHandler, "getModel" | "getProviderId">): UsageServedModel | undefined {
    const model = api.getModel().id
    if (!model) return undefined
    return { provider: api.getProviderId?.() || "unknown", model }
}
