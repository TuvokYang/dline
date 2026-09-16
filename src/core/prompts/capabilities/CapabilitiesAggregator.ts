import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import type { SkillToggleState } from "@core/context/instructions/user-instructions/skills"
import { discoverAvailableSkills, getSkillContent } from "@core/context/instructions/user-instructions/skills"
import { getSubagentsScanDirectories, getWorkflowsScanDirectories } from "@core/storage/disk"
import { parseAgentConfigFromYaml } from "@core/task/tools/subagent/AgentConfigLoader"
import { DEFAULT_SUBAGENT_CONFIG, isDefaultSubagentName } from "@core/task/tools/subagent/DefaultSubagentConfig"
import { sanitizeSubagentTools } from "@core/task/tools/subagent/subagent-tool-policy"
import { CLINE_MCP_TOOL_IDENTIFIER, type McpServer } from "@shared/mcp"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { hashStableJson } from "@shared/stable-json"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import fs from "fs/promises"
import path from "path"
import { hashPromptContent } from "../system-prompt-cache/hash"
import type { CapabilitiesSnapshot, CapabilityEntry } from "./types"

export interface CapabilityToggleState extends SkillToggleState {
	readonly workflowToggles?: Record<string, boolean>
	readonly globalWorkflowToggles?: Record<string, boolean>
	readonly remoteWorkflowEntries?: readonly GlobalInstructionsFile[]
	readonly remoteWorkflowToggles?: Record<string, boolean>
	readonly subagentToggles?: Record<string, boolean>
	readonly globalSubagentToggles?: Record<string, boolean>
}

export interface CapabilityMcpHub {
	getServers(): McpServer[]
}

export interface CollectCapabilitiesInput extends CapabilityToggleState {
	readonly cwd: string
	readonly mcpHub?: CapabilityMcpHub
}

/**
 * Normalize a capability description for stable prompt rendering.
 *
 * @param description Raw capability description.
 * @returns Single-line prompt-safe description.
 */
function normalizeDescription(description: string | undefined): string {
	return (description ?? "").replace(/\s+/g, " ").trim().slice(0, 240)
}

/**
 * Sort and de-duplicate capability entries by name.
 *
 * @param entries Raw capability entries.
 * @returns Stable capability entries.
 */
function stableEntries(entries: CapabilityEntry[]): CapabilityEntry[] {
	const deduped = new Map<string, CapabilityEntry>()
	for (const entry of entries) {
		const name = entry.name.trim()
		if (!name || deduped.has(name)) {
			continue
		}
		deduped.set(name, {
			name,
			description: normalizeDescription(entry.description),
			...(entry.contentHash === undefined ? {} : { contentHash: entry.contentHash }),
			...(entry.nativeToolHash === undefined ? {} : { nativeToolHash: entry.nativeToolHash }),
			// Rebuilding the entry field by field silently drops anything not
			// listed here, which is how the advertised allowlist went missing
			// while the renderer and the collector were both correct.
			...(entry.tools === undefined ? {} : { tools: entry.tools }),
		})
	}
	return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Convert MCP tools into prompt-safe capability entries.
 *
 * @param mcpHub MCP hub that exposes connected servers.
 * @returns MCP capability entries containing only name and description.
 */
function collectMcp(mcpHub: CapabilityMcpHub | undefined): CapabilityEntry[] {
	if (!mcpHub) {
		return []
	}
	return stableEntries(
		mcpHub
			.getServers()
			.filter((server) => server.status === "connected" && server.disabled !== true)
			.flatMap((server) =>
				(server.tools ?? []).map((tool) => ({
					name: `${server.name}.${tool.name}`,
					description: tool.description ?? "",
					contentHash: hashStableJson(tool.inputSchema ?? { type: "object", properties: {} }),
					nativeToolHash: hashPromptContent(`${server.uid ?? server.name}${CLINE_MCP_TOOL_IDENTIFIER}${tool.name}`),
				})),
			),
	)
}

/**
 * Convert enabled skills into prompt-safe capability entries.
 *
 * @param input Capability collection input.
 * @returns Skill capability entries containing only name and description.
 */
async function collectSkills(input: CollectCapabilitiesInput): Promise<CapabilityEntry[]> {
	const skills = await discoverAvailableSkills(input.cwd, input)
	const entries = await Promise.all(
		skills.map(async (skill) => {
			const content = await getSkillContent(skill.name, skills, input.remoteSkillEntries)
			return {
				name: skill.name,
				description: skill.description,
				contentHash: hashPromptContent(content?.instructions ?? ""),
			}
		}),
	)
	return stableEntries(entries)
}

/**
 * Check whether a capability path is enabled by local or global toggles.
 *
 * @param filePath Capability file path.
 * @param source Capability source scope.
 * @param localToggles Local toggle map keyed by path.
 * @param globalToggles Global toggle map keyed by path.
 * @returns True when the capability is not explicitly disabled.
 */
function isEnabledPath(
	filePath: string,
	source: "project" | "global",
	localToggles: Record<string, boolean> | undefined,
	globalToggles: Record<string, boolean> | undefined,
): boolean {
	const toggles = source === "global" ? globalToggles : localToggles
	return toggles?.[filePath] !== false
}

/**
 * Read workflow files recursively with stable ordering.
 *
 * @param directoryPath Directory to scan.
 * @returns Markdown workflow file paths.
 */
async function readWorkflowFiles(directoryPath: string): Promise<string[]> {
	try {
		const dirEntries = (await fs.readdir(directoryPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
		const nested = await Promise.all(
			dirEntries.map(async (entry) => {
				const entryPath = path.join(directoryPath, entry.name)
				if (entry.isDirectory()) {
					return readWorkflowFiles(entryPath)
				}
				return /\.(md|mdx)$/i.test(entry.name) ? [entryPath] : []
			}),
		)
		return nested.flat()
	} catch {
		return []
	}
}

/**
 * Collect workflow files from configured scan directories.
 *
 * @param input Capability collection input.
 * @returns Workflow capability entries containing only name and description.
 */
async function collectWorkflows(input: CollectCapabilitiesInput): Promise<CapabilityEntry[]> {
	const entries: CapabilityEntry[] = []
	for (const dir of getWorkflowsScanDirectories(input.cwd)) {
		if (!(await fileExistsAtPath(dir.path)) || !(await isDirectory(dir.path))) {
			continue
		}
		const files = await readWorkflowFiles(dir.path)
		for (const filePath of files) {
			if (!isEnabledPath(filePath, dir.source, input.workflowToggles, input.globalWorkflowToggles)) {
				continue
			}
			try {
				const content = await fs.readFile(filePath, "utf8")
				const { data } = parseYamlFrontmatter(content)
				const name = typeof data.name === "string" ? data.name : path.basename(filePath, path.extname(filePath))
				const description = typeof data.description === "string" ? data.description : ""
				entries.push({ name, description, contentHash: hashPromptContent(content) })
			} catch {}
		}
	}
	for (const workflow of input.remoteWorkflowEntries ?? []) {
		if (!workflow.alwaysEnabled && input.remoteWorkflowToggles?.[workflow.name] === false) continue
		try {
			const { data } = parseYamlFrontmatter(workflow.contents)
			const description = typeof data.description === "string" ? data.description : ""
			entries.push({ name: workflow.name, description, contentHash: hashPromptContent(workflow.contents) })
		} catch {}
	}
	return stableEntries(entries)
}

/**
 * Collect subagent YAML configs from configured scan directories.
 *
 * @param input Capability collection input.
 * @returns Subagent capability entries containing only name and description.
 */
async function collectSubagents(input: CollectCapabilitiesInput): Promise<CapabilityEntry[]> {
	const entries: CapabilityEntry[] = []
	for (const dir of getSubagentsScanDirectories(input.cwd)) {
		if (!(await fileExistsAtPath(dir.path)) || !(await isDirectory(dir.path))) {
			continue
		}
		const files = (await fs.readdir(dir.path)).sort((a, b) => a.localeCompare(b))
		for (const fileName of files) {
			if (!/\.(yaml|yml)$/i.test(fileName)) {
				continue
			}
			const filePath = path.join(dir.path, fileName)
			if (!isEnabledPath(filePath, dir.source, input.subagentToggles, input.globalSubagentToggles)) {
				continue
			}
			try {
				const content = await fs.readFile(filePath, "utf8")
				const config = parseAgentConfigFromYaml(content)
				entries.push({
					name: config.name,
					description: config.description,
					contentHash: hashPromptContent(content),
					// Advertise the allowlist that will actually be enforced, produced by
					// the same policy the builder applies, so the caller cannot be told a
					// capability it will not get.
					tools: sanitizeSubagentTools(config.tools, {
						builtInDefault: isDefaultSubagentName(config.name),
						explicitlyNarrowed: config.toolsExplicitlyNarrowed === true,
					}),
				})
			} catch {}
		}
	}
	entries.push({
		name: DEFAULT_SUBAGENT_CONFIG.name,
		description: DEFAULT_SUBAGENT_CONFIG.description,
		tools: sanitizeSubagentTools(DEFAULT_SUBAGENT_CONFIG.tools, { builtInDefault: true }),
	})
	return stableEntries(entries)
}

/**
 * Collect prompt-safe capabilities from MCP, skills, workflows, and subagents.
 *
 * @param input Capability collection input.
 * @returns Snapshot containing only capability names and descriptions.
 */
export async function collectCapabilities(input: CollectCapabilitiesInput): Promise<CapabilitiesSnapshot> {
	const [skills, workflows, subagents] = await Promise.all([
		collectSkills(input),
		collectWorkflows(input),
		collectSubagents(input),
	])
	return {
		mcp: collectMcp(input.mcpHub),
		skills,
		workflows,
		subagents,
	}
}
