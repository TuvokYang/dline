import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import type { SkillToggleState } from "@core/context/instructions/user-instructions/skills"
import {
    discoverSkills,
    filterEnabledSkills,
    getAvailableSkills,
    getSkillContentForMetadata,
} from "@core/context/instructions/user-instructions/skills"
import { getSubagentsScanDirectories, getWorkflowsScanDirectories } from "@core/storage/disk"
import { parseAgentConfigFromYaml } from "@core/task/tools/subagent/AgentConfigLoader"
import { DEFAULT_SUBAGENT_CONFIG, isDefaultSubagentName } from "@core/task/tools/subagent/DefaultSubagentConfig"
import { sanitizeSubagentTools } from "@core/task/tools/subagent/subagent-tool-policy"
import type { McpServer } from "@shared/mcp"
import { nativeMcpToolName } from "@shared/mcp-native-name"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import type { SkillMetadata } from "@shared/skills"
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

export interface CapabilitySourceCollectionInput {
    readonly cwd: string
    readonly remoteSkillEntries?: GlobalInstructionsFile[]
    readonly remoteWorkflowEntries?: readonly GlobalInstructionsFile[]
}

export interface SkillCapabilitySource {
    readonly skill: SkillMetadata
    readonly entry: CapabilityEntry
}

export interface WorkflowCapabilitySource {
    readonly source: "project" | "global" | "remote"
    readonly path: string
    readonly remoteName?: string
    readonly alwaysEnabled?: boolean
    readonly entry: CapabilityEntry
}

export interface SubagentCapabilitySource {
    readonly source: "project" | "global" | "builtin"
    readonly path?: string
    readonly entry: CapabilityEntry
}

export interface CapabilitySourceSnapshot {
    readonly skills: readonly SkillCapabilitySource[]
    readonly workflows: readonly WorkflowCapabilitySource[]
    readonly subagents: readonly SubagentCapabilitySource[]
}

function normalizeDescription(description: string | undefined): string {
    return (description ?? "").replace(/\s+/g, " ").trim().slice(0, 240)
}

function stableEntries(entries: readonly CapabilityEntry[]): CapabilityEntry[] {
    const deduped = new Map<string, CapabilityEntry>()
    for (const entry of entries) {
        const name = entry.name.trim()
        if (!name || deduped.has(name)) continue
        deduped.set(name, {
            name,
            description: normalizeDescription(entry.description),
            ...(entry.contentHash === undefined ? {} : { contentHash: entry.contentHash }),
            ...(entry.nativeToolHash === undefined ? {} : { nativeToolHash: entry.nativeToolHash }),
            ...(entry.server === undefined ? {} : { server: entry.server }),
            ...(entry.tools === undefined ? {} : { tools: entry.tools }),
        })
    }
    return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name))
}

function collectMcp(mcpHub: CapabilityMcpHub | undefined): CapabilityEntry[] {
    if (!mcpHub) return []
    return stableEntries(
        mcpHub
            .getServers()
            .filter((server) => server.status === "connected" && server.disabled !== true)
            .flatMap((server) =>
                (server.tools ?? []).map((tool) => ({
                    name: `${server.name}.${tool.name}`,
                    description: tool.description ?? "",
                    server: server.name,
                    contentHash: hashStableJson(tool.inputSchema ?? { type: "object", properties: {} }),
                    nativeToolHash: hashPromptContent(nativeMcpToolName(server.uid ?? server.name, tool.name)),
                })),
            ),
    )
}

function skillIdentity(skill: SkillMetadata): string {
    return `${skill.path}\u0000${skill.name}`
}

async function collectSkillSources(input: CapabilitySourceCollectionInput): Promise<SkillCapabilitySource[]> {
    const skills = await discoverSkills(input.cwd, input.remoteSkillEntries)
    return Promise.all(
        skills.map(async (skill) => {
            const content = await getSkillContentForMetadata(skill, input.remoteSkillEntries)
            return {
                skill,
                entry: {
                    name: skill.name,
                    description: skill.description,
                    contentHash: hashPromptContent(content?.instructions ?? ""),
                },
            }
        }),
    )
}

function isEnabledPath(
    filePath: string,
    source: "project" | "global",
    localToggles: Record<string, boolean> | undefined,
    globalToggles: Record<string, boolean> | undefined,
): boolean {
    const toggles = source === "global" ? globalToggles : localToggles
    return toggles?.[filePath] !== false
}

async function readWorkflowFiles(directoryPath: string): Promise<string[]> {
    try {
        const directoryEntries = (await fs.readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
            left.name.localeCompare(right.name),
        )
        const nested = await Promise.all(
            directoryEntries.map(async (entry) => {
                const entryPath = path.join(directoryPath, entry.name)
                if (entry.isDirectory()) return readWorkflowFiles(entryPath)
                return /\.(md|mdx)$/i.test(entry.name) ? [entryPath] : []
            }),
        )
        return nested.flat()
    } catch {
        return []
    }
}

async function collectWorkflowSources(input: CapabilitySourceCollectionInput): Promise<WorkflowCapabilitySource[]> {
    const entries: WorkflowCapabilitySource[] = []
    for (const directory of getWorkflowsScanDirectories(input.cwd)) {
        if (!(await fileExistsAtPath(directory.path)) || !(await isDirectory(directory.path))) continue
        for (const filePath of await readWorkflowFiles(directory.path)) {
            try {
                const content = await fs.readFile(filePath, "utf8")
                const { data } = parseYamlFrontmatter(content)
                entries.push({
                    source: directory.source,
                    path: filePath,
                    entry: {
                        name: typeof data.name === "string" ? data.name : path.basename(filePath, path.extname(filePath)),
                        description: typeof data.description === "string" ? data.description : "",
                        contentHash: hashPromptContent(content),
                    },
                })
            } catch {}
        }
    }
    for (const workflow of input.remoteWorkflowEntries ?? []) {
        try {
            const { data } = parseYamlFrontmatter(workflow.contents)
            entries.push({
                source: "remote",
                path: `remote:${workflow.name}`,
                remoteName: workflow.name,
                alwaysEnabled: workflow.alwaysEnabled,
                entry: {
                    name: workflow.name,
                    description: typeof data.description === "string" ? data.description : "",
                    contentHash: hashPromptContent(workflow.contents),
                },
            })
        } catch {}
    }
    return entries
}

async function collectSubagentSources(input: CapabilitySourceCollectionInput): Promise<SubagentCapabilitySource[]> {
    const entries: SubagentCapabilitySource[] = []
    for (const directory of getSubagentsScanDirectories(input.cwd)) {
        if (!(await fileExistsAtPath(directory.path)) || !(await isDirectory(directory.path))) continue
        for (const fileName of (await fs.readdir(directory.path)).sort((left, right) => left.localeCompare(right))) {
            if (!/\.(yaml|yml)$/i.test(fileName)) continue
            const filePath = path.join(directory.path, fileName)
            try {
                const content = await fs.readFile(filePath, "utf8")
                const config = parseAgentConfigFromYaml(content)
                entries.push({
                    source: directory.source,
                    path: filePath,
                    entry: {
                        name: config.name,
                        description: config.description,
                        contentHash: hashPromptContent(content),
                        tools: sanitizeSubagentTools(config.tools, {
                            builtInDefault: isDefaultSubagentName(config.name),
                            explicitlyNarrowed: config.toolsExplicitlyNarrowed === true,
                        }),
                    },
                })
            } catch {}
        }
    }
    entries.push({
        source: "builtin",
        entry: {
            name: DEFAULT_SUBAGENT_CONFIG.name,
            description: DEFAULT_SUBAGENT_CONFIG.description,
            tools: sanitizeSubagentTools(DEFAULT_SUBAGENT_CONFIG.tools, { builtInDefault: true }),
        },
    })
    return entries
}

export async function collectCapabilitySources(input: CapabilitySourceCollectionInput): Promise<CapabilitySourceSnapshot> {
    const [skills, workflows, subagents] = await Promise.all([
        collectSkillSources(input),
        collectWorkflowSources(input),
        collectSubagentSources(input),
    ])
    return { skills, workflows, subagents }
}

export function projectAvailableSkills(sources: CapabilitySourceSnapshot, input: SkillToggleState): SkillMetadata[] {
    return filterEnabledSkills(getAvailableSkills(sources.skills.map((source) => source.skill)), input)
}

export function projectCapabilities(sources: CapabilitySourceSnapshot, input: CollectCapabilitiesInput): CapabilitiesSnapshot {
    const enabledSkills = new Set(projectAvailableSkills(sources, input).map(skillIdentity))
    const workflows = sources.workflows.filter((source) => {
        if (source.source === "remote") {
            return (
                source.alwaysEnabled === true || input.remoteWorkflowToggles?.[source.remoteName ?? source.entry.name] !== false
            )
        }
        return isEnabledPath(source.path, source.source, input.workflowToggles, input.globalWorkflowToggles)
    })
    const subagents = sources.subagents.filter(
        (source) =>
            source.source === "builtin" ||
            (source.path !== undefined &&
                isEnabledPath(source.path, source.source, input.subagentToggles, input.globalSubagentToggles)),
    )
    return {
        mcp: collectMcp(input.mcpHub),
        skills: stableEntries(
            sources.skills.filter((source) => enabledSkills.has(skillIdentity(source.skill))).map((source) => source.entry),
        ),
        workflows: stableEntries(workflows.map((source) => source.entry)),
        subagents: stableEntries(subagents.map((source) => source.entry)),
    }
}

export async function collectCapabilities(input: CollectCapabilitiesInput): Promise<CapabilitiesSnapshot> {
    const sources = await collectCapabilitySources({
        cwd: input.cwd,
        remoteSkillEntries: input.remoteSkillEntries,
        remoteWorkflowEntries: input.remoteWorkflowEntries,
    })
    return projectCapabilities(sources, input)
}
