import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { setCapabilityEnabled } from "@core/storage/settings/capability-toggle-store"
import type { ToggleAgentsRuleRequest } from "@shared/proto/dline/file"
import { ClineRulesToggles } from "@shared/proto/dline/file"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { capabilityWriteContext } from "./capability-write-context"

/**
 * Toggles an Agents rule (enable or disable)
 * @param controller The controller instance
 * @param request The toggle request
 * @returns The updated Agents rule toggles
 */
export async function toggleAgentsRule(controller: Controller, request: ToggleAgentsRuleRequest): Promise<ClineRulesToggles> {
    const { rulePath, enabled } = request

    if (!rulePath || typeof enabled !== "boolean") {
        Logger.error("toggleAgentsRule: Missing or invalid parameters", {
            rulePath,
            enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
        })
        throw new Error("Missing or invalid parameters for toggleAgentsRule")
    }

    // Agents rules always come from the workspace, but the preference is stored
    // in the scope the editor is currently in, so only the changed path is
    // recorded and every other rule keeps inheriting.
    const agentsToggles = await setCapabilityEnabled(
        controller.stateManager,
        "agentsRules",
        capabilityWriteContext(controller),
        capabilityResourceId(rulePath),
        enabled,
    )

    return ClineRulesToggles.create({
        toggles: agentsToggles as Record<string, boolean>,
    })
}
