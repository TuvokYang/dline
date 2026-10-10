import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { setCapabilityEnabled } from "@core/storage/settings/capability-toggle-store"
import type { ToggleWindsurfRuleRequest } from "@shared/proto/dline/file"
import { ClineRulesToggles } from "@shared/proto/dline/file"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { capabilityWriteContext } from "./capability-write-context"

/**
 * Toggles a Windsurf rule (enable or disable)
 * @param controller The controller instance
 * @param request The toggle request
 * @returns The updated Windsurf rule toggles
 */
export async function toggleWindsurfRule(controller: Controller, request: ToggleWindsurfRuleRequest): Promise<ClineRulesToggles> {
    const { rulePath, enabled } = request

    if (!rulePath || typeof enabled !== "boolean") {
        Logger.error("toggleWindsurfRule: Missing or invalid parameters", {
            rulePath,
            enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
        })
        throw new Error("Missing or invalid parameters for toggleWindsurfRule")
    }

    // Windsurf rules always come from the workspace, but the preference is stored
    // in the scope the editor is currently in, so only the changed path is
    // recorded and every other rule keeps inheriting.
    const toggles = await setCapabilityEnabled(
        controller.stateManager,
        "windsurfRules",
        capabilityWriteContext(controller),
        capabilityResourceId(rulePath),
        enabled,
    )

    return ClineRulesToggles.create({ toggles: toggles as Record<string, boolean> })
}
