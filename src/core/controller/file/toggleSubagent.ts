import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { setCapabilityEnabled } from "@core/storage/settings/capability-toggle-store"
import { setGlobalCapabilityEnabled } from "@core/storage/settings/global-capability-settings"
import { SubagentToggles, ToggleSubagentRequest } from "@shared/proto/dline/file"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { capabilityWriteContext } from "./capability-write-context"

/**
 * Toggles a subagent on or off.
 * @param controller The controller instance
 * @param request The request containing the subagent path and enabled state
 * @returns The updated subagent toggles
 */
export async function toggleSubagent(controller: Controller, request: ToggleSubagentRequest): Promise<SubagentToggles> {
    const { subagentPath, isGlobal, enabled } = request

    if (!subagentPath || typeof enabled !== "boolean") {
        Logger.error("toggleSubagent: Missing or invalid parameters", { subagentPath, enabled })
        throw new Error("Missing or invalid parameters for toggleSubagent")
    }

    let globalToggles: Record<string, boolean> = {}
    let localToggles: Record<string, boolean> = {}

    if (isGlobal) {
        globalToggles = await setGlobalCapabilityEnabled(controller.stateManager, "globalSubagentsToggles", subagentPath, enabled)
    } else {
        // Local origin, but the preference lands in the scope the editor is in.
        localToggles = (await setCapabilityEnabled(
            controller.stateManager,
            "subagents",
            capabilityWriteContext(controller),
            capabilityResourceId(subagentPath),
            enabled,
        )) as Record<string, boolean>
    }

    return SubagentToggles.create({
        globalSubagentsToggles: globalToggles,
        localSubagentsToggles: localToggles,
    })
}
