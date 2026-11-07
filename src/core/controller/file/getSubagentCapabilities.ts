import { GlobalFileNames, getDlineDocumentsPathSync, getDlineSubagentsDirectoryPath } from "@core/storage/disk"
import { type AgentBaseConfig, parseAgentConfigFromYaml } from "@core/task/tools/subagent/AgentConfigLoader"
import {
    discoverSubagentCapabilities,
    type SubagentCapabilityCatalog,
    type SubagentCapabilityInfo,
    type SubagentMcpServerInfo,
} from "@core/task/tools/subagent/SubagentCapabilitySelection"
import { type GetSubagentCapabilitiesRequest, SubagentCapabilitiesResponse } from "@shared/proto/dline/file"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { getCwd, getDesktopDir } from "@/utils/path"
import type { Controller } from ".."

function isWithin(root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Read only a discovered, flat YAML file, never an arbitrary path supplied by the Webview. */
async function readOwnedSubagent(
    controller: Controller,
    requestedPath: string,
): Promise<{ cwd: string; agent: AgentBaseConfig }> {
    if (!requestedPath || !path.isAbsolute(requestedPath) || !/\.(yaml|yml)$/i.test(requestedPath)) {
        throw new Error("subagentPath must identify an existing subagent YAML file.")
    }
    const filePath = path.resolve(requestedPath)
    const manager = controller.getWorkspaceManager()
    const managedRoots = manager?.getRoots().map((root) => root.path) ?? []
    const workspaceRoots = managedRoots.length ? managedRoots : (await HostProvider.workspace.getWorkspacePaths({})).paths
    const preferredCwd = manager?.getPrimaryRoot()?.path ?? workspaceRoots[0] ?? (await getCwd(getDesktopDir()))
    const roots = [
        ...workspaceRoots.map((workspace) => ({
            root: path.resolve(workspace, GlobalFileNames.agentsSubagentsDir),
            owner: path.resolve(workspace),
            cwd: workspace,
        })),
        {
            root: path.resolve(getDlineSubagentsDirectoryPath()),
            owner: path.resolve(getDlineDocumentsPathSync()),
            cwd: preferredCwd,
        },
    ]
    const candidate = roots.find(({ root }) => path.relative(root, path.dirname(filePath)) === "")
    if (!candidate) throw new Error("subagentPath is outside the owned subagent directories.")
    const [owner, root, file] = await Promise.all([
        fs.realpath(candidate.owner),
        fs.realpath(candidate.root),
        fs.realpath(filePath),
    ])
    if (!isWithin(owner, root) || !isWithin(root, file) || !(await fs.stat(file)).isFile()) {
        throw new Error("subagentPath resolves outside its owned subagent directory.")
    }
    // Global YAMLs run in the Controller's workspace, not Documents/dline/subagents.
    return { cwd: path.resolve(candidate.cwd), agent: parseAgentConfigFromYaml(await fs.readFile(file, "utf8")) }
}

function missingCapability(name: string, scope: SubagentCapabilityInfo["scope"], selectedPath = name): SubagentCapabilityInfo {
    return {
        name,
        description: "",
        scope,
        path: selectedPath,
        required: false,
        available: false,
        unavailableReason: "Selected capability is no longer available.",
    }
}

/** Preserve stale YAML intent in the UI without turning it into execution authority. */
function includeUnavailableSelections(catalog: SubagentCapabilityCatalog, agent: AgentBaseConfig): SubagentCapabilityCatalog {
    const rules = [...catalog.rules]
    for (const selection of agent.rules ?? []) {
        if (!rules.some((rule) => rule.scope === selection.scope && rule.path === selection.path)) {
            rules.push(missingCapability(selection.path, selection.scope, selection.path))
        }
    }
    const skills = [...catalog.skills]
    for (const name of agent.skills ?? []) {
        if (!skills.some((skill) => skill.name === name)) skills.push(missingCapability(name, "unknown"))
    }
    const workflows = [...catalog.workflows]
    for (const name of agent.workflows ?? []) {
        if (!workflows.some((workflow) => workflow.name === name)) workflows.push(missingCapability(name, "unknown"))
    }
    const mcp: SubagentMcpServerInfo[] = [...catalog.mcp]
    for (const selection of agent.mcp ?? []) {
        const server = mcp.find((entry) => entry.name === selection.server)
        if (!server) {
            // Unknown servers keep a whole-placeholder entry: the runtime
            // retains the YAML intent, and the UI draws it disabled.
            mcp.push({
                name: selection.server,
                displayName: selection.server,
                available: false,
                tools: selection.tools.map((name) => ({ name, description: "" })),
                resources: selection.resources.map((uri) => ({ uri, name: uri, description: "" })),
                unavailableReason: "Selected MCP server is no longer available to this workspace.",
            })
        }
        // A discovered server always reports its real state and only its
        // actual catalog items. Availability comes from the server's true
        // status alone; a gone tool or exact URI must never demote the whole
        // server, and stale items are re-created by the UI (mcpChoices) from
        // the saved YAML, not echoed into the live catalog.
    }
    return { rules, skills, workflows, mcp }
}

/** Independent, read-only candidate RPC. Never calls refreshRules/refreshSkills or prunes preferences. */
export async function getSubagentCapabilities(
    controller: Controller,
    request: GetSubagentCapabilitiesRequest,
): Promise<SubagentCapabilitiesResponse> {
    const { cwd, agent } = await readOwnedSubagent(controller, request.subagentPath)
    await controller.ensureWorkspaceMcpDescriptors()
    const discovered = await discoverSubagentCapabilities({
        cwd,
        services: {
            stateManager: controller.stateManager,
            mcpHub: controller.mcpHub,
        },
        getMcpServersForOwner: () => controller.mcpHub.getAllServersForOwner(controller.mcpOwnerId),
    })
    const catalog = includeUnavailableSelections(discovered, agent)
    // Explicit projection is the transport/privacy boundary, not a cast of runtime objects.
    const info = (entry: SubagentCapabilityInfo) => ({
        name: entry.name,
        description: entry.description,
        scope: entry.scope,
        path: entry.path,
        required: entry.required,
        available: entry.available,
        unavailableReason: entry.unavailableReason,
    })
    return SubagentCapabilitiesResponse.create({
        rules: catalog.rules.map(info),
        skills: catalog.skills.map(info),
        workflows: catalog.workflows.map(info),
        mcp: catalog.mcp.map((server) => ({
            name: server.name,
            displayName: server.displayName,
            available: server.available,
            unavailableReason: server.unavailableReason,
            tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description })),
            resources: server.resources.map((resource) => ({
                uri: resource.uri,
                name: resource.name,
                description: resource.description,
            })),
        })),
    })
}
