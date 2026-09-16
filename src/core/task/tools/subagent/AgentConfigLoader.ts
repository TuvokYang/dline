import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { Logger } from "@shared/services/Logger"
import { ClineDefaultTool } from "@shared/tools"
import chokidar, { type FSWatcher } from "chokidar"
import fs from "fs/promises"
import * as path from "path"
import { z } from "zod"
import { getDlineSubagentsDirectoryPath, getSubagentsScanDirectories } from "@/core/storage/disk"
import { DEFAULT_SUBAGENT_FILE_NAME, DEFAULT_SUBAGENT_YAML_CONTENT } from "./DefaultSubagentConfig"
import { rejectForbiddenSubagentTools } from "./subagent-tool-policy"

export const AGENTS_CONFIG_DIRECTORY_NAME = "subagents"

const SubagentOutputTokensSchema = z
	.number()
	.finite()
	.refine(
		(value) => value > 0 && (value < 1 || Number.isInteger(value)),
		"maxOutputTokens must be a positive ratio below 1 or a positive integer token count.",
	)

const AgentBaseConfigSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	tools: z.array(z.nativeEnum(ClineDefaultTool)).default([]),
	// Set when the author wrote a tool list and policy rejected all of it.
	// Without this, the resulting empty list is indistinguishable from "no
	// tools field", and a request to narrow would be read as a request to
	// inherit — granting more than was asked for.
	toolsExplicitlyNarrowed: z.boolean().optional(),
	skills: z.array(z.string().trim().min(1)).optional(),
	profile: z.string().trim().min(1).nullable().optional(),
	maxOutputTokens: SubagentOutputTokensSchema.optional(),
	systemPrompt: z.string().trim().min(1),
})

const AgentConfigFrontmatterSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	profile: z.string().trim().min(1).nullable().optional(),
	maxOutputTokens: z
		.preprocess(
			(value) => (typeof value === "string" && value.trim() ? Number(value.trim()) : value),
			SubagentOutputTokensSchema,
		)
		.optional(),
	tools: z.union([z.string(), z.array(z.string())]).optional(),
	skills: z.union([z.string(), z.array(z.string())]).optional(),
})

export type AgentBaseConfig = z.infer<typeof AgentBaseConfigSchema>

export interface ResolvedAgentConfig {
	config: AgentBaseConfig
	source: "project" | "global"
	path: string
}

export interface ResolveAgentConfigOptions {
	subagentToggles?: Record<string, boolean>
	globalSubagentToggles?: Record<string, boolean>
}

function normalizeToolName(toolName: string): ClineDefaultTool {
	const trimmed = toolName.trim()
	if (!trimmed) {
		throw new Error("Tool name cannot be empty.")
	}
	if (trimmed === "use_skill") {
		return ClineDefaultTool.LOAD_SKILL
	}
	const asDefaultTool = trimmed as ClineDefaultTool
	if (Object.values(ClineDefaultTool).includes(asDefaultTool)) {
		return asDefaultTool
	}
	throw new Error(`Unknown tool '${trimmed}'. Expected a ClineDefaultTool value.`)
}

/**
 * Parse the configured tool list, dropping tools policy forbids.
 *
 * Hand-edited YAML predating the policy may still name a turn-ending tool.
 * Dropping it here keeps the config loadable rather than failing the whole
 * subagent, and keeps what is reported to callers equal to what the runner
 * will actually grant. An empty result still means "inherit the default
 * allowlist", so the required tool is granted when that list is resolved.
 */
function parseTools(tools: string | string[] | undefined): {
	tools: ClineDefaultTool[]
	explicitlyNarrowed: boolean
} {
	if (!tools) return { tools: [], explicitlyNarrowed: false }
	const rawTools = Array.isArray(tools) ? tools : tools.split(",")
	if (rawTools.length === 0) return { tools: [], explicitlyNarrowed: false }

	const requested = Array.from(new Set(rawTools.map(normalizeToolName)))
	const permitted = rejectForbiddenSubagentTools(requested)
	// Every entry was rejected, so the author's intent is known to be narrow
	// even though nothing survived to express it.
	return { tools: permitted, explicitlyNarrowed: permitted.length === 0 }
}

function normalizeSkillName(skillName: string): string {
	const trimmed = skillName.trim()
	if (!trimmed) throw new Error("Skill name cannot be empty.")
	return trimmed
}

function parseSkills(skills: string | string[] | undefined): string[] | undefined {
	if (skills === undefined) return undefined
	const rawSkills = Array.isArray(skills) ? skills : skills.split(",")
	return Array.from(new Set(rawSkills.map(normalizeSkillName)))
}

export function parseAgentConfigFromYaml(content: string): AgentBaseConfig {
	const { data, body, hadFrontmatter, parseError } = parseYamlFrontmatter(content)
	if (parseError) throw new Error(`Failed to parse YAML frontmatter: ${parseError}`)
	if (!hadFrontmatter) throw new Error("Missing YAML frontmatter block in agent config file.")
	const parsedFrontmatter = AgentConfigFrontmatterSchema.parse(data)
	const systemPrompt = body.trim()
	if (!systemPrompt) throw new Error("Missing system prompt body in agent config file.")
	const parsedTools = parseTools(parsedFrontmatter.tools)
	return AgentBaseConfigSchema.parse({
		name: parsedFrontmatter.name,
		description: parsedFrontmatter.description,
		profile: parsedFrontmatter.profile,
		maxOutputTokens: parsedFrontmatter.maxOutputTokens,
		tools: parsedTools.tools,
		...(parsedTools.explicitlyNarrowed ? { toolsExplicitlyNarrowed: true } : {}),
		skills: parseSkills(parsedFrontmatter.skills),
		systemPrompt,
	}) as AgentBaseConfig
}

function normalizeAgentName(name: string): string {
	return name.trim().toLowerCase()
}
function isYamlFile(filePath: string): boolean {
	return /\.(yaml|yml)$/i.test(filePath)
}

/**
 * Create the editable default subagent config when a global directory has no YAML files.
 * Concurrent extension instances use exclusive creation so existing user content is never overwritten.
 *
 * @param dirPath Global subagent config directory.
 * @returns Created file path, or undefined when YAML already exists.
 */
export async function ensureDefaultSubagentConfigExists(dirPath: string): Promise<string | undefined> {
	await fs.mkdir(dirPath, { recursive: true })
	const entries = await fs.readdir(dirPath, { withFileTypes: true })
	if (entries.some((entry) => entry.isFile() && isYamlFile(entry.name))) {
		return undefined
	}

	const defaultPath = path.join(dirPath, DEFAULT_SUBAGENT_FILE_NAME)
	try {
		await fs.writeFile(defaultPath, DEFAULT_SUBAGENT_YAML_CONTENT, { encoding: "utf8", flag: "wx" })
		Logger.log(`[AgentConfigLoader] Created default subagent config at ${defaultPath}`)
		return defaultPath
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return undefined
		}
		throw error
	}
}

/**
 * Check whether a subagent file path is enabled by configured toggles.
 * @param filePath Absolute config file path.
 * @param source Subagent source scope.
 * @param options Optional local and global toggle maps.
 * @returns True when the subagent is not explicitly disabled.
 */
function isEnabledPath(filePath: string, source: "project" | "global", options?: ResolveAgentConfigOptions): boolean {
	const toggles = source === "global" ? options?.globalSubagentToggles : options?.subagentToggles
	return toggles?.[filePath] !== false
}

export async function readAgentConfigsFromDisk(dirPath: string): Promise<Map<string, AgentBaseConfig>> {
	const configs = new Map<string, AgentBaseConfig>()
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true })
		const yamlFiles = entries
			.filter((e) => e.isFile())
			.map((e) => e.name)
			.filter(isYamlFile)
			.sort((a, b) => a.localeCompare(b))
		Logger.debug(`[AgentConfigLoader] Found ${yamlFiles.length} YAML file(s).`)
		await Promise.all(
			yamlFiles.map(async (fileName) => {
				const fp = path.join(dirPath, fileName)
				try {
					const content = await fs.readFile(fp, "utf8")
					const parsed = parseAgentConfigFromYaml(content)
					configs.set(normalizeAgentName(parsed.name), parsed)
				} catch (error) {
					Logger.error(`[AgentConfigLoader] Failed to parse agent config '${fileName}'`, error)
				}
			}),
		)
		return configs
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return configs
		Logger.error("[AgentConfigLoader] Failed to read agent configs from disk", error)
		throw error
	}
}

/**
 * Resolve a subagent config from project and global scan directories.
 *
 * @param cwd Workspace root used for project subagent lookup.
 * @param subagentName Name requested by use_subagent.
 * @returns Matching agent config with source, or undefined.
 */
export async function listEnabledAgentConfigs(cwd: string, options?: ResolveAgentConfigOptions): Promise<ResolvedAgentConfig[]> {
	const resolved: ResolvedAgentConfig[] = []
	const seen = new Set<string>()
	for (const directory of getSubagentsScanDirectories(cwd)) {
		const configs = await readAgentConfigsFromDisk(directory.path)
		for (const config of configs.values()) {
			const normalized = normalizeAgentName(config.name)
			if (seen.has(normalized)) continue
			const filePath = await findAgentConfigPath(directory.path, config.name)
			if (!filePath || !isEnabledPath(filePath, directory.source, options)) continue
			seen.add(normalized)
			resolved.push({ config, source: directory.source, path: filePath })
		}
	}
	return resolved
}

export async function resolveAgentConfig(
	cwd: string,
	subagentName?: string,
	options?: ResolveAgentConfigOptions,
): Promise<ResolvedAgentConfig | undefined> {
	if (!subagentName?.trim()) return undefined
	const normalized = normalizeAgentName(subagentName)
	for (const directory of getSubagentsScanDirectories(cwd)) {
		const configs = await readAgentConfigsFromDisk(directory.path)
		const config = configs.get(normalized)
		if (!config) continue
		const filePath = await findAgentConfigPath(directory.path, config.name)
		if (!filePath || !isEnabledPath(filePath, directory.source, options)) return undefined
		return { config, source: directory.source, path: filePath }
	}
	return undefined
}

/**
 * Find the YAML file path for a parsed subagent config.
 * @param dirPath Directory that contains subagent YAML files.
 * @param subagentName Parsed subagent name.
 * @returns Matching file path, or undefined.
 */
async function findAgentConfigPath(dirPath: string, subagentName: string): Promise<string | undefined> {
	const normalized = normalizeAgentName(subagentName)
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isFile() || !isYamlFile(entry.name)) continue
			const filePath = path.join(dirPath, entry.name)
			try {
				const parsed = parseAgentConfigFromYaml(await fs.readFile(filePath, "utf8"))
				if (normalizeAgentName(parsed.name) === normalized) return filePath
			} catch {}
		}
	} catch {
		return undefined
	}
	return undefined
}

export type AgentConfigChangeListener = (configs: ReadonlyMap<string, AgentBaseConfig>, error?: Error) => void

export class AgentConfigLoader {
	private static instances = new Map<string, AgentConfigLoader>()
	private readonly directoryPath: string
	private readonly initialLoadPromise: Promise<void>
	private watcher?: FSWatcher
	private disposed = false
	private cachedConfigs = new Map<string, AgentBaseConfig>()
	private listeners = new Set<AgentConfigChangeListener>()

	private constructor(
		dirPath: string,
		private readonly ensureDefaultConfig: boolean,
	) {
		this.directoryPath = dirPath
		this.initialLoadPromise = this.load()
			.then(() => undefined)
			.catch((e) => Logger.error("[AgentConfigLoader] Failed to load initial agent configs", e))
			.finally(() => {
				if (this.disposed) return
				return this.watch().catch((e) => Logger.error("[AgentConfigLoader] Failed to start watching agent configs", e))
			})
	}

	public static getInstance(dirPath?: string): AgentConfigLoader {
		const resolvedPath = dirPath || getDlineSubagentsDirectoryPath()
		const existing = AgentConfigLoader.instances.get(resolvedPath)
		if (existing) return existing
		const loader = new AgentConfigLoader(resolvedPath, dirPath === undefined)
		AgentConfigLoader.instances.set(resolvedPath, loader)
		return loader
	}

	public static async resetInstanceForTests(): Promise<void> {
		await Promise.all(Array.from(AgentConfigLoader.instances.values()).map((loader) => loader.dispose()))
		AgentConfigLoader.instances.clear()
	}

	public getConfigPath(): string {
		return this.directoryPath
	}
	public async ready(): Promise<void> {
		await this.initialLoadPromise
	}

	public getCachedConfig(subagentName?: string): AgentBaseConfig | undefined {
		if (!subagentName?.trim()) return undefined
		return this.cachedConfigs.get(normalizeAgentName(subagentName))
	}

	public getAllCachedConfigs(): ReadonlyMap<string, AgentBaseConfig> {
		return new Map(this.cachedConfigs)
	}

	public getAllCachedConfigsWithToolNames(): Array<{ toolName: string; config: AgentBaseConfig }> {
		return []
	}

	public resolveSubagentNameForTool(_toolName?: string): string | undefined {
		return undefined
	}

	public isDynamicSubagentTool(_toolName?: string): boolean {
		return false
	}

	public async load(): Promise<ReadonlyMap<string, AgentBaseConfig>> {
		if (this.ensureDefaultConfig) {
			await this.ensureReadmeExists()
			await ensureDefaultSubagentConfigExists(this.directoryPath)
		}
		const configs = await readAgentConfigsFromDisk(this.directoryPath)
		this.cachedConfigs = configs
		Logger.debug(`[AgentConfigLoader] Loaded ${configs.size} agent config(s) from disk.`)
		if (!this.ensureDefaultConfig) {
			await this.ensureReadmeExists()
		}
		return this.getAllCachedConfigs()
	}

	private async ensureReadmeExists(): Promise<void> {
		try {
			const readmePath = path.join(this.directoryPath, "README.md")
			if (
				await fs.stat(readmePath).then(
					() => true,
					() => false,
				)
			)
				return
			try {
				const entries = await fs.readdir(this.directoryPath)
				if (entries.some((e) => e.endsWith(".yml") || e.endsWith(".yaml"))) return
			} catch {
				/* directory doesn't exist yet */
			}
			await fs.mkdir(this.directoryPath, { recursive: true })
			await fs.writeFile(readmePath, SUBAGENT_README_CONTENT, "utf8")
			Logger.log("[AgentConfigLoader] Created README.md in agents directory")
		} catch (e) {
			Logger.warn("[AgentConfigLoader] Failed to write README.md:", e)
		}
	}

	public async watch(listener?: AgentConfigChangeListener): Promise<void> {
		if (this.disposed) return
		if (listener) this.listeners.add(listener)
		if (this.watcher) return
		this.watcher = chokidar.watch(this.directoryPath, {
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
		})
		this.watcher
			.on("add", (fp) => {
				if (isYamlFile(fp)) void this.reloadAndNotify()
			})
			.on("change", (fp) => {
				if (isYamlFile(fp)) void this.reloadAndNotify()
			})
			.on("unlink", (fp) => {
				if (isYamlFile(fp)) void this.reloadAndNotify()
			})
			.on("error", (error) => {
				const e = error instanceof Error ? error : new Error(String(error))
				Logger.error("[AgentConfigLoader] Failed to watch agent configs directory", e)
				this.notify(this.cachedConfigs, e)
			})
	}

	public unwatch(listener: AgentConfigChangeListener): void {
		this.listeners.delete(listener)
	}

	public async dispose(): Promise<void> {
		this.disposed = true
		await this.initialLoadPromise
		const watcher = this.watcher
		this.watcher = undefined
		this.listeners.clear()
		if (watcher) {
			await watcher.close()
		}
	}

	private async reloadAndNotify(): Promise<void> {
		try {
			await this.load()
			this.notify(this.cachedConfigs)
		} catch (error) {
			const e = error instanceof Error ? error : new Error(String(error))
			Logger.error("[AgentConfigLoader] Failed to reload agent configs", e)
			this.notify(this.cachedConfigs, e)
		}
	}

	private notify(configs: ReadonlyMap<string, AgentBaseConfig>, error?: Error): void {
		for (const listener of this.listeners) listener(new Map(configs), error)
	}
}

const SUBAGENT_README_CONTENT = `# Dline Subagents

Place \`.yml\` files here to define custom subagents. Each file = one subagent.

## YAML Format
\`\`\`yaml
---
name: my-agent
description: What this agent does
profile: (optional) ApiProfile name override
tools:           # optional — defaults to readonly set below
  - read_file
  - search_files
skills: (optional)
---
System prompt body for the subagent.
\`\`\`

## Available Tools

Read-only:
  read_file, search_files, list_files, list_code_definition_names
  browser_action, ask_followup_question, web_fetch, web_search
  load_skill, load_mcp, load_workflow, load_mcp_documentation
  access_mcp_resource, use_mcp_tool, make_plan, generate_explanation, focus_chain

Write (⚠️ use with caution — subagent can modify files):
  write_to_file, replace_in_file, execute_command
  attempt_completion, apply_patch

## Default Subagent (when no YAML is configured)
Subagents use these defaults if no YAML overrides are present:
  Tools: read_file, search_files, list_files, list_code_definition_names,
         execute_command (readonly commands only), load_skill, attempt_completion
  Profile: default act profile
  System prompt: research subagent — explore codebase, read files,
                 run readonly commands, report findings. No file modifications.
`
