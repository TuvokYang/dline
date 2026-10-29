import { ensureAgentSubagentsDirectoryExists } from "@core/storage/disk"
import { mergeScopedToggles, readScopedToggles } from "@core/storage/settings/capability-toggle-store"
import { CreateSubagentRequest, SubagentToggles } from "@shared/proto/dline/file"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath } from "@/utils/fs"
import { Controller } from ".."
import { openFile } from "./openFile"

const SUBAGENT_TEMPLATE = `---
name: {{SUBAGENT_NAME}}
description: Research and exploration subagent
tools:
  - read_file
  - search_files
  - list_files
  - list_code_definition_names
skills: []
# maxOutputTokens is measured in tokens. Omit it for the dynamic 5% default,
# use 0.05 for a ratio, or use a positive integer such as 10240 for an absolute budget.
---
You are {{SUBAGENT_NAME}}, a specialized research subagent. Your role is to explore the codebase, read files, search for code patterns, and report your findings clearly.

When given a task:
1. Read relevant files to understand the context
2. Search for related code patterns and definitions
3. Report your findings concisely with file paths and line numbers

Do NOT modify any files. Only read, search, list, and report.
`

/**
 * Creates a new subagent from template.
 * @param controller The controller instance
 * @param request The request containing subagent name and isGlobal flag
 * @returns The updated subagent toggles
 */
export async function createSubagentFile(controller: Controller, request: CreateSubagentRequest): Promise<SubagentToggles> {
    const { subagentName, isGlobal } = request

    if (!subagentName || typeof subagentName !== "string" || typeof isGlobal !== "boolean") {
        Logger.error("createSubagentFile: Missing or invalid parameters", {
            subagentName: typeof subagentName === "string" ? subagentName : `Invalid: ${typeof subagentName}`,
            isGlobal: typeof isGlobal === "boolean" ? isGlobal : `Invalid: ${typeof isGlobal}`,
        })
        throw new Error("Missing or invalid parameters for createSubagentFile")
    }

    // Validate subagent name (must be valid filename)
    const sanitizedName = subagentName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
    if (!sanitizedName) {
        throw new Error("Invalid subagent name")
    }

    let subagentDir: string

    if (isGlobal) {
        const globalDir = await ensureAgentSubagentsDirectoryExists({ isGlobal: true })
        subagentDir = globalDir
    } else {
        const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
        const primaryWorkspace = workspacePaths.paths[0]
        if (!primaryWorkspace) {
            throw new Error("No workspace folder open")
        }
        const localDir = await ensureAgentSubagentsDirectoryExists({
            isGlobal: false,
            workspacePath: primaryWorkspace,
        })
        subagentDir = localDir
    }

    const filePath = path.join(subagentDir, `${sanitizedName}.yml`)

    // Check if subagent already exists
    if (await fileExistsAtPath(filePath)) {
        Logger.warn(`Subagent "${sanitizedName}" already exists at ${filePath}`)
        // Return current toggles
        const globalToggles = controller.stateManager.getGlobalSettingsKey("globalSubagentsToggles") || {}
        const localToggles = mergeScopedToggles(readScopedToggles(controller.stateManager, "subagents"))
        return SubagentToggles.create({
            globalSubagentsToggles: globalToggles,
            localSubagentsToggles: localToggles,
        })
    }

    // Create the YAML file from template
    const content = SUBAGENT_TEMPLATE.replace(/\{\{SUBAGENT_NAME\}\}/g, sanitizedName)
    await fs.writeFile(filePath, content, "utf-8")
    if (controller.task) {
        await controller.task.owners.prompt.flush("capability_mutation")
    } else {
        await controller.postStateToWebview()
    }

    // Open the file for editing
    await openFile(controller, { value: filePath })

    // Return current toggles (new subagent defaults to enabled)
    const globalToggles = controller.stateManager.getGlobalSettingsKey("globalSubagentsToggles") || {}
    const localToggles = mergeScopedToggles(readScopedToggles(controller.stateManager, "subagents"))

    return SubagentToggles.create({
        globalSubagentsToggles: globalToggles,
        localSubagentsToggles: localToggles,
    })
}
