import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { type CapabilityKind, mergeScopedToggles, readScopedToggles } from "@core/storage/settings/capability-toggle-store"
import { EmptyRequest } from "@shared/proto/dline/common"
import { SlashCommandInfo, SlashCommandsResponse } from "@shared/proto/dline/slash"
import { parseTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import fs from "fs/promises"
import { extractNameFromMdFile, getBuiltInSlashCommands } from "@/shared/slashCommands"
import { Controller } from ".."
import { readDiscoveredToggles } from "../file/capability-discovery-cache"

const MAX_DESCRIPTION_LENGTH = 80

/**
 * Read the stored overrides of one locally discovered capability kind.
 *
 * The scope chain owns these preferences; merging the scopes keeps a task-level
 * choice visible while an untouched resource keeps its discovered default.
 */
function localCapabilityToggles(controller: Controller, kind: CapabilityKind): Record<string, boolean> {
	const overrides = mergeScopedToggles(readScopedToggles(controller.stateManager, kind))
	const discovered = readDiscoveredToggles(controller, kind)

	// Before the first trustworthy scan, preserve the legacy path-keyed map so
	// existing commands remain available. Once discovery exists, it is the
	// resource authority and sparse scope overrides only choose enabled state.
	if (Object.keys(discovered).length === 0) {
		return overrides
	}

	return Object.fromEntries(
		Object.entries(discovered).map(([resourcePath, enabled]) => {
			const resourceId = capabilityResourceId(resourcePath)
			return [resourcePath, overrides[resourceId] ?? overrides[resourcePath] ?? enabled]
		}),
	)
}

/** Truncate a description string if it exceeds the max length */
function truncateDescription(desc: string): string {
	return desc.length > MAX_DESCRIPTION_LENGTH ? `${desc.slice(0, MAX_DESCRIPTION_LENGTH)}…` : desc
}

/** Extract and truncate description from a workflow file's YAML frontmatter */
async function extractWorkflowDescription(filePath: string): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(filePath, "utf-8")
		const { data, body } = parseYamlFrontmatter(raw)
		if (data.description && typeof data.description === "string") {
			return truncateDescription(data.description)
		}
		// Fallback to first meaningful line of markdown body
		const firstLine = body.trim().split("\n")[0].trim()
		const cleanLine = firstLine.replace(/^#+\s*/, "").trim()
		if (cleanLine) {
			return truncateDescription(cleanLine)
		}
	} catch {
		// File read failed — fall through
	}
	return undefined
}

/**
 * Returns all available slash commands for autocomplete.
 * Includes built-in commands (cmd: prefix), workflows (workflow: prefix),
 * skills (skills: prefix), and MCP prompts (mcp: prefix via frontend).
 */
export async function getAvailableSlashCommands(controller: Controller, _request: EmptyRequest): Promise<SlashCommandsResponse> {
	const commands: SlashCommandInfo[] = []

	// Return the full catalog; CLI consumers filter VS Code-only entries via cliCompatible.
	for (const cmd of getBuiltInSlashCommands("vscode")) {
		commands.push(
			SlashCommandInfo.create({
				name: cmd.name,
				description: cmd.description,
				section: "default",
				cliCompatible: cmd.cliCompatible,
			}),
		)
	}

	// Get workflow toggles from state
	const taskToggles = parseTaskCapabilityToggles(controller.task?.taskSm.taskCapabilityToggles)
	const localWorkflowToggles = taskToggles?.localWorkflowToggles ?? localCapabilityToggles(controller, "workflows")
	const globalWorkflowToggles =
		taskToggles?.globalWorkflowToggles ?? controller.stateManager.getGlobalSettingsKey("globalWorkflowToggles") ?? {}
	const remoteWorkflowToggles =
		taskToggles?.remoteWorkflowToggles ?? controller.stateManager.getGlobalStateKey("remoteWorkflowToggles") ?? {}
	const remoteConfigSettings = controller.stateManager.getRemoteConfigSettings()
	const remoteWorkflows = remoteConfigSettings?.remoteGlobalWorkflows ?? []

	// Track workflow names so local/project entries take precedence over global and remote entries.
	const workflowNames = new Set<string>()

	// Add local workflows (enabled only, section="workflow", name="xxx")
	for (const [filePath, enabled] of Object.entries(localWorkflowToggles)) {
		if (enabled) {
			const baseName = await extractNameFromMdFile(filePath, (p) => fs.readFile(p, "utf-8"), parseYamlFrontmatter)
			workflowNames.add(baseName)
			const description = await extractWorkflowDescription(filePath)
			commands.push(
				SlashCommandInfo.create({
					name: baseName,
					description: description || "",
					section: "workflow",
					cliCompatible: true,
				}),
			)
		}
	}

	// Add global workflows (enabled only, skip if local exists with same name)
	for (const [filePath, enabled] of Object.entries(globalWorkflowToggles)) {
		if (enabled) {
			const baseName = await extractNameFromMdFile(filePath, (p) => fs.readFile(p, "utf-8"), parseYamlFrontmatter)
			if (!workflowNames.has(baseName)) {
				workflowNames.add(baseName)
				const description = await extractWorkflowDescription(filePath)
				commands.push(
					SlashCommandInfo.create({
						name: baseName,
						description: description || "",
						section: "workflow",
						cliCompatible: true,
					}),
				)
			}
		}
	}

	// Add remote workflows that are enabled
	for (const workflow of remoteWorkflows) {
		const enabled = workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false
		if (enabled && !workflowNames.has(workflow.name)) {
			workflowNames.add(workflow.name)
			let description = ""
			if (workflow.contents) {
				const { data } = parseYamlFrontmatter(workflow.contents)
				if (data.description && typeof data.description === "string") {
					description = truncateDescription(data.description)
				}
			}
			commands.push(
				SlashCommandInfo.create({
					name: workflow.name,
					description,
					section: "custom",
					cliCompatible: true,
				}),
			)
		}
	}

	// Add skills (section="skill", name="xxx")
	const localSkillsToggles = taskToggles?.localSkillsToggles ?? localCapabilityToggles(controller, "skills")
	const globalSkillsToggles =
		taskToggles?.globalSkillsToggles ?? controller.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
	const remoteSkillsToggles =
		taskToggles?.remoteSkillsToggles ?? controller.stateManager.getGlobalStateKey("remoteSkillsToggles") ?? {}
	const remoteGlobalSkills = remoteConfigSettings?.remoteGlobalSkills ?? []

	const skillNames = new Set<string>()

	// Add local skills (enabled only)
	for (const [path, enabled] of Object.entries(localSkillsToggles)) {
		if (enabled) {
			const skillName = await extractNameFromMdFile(path, (p) => fs.readFile(p, "utf-8"), parseYamlFrontmatter)
			if (!skillName) continue
			skillNames.add(skillName)
			commands.push(
				SlashCommandInfo.create({
					name: skillName,
					description: `Skill: ${skillName}`,
					section: "skill",
					cliCompatible: true,
				}),
			)
		}
	}

	// Add global skills (enabled only, skip if local exists with same name)
	for (const [path, enabled] of Object.entries(globalSkillsToggles)) {
		if (enabled) {
			const skillName = await extractNameFromMdFile(path, (p) => fs.readFile(p, "utf-8"), parseYamlFrontmatter)
			if (!skillName || skillNames.has(skillName)) continue
			skillNames.add(skillName)
			commands.push(
				SlashCommandInfo.create({
					name: skillName,
					description: `Skill: ${skillName}`,
					section: "skill",
					cliCompatible: true,
				}),
			)
		}
	}

	// Add remote skills that are enabled, skipping names already provided by local or global skills.
	for (const skill of remoteGlobalSkills) {
		const enabled = skill.alwaysEnabled || remoteSkillsToggles[skill.name] !== false
		if (enabled && !skillNames.has(skill.name)) {
			skillNames.add(skill.name)
			commands.push(
				SlashCommandInfo.create({
					name: skill.name,
					description: `Remote skill: ${skill.name}`,
					section: "skill",
					cliCompatible: true,
				}),
			)
		}
	}

	return SlashCommandsResponse.create({ commands })
}
