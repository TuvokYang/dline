import type { ApiHandler } from "@core/api"
import { resolveProviderFromProfile } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import type { ApiProvider } from "@shared/api"
import type { HookModelInputContext } from "./hook-factory"

export type ResolvedHookModelContext = Required<HookModelInputContext>

/**
 * Resolve the active provider/model pair used for hook payload metadata.
 */
export function getHookModelContext(api: ApiHandler, stateManager: StateManager): ResolvedHookModelContext {
    const mode = stateManager.getGlobalSettingsKey("mode")
    const resolvedMode = mode === "plan" ? "plan" : "act"
    const apiConfig = stateManager.getApiConfiguration()
    // `api` is the handler for the currently resolved mode, so its model is the
    // one the hook describes; the provider comes from that mode's profile.
    const provider = (
        resolvedMode === "plan"
            ? resolveProviderFromProfile(apiConfig.planModeProfile)
            : resolveProviderFromProfile(apiConfig.actModeProfile)
    ) as ApiProvider | undefined
    const slug = api.getModel().id

    return {
        provider: provider || "unknown",
        slug: slug || "unknown",
    }
}
