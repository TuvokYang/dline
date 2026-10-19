import type { ApiHandler } from "@core/api"
import type { UsageServedModel } from "./UsageSettlement"

/**
 * The provider and model a handler serves, for the usage ranking split.
 *
 * A handler that does not report its provider is still counted under its
 * model; one without a model ID is left out of the split rather than guessed.
 * A handler that cannot say whether its model is the user's own is treated as
 * serving one, so an unknown model ID never leaves the machine.
 */
export function servedModelOf(
    api: Pick<ApiHandler, "getModel" | "getProviderId" | "isCustomModel">,
): UsageServedModel | undefined {
    const model = api.getModel().id
    if (!model) return undefined
    const custom = api.isCustomModel?.() ?? true
    return { provider: api.getProviderId?.() || "unknown", model, ...(custom ? { custom } : {}) }
}
