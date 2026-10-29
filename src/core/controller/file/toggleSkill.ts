import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { mergeScopedToggles, readScopedToggles, setCapabilityEnabled } from "@core/storage/settings/capability-toggle-store"
import { setGlobalCapabilityEnabled } from "@core/storage/settings/global-capability-settings"
import { SkillsToggles, ToggleSkillRequest } from "@shared/proto/dline/file"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { capabilityWriteContext } from "./capability-write-context"

/**
 * Toggles a skill on or off
 * @param controller The controller instance
 * @param request The request containing the skill path and enabled state
 * @returns The updated skills toggles
 */
export async function toggleSkill(controller: Controller, request: ToggleSkillRequest): Promise<SkillsToggles> {
    const { skillPath, isGlobal, enabled } = request

    if (!skillPath || typeof enabled !== "boolean" || typeof isGlobal !== "boolean") {
        Logger.error("toggleSkill: Missing or invalid parameters", {
            skillPath,
            isGlobal,
            enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
        })
        throw new Error("Missing or invalid parameters for toggleSkill")
    }

    let globalToggles = controller.stateManager.getGlobalSettingsKey("globalSkillsToggles") || {}
    let localToggles = mergeScopedToggles(readScopedToggles(controller.stateManager, "skills"))

    let remoteToggles = controller.stateManager.getGlobalStateKey("remoteSkillsToggles") || {}

    // Remote skills are identified by a "remote:" path prefix. They use a separate toggle store
    // keyed by skill name (the part after "remote:") rather than the file path.
    if (skillPath.startsWith("remote:")) {
        const name = skillPath.replace("remote:", "")
        remoteToggles = { ...remoteToggles, [name]: enabled }
        controller.stateManager.setGlobalState("remoteSkillsToggles", remoteToggles)
    } else if (isGlobal) {
        globalToggles = await setGlobalCapabilityEnabled(controller.stateManager, "globalSkillsToggles", skillPath, enabled)
    } else {
        // The skill's origin is local, but the preference lands in whichever scope
        // the editor is currently in, so a task can disable it without changing
        // the workspace default.
        localToggles = (await setCapabilityEnabled(
            controller.stateManager,
            "skills",
            capabilityWriteContext(controller),
            capabilityResourceId(skillPath),
            enabled,
        )) as Record<string, boolean>
    }

    // The response below already carries every toggle map the caller needs, so a
    // full state publication would only add a webview-wide recompute to a switch.
    return SkillsToggles.create({
        globalSkillsToggles: globalToggles,
        localSkillsToggles: localToggles,
        remoteSkillsToggles: remoteToggles,
    })
}
