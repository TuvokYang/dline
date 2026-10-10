import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import {
    clearCapabilityOverrideEverywhere,
    mergeScopedToggles,
    readScopedToggles,
} from "@core/storage/settings/capability-toggle-store"
import { removeGlobalCapability } from "@core/storage/settings/global-capability-settings"
import { DeleteSkillRequest, SkillsToggles } from "@shared/proto/dline/file"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath } from "@/utils/fs"
import { Controller } from ".."

/**
 * Deletes an existing skill directory
 * @param controller The controller instance
 * @param request The request containing skill path and isGlobal flag
 * @returns The updated skills toggles
 */
export async function deleteSkillFile(controller: Controller, request: DeleteSkillRequest): Promise<SkillsToggles> {
    const { skillPath, isGlobal } = request

    if (!skillPath || typeof skillPath !== "string" || typeof isGlobal !== "boolean") {
        Logger.error("deleteSkillFile: Missing or invalid parameters", {
            skillPath: typeof skillPath === "string" ? skillPath : `Invalid: ${typeof skillPath}`,
            isGlobal: typeof isGlobal === "boolean" ? isGlobal : `Invalid: ${typeof isGlobal}`,
        })
        throw new Error("Missing or invalid parameters for deleteSkillFile")
    }

    // Get the skill directory (skillPath points to SKILL.md, so get parent)
    const skillDir = path.dirname(skillPath)

    // Verify the path exists
    if (!(await fileExistsAtPath(skillDir))) {
        Logger.warn(`deleteSkillFile: Skill directory not found: ${skillDir}`)
        // Return current toggles anyway
        const globalToggles = controller.stateManager.getGlobalSettingsKey("globalSkillsToggles") || {}
        const localToggles = mergeScopedToggles(readScopedToggles(controller.stateManager, "skills"))
        return SkillsToggles.create({
            globalSkillsToggles: globalToggles,
            localSkillsToggles: localToggles,
        })
    }

    // Delete the skill directory
    await fs.rm(skillDir, { recursive: true, force: true })

    // The file is gone, so its override in every scope is now an orphan.
    let globalToggles = controller.stateManager.getGlobalSettingsKey("globalSkillsToggles") || {}

    if (isGlobal) {
        globalToggles = await removeGlobalCapability(controller.stateManager, "globalSkillsToggles", skillPath)
    } else {
        await clearCapabilityOverrideEverywhere(controller.stateManager, "skills", capabilityResourceId(skillPath))
    }
    const localToggles = mergeScopedToggles(readScopedToggles(controller.stateManager, "skills"))

    if (controller.task) {
        await controller.task.owners.prompt.flush("capability_mutation")
    } else {
        await controller.postStateToWebview()
    }

    return SkillsToggles.create({
        globalSkillsToggles: globalToggles,
        localSkillsToggles: localToggles,
    })
}
