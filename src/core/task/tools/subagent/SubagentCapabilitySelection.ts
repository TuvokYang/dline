import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import {
    extractPathLikeStrings,
    toWorkspaceRelativePosixPath,
} from "@core/context/instructions/user-instructions/rule-conditionals"
import {
    getRemoteRulesTotalContentWithMetadata,
    getRuleFilesTotalContentWithMetadata,
} from "@core/context/instructions/user-instructions/rule-helpers"
import { discoverSkills, getAvailableSkills, parseRemoteSkillEntries } from "@core/context/instructions/user-instructions/skills"
import { projectCapabilities } from "@core/prompts/capabilities/CapabilitiesAggregator"
import type { CapabilitiesSnapshot } from "@core/prompts/capabilities/types"
import { PromptProfile, requirePromptProfile } from "@core/prompts/profiles/types"
import { formatResponse } from "@core/prompts/responses"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { hashPromptContent } from "@core/prompts/system-prompt-cache/hash"
import { GlobalFileNames, getDlineDocumentsPathSync, getWorkflowsScanDirectories } from "@core/storage/disk"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { McpResource, McpServer, McpTool } from "@shared/mcp"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { Logger } from "@shared/services/Logger"
import type { SkillMetadata } from "@shared/skills"
import { emptyTaskCapabilityToggles, type TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { DlineDefaultTool } from "@shared/tools"
import fs from "fs/promises"
import path from "path"
import type { AgentBaseConfig, AgentRuleSelection } from "./AgentConfigLoader"

export interface SubagentCapabilityInfo {
    readonly name: string
    readonly description: string
    readonly scope: AgentRuleSelection["scope"] | "unknown"
    /** Rules use a root-relative path (remote rules use their stable name). */
    readonly path: string
    readonly required: boolean
    readonly available: boolean
    readonly unavailableReason?: string
}

export interface SubagentMcpServerInfo {
    readonly name: string
    readonly displayName: string
    readonly available: boolean
    readonly tools: readonly { readonly name: string; readonly description: string }[]
    readonly resources: readonly { readonly uri: string; readonly name: string; readonly description: string }[]
    readonly unavailableReason?: string
}

/** Domain metadata only: no instruction bodies, MCP config, schemas, or transport DTOs. */
export interface SubagentCapabilityCatalog {
    readonly rules: readonly SubagentCapabilityInfo[]
    readonly skills: readonly SubagentCapabilityInfo[]
    readonly workflows: readonly SubagentCapabilityInfo[]
    readonly mcp: readonly SubagentMcpServerInfo[]
}

/**
 * Reuse the host-bound owner port, never a parent selection or a storage workspace
 * ID. The RPC binds the Hub's all-servers variant to retain disabled UI metadata.
 * This narrow config lets it discover without constructing a TaskConfig.
 */
export interface SubagentCapabilityDiscoveryConfig {
    readonly cwd: string
    readonly services: Pick<TaskConfig["services"], "mcpHub" | "stateManager">
    readonly getMcpServersForOwner?: () => readonly McpServer[]
}

export interface SubagentWorkflowEntry {
    readonly name: string
    readonly description: string
    readonly path: string
    readonly source: "project" | "global" | "remote"
    readonly body: string
}

/** One child run's effective authority, prepared once before requesting a provider. */
export interface SubagentCapabilitySelection {
    readonly skills: SkillMetadata[]
    readonly workflows: SubagentWorkflowEntry[]
    readonly remoteSkillEntries: GlobalInstructionsFile[]
    /** Prompt/load projection only. Execution and approval still use the real Hub. */
    readonly mcpServers: McpServer[]
    readonly capabilities: CapabilitiesSnapshot
    readonly capabilityToggles: TaskCapabilityToggles
    readonly ruleInstructions: Pick<SystemPromptContext, "globalClineRulesFileInstructions" | "localClineRulesFileInstructions">
}

interface RuleRoot {
    readonly scope: "global" | "workspace"
    readonly path: string
    readonly owner: string
}

type RuleResource =
    | {
          readonly kind: "disk"
          readonly info: SubagentCapabilityInfo
          readonly root: RuleRoot
          readonly filePath: string
      }
    | {
          readonly kind: "remote"
          readonly info: SubagentCapabilityInfo
          readonly remote: GlobalInstructionsFile
      }

interface WorkflowResource {
    readonly info: SubagentCapabilityInfo
    readonly workflow: SubagentWorkflowEntry
}

interface PreparedCapabilities {
    readonly roots: RuleRoot[]
    readonly rules: RuleResource[]
    readonly skills: SkillMetadata[]
    readonly allSkills: SkillMetadata[]
    readonly workflows: WorkflowResource[]
    readonly allWorkflows: WorkflowResource[]
    readonly remoteSkills: GlobalInstructionsFile[]
    readonly servers: McpServer[]
    readonly catalog: SubagentCapabilityCatalog
}

/** Freeze only newly allocated snapshots, never a StateManager map or a Hub object. */
function freezeSnapshot<T extends object>(value: T): T {
    for (const child of Object.values(value)) {
        if (child !== null && typeof child === "object") freezeSnapshot(child)
    }
    Object.freeze(value)
    return value
}

function isWithin(root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function posix(filePath: string): string {
    return filePath.replace(/\\/g, "/")
}

/** Validate both the configured root's owner and the final target before reading. */
async function safeFile(filePath: string, root: RuleRoot): Promise<{ file: string; root: string; owner: string }> {
    if (!isWithin(root.path, filePath)) throw new Error("Path is outside its capability root")
    const [owner, realRoot, file] = await Promise.all([fs.realpath(root.owner), fs.realpath(root.path), fs.realpath(filePath)])
    if (!isWithin(owner, realRoot) || !isWithin(realRoot, file)) throw new Error("Symlink resolves outside its capability root")
    if (!(await fs.stat(file)).isFile()) throw new Error("Capability is not a regular file")
    return { file, root: realRoot, owner }
}

/** No symlink directories are followed, so loops and out-of-root recursion cannot expand discovery. */
async function listFiles(root: RuleRoot, markdownOnly = false): Promise<string[]> {
    try {
        const [owner, realRoot] = await Promise.all([fs.realpath(root.owner), fs.realpath(root.path)])
        if (!isWithin(owner, realRoot)) return []
        const walk = async (directory: string): Promise<string[]> => {
            // An unreadable subtree does not hide independently readable sibling rules.
            const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
            entries.sort((a, b) => a.name.localeCompare(b.name))
            const files: string[] = []
            for (const entry of entries) {
                const file = path.join(directory, entry.name)
                if (entry.isDirectory()) files.push(...(await walk(file)))
                else if ((entry.isFile() || entry.isSymbolicLink()) && (!markdownOnly || /\.(md|mdx)$/i.test(entry.name))) {
                    files.push(file)
                }
            }
            return files
        }
        return await walk(root.path)
    } catch {
        // An undiscoverable root grants nothing. An explicit rule in it fails at resolution.
        return []
    }
}

function metadata(content: string): { name?: string; description: string; body: string; invalid: boolean } {
    const parsed = parseYamlFrontmatter(content)
    return {
        name: typeof parsed.data.name === "string" ? parsed.data.name.trim() : undefined,
        description: typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
        body: parsed.body.trim(),
        invalid: Boolean(parsed.parseError),
    }
}

async function discoverRules(roots: RuleRoot[], remote: GlobalInstructionsFile[]): Promise<RuleResource[]> {
    const rules: RuleResource[] = []
    for (const root of roots) {
        for (const filePath of await listFiles(root)) {
            const relativePath = posix(path.relative(root.path, filePath))
            const info = { name: relativePath, description: "", scope: root.scope, path: relativePath, required: false }
            try {
                const safe = await safeFile(filePath, root)
                const { description } = metadata(await fs.readFile(safe.file, "utf8"))
                rules.push({ kind: "disk", root, filePath, info: { ...info, description, available: true } })
            } catch {
                rules.push({
                    kind: "disk",
                    root,
                    filePath,
                    info: { ...info, available: false, unavailableReason: "Rule is unreadable or outside its root." },
                })
            }
        }
    }
    for (const entry of remote) {
        rules.push({
            kind: "remote",
            remote: entry,
            info: {
                name: entry.name,
                description: metadata(entry.contents).description,
                scope: "remote",
                path: entry.name,
                required: entry.alwaysEnabled === true,
                available: true,
            },
        })
    }
    return rules
}

/**
 * Read every markdown workflow in each scan root with the legacy aggregator
 * semantics: frontmatter name wins, the file basename is the fallback, and
 * description is optional. Invalid frontmatter is retained fail-open, exactly
 * like {@link parseYamlFrontmatter}; only an unreadable or out-of-root file is
 * unavailable. Do not add a hard schema here: loaders and prompt projection
 * accept plain markdown workflows today.
 */
async function discoverWorkflows(cwd: string, remote: GlobalInstructionsFile[]): Promise<WorkflowResource[]> {
    const workflows: WorkflowResource[] = []
    for (const directory of getWorkflowsScanDirectories(cwd)) {
        const root: RuleRoot = {
            scope: directory.source === "project" ? "workspace" : "global",
            path: path.resolve(directory.path),
            owner: directory.source === "project" ? cwd : getDlineDocumentsPathSync(),
        }
        for (const filePath of await listFiles(root, true)) {
            const fallbackName = path.basename(filePath, path.extname(filePath))
            try {
                const safe = await safeFile(filePath, root)
                const parsed = metadata(await fs.readFile(safe.file, "utf8"))
                // metadata() already trims; an empty result means "no name", so the
                // basename wins exactly like LoadCapabilityService.extractName.
                const name = parsed.name || fallbackName
                workflows.push({
                    info: {
                        name,
                        description: parsed.description,
                        path: filePath,
                        scope: root.scope,
                        required: false,
                        available: true,
                    },
                    workflow: {
                        name,
                        description: parsed.description,
                        path: filePath,
                        source: directory.source,
                        body: parsed.body,
                    },
                })
            } catch {
                workflows.push({
                    info: {
                        name: fallbackName,
                        description: "",
                        path: filePath,
                        scope: root.scope,
                        required: false,
                        available: false,
                        unavailableReason: "Workflow is unreadable or outside its root.",
                    },
                    workflow: { name: fallbackName, description: "", path: filePath, source: directory.source, body: "" },
                })
            }
        }
    }
    for (const entry of remote) {
        const parsed = metadata(entry.contents)
        workflows.push({
            info: {
                name: entry.name,
                description: parsed.description,
                scope: "remote",
                path: `remote:${entry.name}`,
                required: entry.alwaysEnabled === true,
                available: true,
            },
            workflow: {
                name: entry.name,
                description: parsed.description,
                path: `remote:${entry.name}`,
                source: "remote",
                body: parsed.body,
            },
        })
    }
    return workflows
}

function skillInfo(skill: SkillMetadata, required: ReadonlySet<string>): SubagentCapabilityInfo {
    const remote = skill.path.startsWith("remote:")
    return {
        name: skill.name,
        description: skill.description,
        path: skill.path,
        scope: remote ? "remote" : skill.source === "project" ? "workspace" : "global",
        required: remote && required.has(skill.name),
        available: true,
    }
}

function mcpUnavailableReason(server: McpServer): string | undefined {
    if (server.disabled) return "MCP server is disabled."
    if (server.status !== "connected") return `MCP server is ${server.status}.`
    return undefined
}

function projectTool(tool: McpTool): McpTool {
    return {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: structuredClone(tool.inputSchema) }),
    }
}

function projectResource(resource: McpResource): McpResource {
    return {
        uri: resource.uri,
        name: resource.name,
        ...(resource.description === undefined ? {} : { description: resource.description }),
        ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
    }
}

/** Allowlisted, detached projection; notably no raw config, errors, prompts, or templates. */
function projectServer(server: McpServer, tools = server.tools ?? [], resources = server.resources ?? []): McpServer {
    return {
        name: server.name,
        displayName: server.displayName,
        description: server.description,
        source: server.source,
        config: "{}",
        status: server.status,
        disabled: server.disabled,
        uid: server.uid,
        tools: tools.map(projectTool),
        resources: resources.map(projectResource),
    }
}

function serverInfo(server: McpServer): SubagentMcpServerInfo {
    const unavailableReason = mcpUnavailableReason(server)
    return {
        name: server.name,
        displayName: server.displayName ?? server.name,
        available: unavailableReason === undefined,
        tools: (server.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
        resources: (server.resources ?? []).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: resource.description ?? "",
        })),
        ...(unavailableReason ? { unavailableReason } : {}),
    }
}

async function prepareCapabilities(config: SubagentCapabilityDiscoveryConfig): Promise<PreparedCapabilities> {
    const cwd = path.resolve(config.cwd)
    const remote = config.services.stateManager.getRemoteConfigSettings()
    // Detach enterprise entries before any asynchronous disk work.
    const remoteRules = (remote.remoteGlobalRules ?? []).map((entry) => ({ ...entry }))
    const remoteWorkflows = (remote.remoteGlobalWorkflows ?? []).map((entry) => ({ ...entry }))
    const remoteSkills: GlobalInstructionsFile[] = parseRemoteSkillEntries(remote.remoteGlobalSkills ?? []).map((entry) => ({
        name: entry.name,
        alwaysEnabled: entry.alwaysEnabled,
        contents: entry.contents,
    }))
    const globalRoot = getDlineDocumentsPathSync()
    const roots: RuleRoot[] = [
        { scope: "global", path: path.join(globalRoot, "rules"), owner: globalRoot },
        { scope: "workspace", path: path.join(cwd, GlobalFileNames.agentsRulesDir), owner: cwd },
    ]
    const hub = config.services.mcpHub
    // An unregistered owner can see only settings servers. Never fall back to getServers().
    const ownedServers = config.getMcpServersForOwner?.() ?? hub.getAllServersForOwner("")
    const servers = ownedServers.map((server) => projectServer(server))
    const [rules, discoveredSkills, allWorkflows] = await Promise.all([
        discoverRules(roots, remoteRules),
        discoverSkills(cwd, remoteSkills),
        discoverWorkflows(cwd, remoteWorkflows),
    ])
    const allSkills = discoveredSkills.map((skill) => ({ ...skill }))
    const requiredSkillNames = new Set(remoteSkills.filter((entry) => entry.alwaysEnabled).map((entry) => entry.name))
    // Ordinary collisions retain existing project > global > remote precedence.
    // Mandatory remote instructions cannot be replaced by a same-name disk entry.
    const skillMap = new Map(getAvailableSkills(allSkills).map((skill) => [skill.name, skill]))
    for (const skill of allSkills) {
        if (skill.path.startsWith("remote:") && requiredSkillNames.has(skill.name)) skillMap.set(skill.name, skill)
    }
    const skills = [...skillMap.values()]
    const workflowMap = new Map<string, WorkflowResource>()
    for (const workflow of allWorkflows) {
        if (!workflowMap.has(workflow.info.name) || workflow.info.required) workflowMap.set(workflow.info.name, workflow)
    }
    const workflows = [...workflowMap.values()]
    const catalog: SubagentCapabilityCatalog = {
        rules: rules.map((rule) => rule.info),
        skills: skills.map((skill) => skillInfo(skill, requiredSkillNames)),
        workflows: workflows.map((workflow) => workflow.info),
        mcp: servers.map(serverInfo),
    }
    return { roots, rules, skills, allSkills, workflows, allWorkflows, remoteSkills, servers, catalog }
}

export function discoverSubagentCapabilities(config: Pick<TaskConfig, "cwd" | "services">): Promise<SubagentCapabilityCatalog>
export function discoverSubagentCapabilities(config: SubagentCapabilityDiscoveryConfig): Promise<SubagentCapabilityCatalog>
export async function discoverSubagentCapabilities(
    config: SubagentCapabilityDiscoveryConfig,
): Promise<SubagentCapabilityCatalog> {
    return freezeSnapshot((await prepareCapabilities(config)).catalog)
}

function normalizeRulePath(rule: AgentRuleSelection): string {
    if (rule.scope === "remote") return rule.path
    const normalized = posix(rule.path)
    if (
        !normalized ||
        normalized.includes("\0") ||
        path.posix.isAbsolute(normalized) ||
        /^[a-z][a-z0-9+.-]*:/i.test(normalized) ||
        normalized.split("/").includes("..") ||
        path.posix.normalize(normalized) === "."
    ) {
        throw new Error(`Subagent rule ${rule.scope}:${rule.path} must be relative to its rule root without '..' segments.`)
    }
    return path.posix.normalize(normalized)
}

async function resolveRules(
    prepared: PreparedCapabilities,
    rules: readonly AgentRuleSelection[],
    cwd: string,
    prompt: string,
    toggles: TaskCapabilityToggles,
): Promise<SubagentCapabilitySelection["ruleInstructions"]> {
    const selected = new Set<string>()
    for (const rule of rules) {
        const rulePath = normalizeRulePath(rule)
        const resource = prepared.rules.find(
            (candidate) => candidate.info.scope === rule.scope && candidate.info.path === rulePath,
        )
        if (!resource?.info.available) {
            const reason = resource?.info.unavailableReason ?? "not found in its rule root"
            throw new Error(`Subagent rule ${rule.scope}:${rulePath} is unavailable: ${reason}`)
        }
        selected.add(JSON.stringify([rule.scope, rulePath]))
    }
    const evaluationContext = {
        paths: extractPathLikeStrings(prompt)
            .map((candidate) => toWorkspaceRelativePosixPath(path.resolve(cwd, candidate), cwd))
            .filter((candidate): candidate is string => Boolean(candidate))
            .slice(0, 100),
    }
    const globalContent: string[] = []
    const localContent: string[] = []
    const remoteRules: GlobalInstructionsFile[] = []
    const loadedFiles = new Set<string>()
    for (const resource of prepared.rules) {
        const enabled = resource.info.required || selected.has(JSON.stringify([resource.info.scope, resource.info.path]))
        if (resource.kind === "remote") {
            toggles.remoteRulesToggles[resource.info.path] = enabled
            if (enabled) remoteRules.push(resource.remote)
            continue
        }
        const ruleToggles = resource.info.scope === "global" ? toggles.globalClineRulesToggles : toggles.localClineRulesToggles
        ruleToggles[resource.filePath] = enabled
        if (!enabled) continue
        try {
            const safe = await safeFile(resource.filePath, resource.root)
            const identity = JSON.stringify([resource.info.scope, safe.file])
            if (loadedFiles.has(identity)) continue
            loadedFiles.add(identity)
            const global = resource.info.scope === "global"
            const loaded = await getRuleFilesTotalContentWithMetadata(
                [safe.file],
                global ? safe.root : safe.owner,
                {},
                { evaluationContext, ruleNamePrefix: global ? "global" : "workspace" },
            )
            if (loaded.content) (global ? globalContent : localContent).push(loaded.content)
        } catch (error) {
            throw new Error(`Subagent rule ${resource.info.scope}:${resource.info.path} could not be read safely.`, {
                cause: error,
            })
        }
    }
    const remote = getRemoteRulesTotalContentWithMetadata(remoteRules, toggles.remoteRulesToggles, { evaluationContext })
    if (remote.content) globalContent.push(remote.content)
    return {
        globalClineRulesFileInstructions: globalContent.length
            ? formatResponse.clineRulesGlobalDirectoryInstructions(prepared.roots[0].path, globalContent.join("\n\n"))
            : undefined,
        localClineRulesFileInstructions: localContent.length
            ? formatResponse.clineRulesLocalDirectoryInstructions(path.basename(cwd), localContent.join("\n\n"))
            : undefined,
    }
}

/** Independent discovery and child tool gates are applied once, never in a provider/tool loop. */
export async function resolveSubagentCapabilitySelection(
    config: TaskConfig,
    agent: Partial<AgentBaseConfig>,
    prompt: string,
    allowedTools: readonly DlineDefaultTool[],
    promptProfile: PromptProfile,
): Promise<SubagentCapabilitySelection> {
    requirePromptProfile(promptProfile)
    // Snapshot the author's intent before discovery yields; no later YAML edits affect this run.
    const rules = (agent.rules ?? []).map((rule) => ({ ...rule, path: normalizeRulePath(rule) }))
    const skillNames = new Set(agent.skills ?? [])
    const workflowNames = new Set(agent.workflows ?? [])
    const mcpSelections = (agent.mcp ?? []).map((entry) => ({
        server: entry.server,
        tools: [...(entry.tools ?? [])],
        resources: [...(entry.resources ?? [])],
    }))
    const allowed = new Set(allowedTools)
    const standard = promptProfile === PromptProfile.Standard
    const skillsEnabled = standard && allowed.has(DlineDefaultTool.LOAD_SKILL)
    const workflowsEnabled = standard && allowed.has(DlineDefaultTool.LOAD_WORKFLOW)
    const mcpToolsEnabled = standard && allowed.has(DlineDefaultTool.LOAD_MCP) && allowed.has(DlineDefaultTool.MCP_USE)
    const mcpResourcesEnabled = standard && allowed.has(DlineDefaultTool.MCP_ACCESS)
    const prepared = await prepareCapabilities(config)
    const toggles = emptyTaskCapabilityToggles()
    // Capability names are external identities, including valid names such as '__proto__'.
    for (const map of Object.values(toggles)) Object.setPrototypeOf(map, null)
    const requiredSkills = new Set(prepared.remoteSkills.filter((entry) => entry.alwaysEnabled).map((entry) => entry.name))
    const skills = prepared.skills.filter(
        (skill) =>
            skillsEnabled && (skillNames.has(skill.name) || (skill.path.startsWith("remote:") && requiredSkills.has(skill.name))),
    )
    // A configured name with no discovered skill is an author error, not a
    // selection: report it once and keep the run failing closed to that name.
    // Runs whose loader gate is off (Lite profile or no load_skill tool) never
    // select skills, so a missing name there is not an actionable selection
    // failure and stays silent.
    if (skillsEnabled) {
        for (const name of skillNames) {
            if (!prepared.skills.some((skill) => skill.name === name)) {
                Logger.warn(`[SubagentCapabilitySelection] Configured skill "${name}" is not available and was not selected.`)
            }
        }
    }
    const selectedSkillPaths = new Set(skills.map((skill) => skill.path))
    for (const skill of prepared.allSkills) {
        const enabled = selectedSkillPaths.has(skill.path)
        if (skill.path.startsWith("remote:")) toggles.remoteSkillsToggles[skill.name] = enabled
        else (skill.source === "project" ? toggles.localSkillsToggles : toggles.globalSkillsToggles)[skill.path] = enabled
    }
    const workflows = prepared.workflows
        .filter(
            (entry) => workflowsEnabled && entry.info.available && (entry.info.required || workflowNames.has(entry.info.name)),
        )
        .map((entry) => entry.workflow)
    const workflowPaths = new Set(workflows.map((workflow) => workflow.path))
    for (const { workflow } of prepared.allWorkflows) {
        const enabled = workflowPaths.has(workflow.path)
        if (workflow.source === "remote") toggles.remoteWorkflowToggles[workflow.name] = enabled
        else
            (workflow.source === "project" ? toggles.localWorkflowToggles : toggles.globalWorkflowToggles)[workflow.path] =
                enabled
    }
    const mcpServers: McpServer[] = []
    for (const selection of mcpSelections) toggles.mcpServers[selection.server] = false
    for (const server of prepared.servers) {
        const selections = mcpSelections.filter((selection) => selection.server === server.name)
        const toolNames = new Set(selections.flatMap((selection) => selection.tools))
        const uris = new Set(selections.flatMap((selection) => selection.resources))
        const tools = (server.tools ?? []).filter((tool) => mcpToolsEnabled && toolNames.has(tool.name))
        const resources = (server.resources ?? []).filter((resource) => mcpResourcesEnabled && uris.has(resource.uri))
        toggles.mcpServers[server.name] = (tools.length > 0 || resources.length > 0) && mcpUnavailableReason(server) === undefined
        if (tools.length || resources.length) mcpServers.push(projectServer(server, tools, resources))
    }
    const ruleInstructions = await resolveRules(prepared, rules, path.resolve(config.cwd), prompt, toggles)
    const remoteSkillEntries = prepared.remoteSkills.filter((entry) => selectedSkillPaths.has(`remote:${entry.name}`))
    const capabilities = projectCapabilities(
        {
            skills: skills.map((skill) => ({ skill, entry: { name: skill.name, description: skill.description } })),
            workflows: workflows.map((workflow) => ({
                source: workflow.source,
                path: workflow.path,
                entry: { name: workflow.name, description: workflow.description, contentHash: hashPromptContent(workflow.body) },
            })),
            subagents: [],
        },
        { cwd: config.cwd, mcpHub: { getServers: () => mcpServers } },
    )
    return freezeSnapshot({
        skills,
        workflows,
        remoteSkillEntries,
        mcpServers,
        capabilities,
        capabilityToggles: toggles,
        ruleInstructions,
    })
}
