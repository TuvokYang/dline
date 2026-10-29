import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { setCapabilityEnabled } from "@core/storage/settings/capability-toggle-store"
import type { ToggleCursorRuleRequest } from "@shared/proto/dline/file"
import { ClineRulesToggles } from "@shared/proto/dline/file"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { capabilityWriteContext } from "./capability-write-context"

/**
 * Toggles a Cursor rule (enable or disable)
 * @param controller The controller instance
 * @param request The toggle request
 * @returns The updated Cursor rule toggles
 */
export async function toggleCursorRule(controller: Controller, request: ToggleCursorRuleRequest): Promise<ClineRulesToggles> {
    const { rulePath, enabled } = request

    if (!rulePath || typeof enabled !== "boolean") {
        Logger.error("toggleCursorRule: Missing or invalid parameters", {
            rulePath,
            enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
        })
        throw new Error("Missing or invalid parameters for toggleCursorRule")
    }

    // Cursor rules always come from the workspace, but the preference is stored
    // in the scope the editor is currently in, so only the changed path is
    // recorded and every other rule keeps inheriting.
    const cursorToggles = await setCapabilityEnabled(
        controller.stateManager,
        "cursorRules",
        capabilityWriteContext(controller),
        capabilityResourceId(rulePath),
        enabled,
    )

    return ClineRulesToggles.create({
        toggles: cursorToggles as Record<string, boolean>,
    })
}
