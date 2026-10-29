import { resolveProvider } from "@core/api"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { discoverAvailableSkills, getSkillContent } from "@core/context/instructions/user-instructions/skills"
import { getWorkflowsScanDirectories } from "@core/storage/disk"
import {
    createFailedPayload,
    type LoadCapabilityKind,
    type LoadCapabilityPayload,
    type LoadCapabilitySource,
} from "@shared/load-capabilities"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import fs from "fs/promises"
import * as path from "path"
import { telemetryService } from "@/services/telemetry"
import type { TaskConfig } from "../types/TaskConfig"

interface WorkflowEntry {
    name: string
    description: string
    body: string
    source: LoadCapabilitySource
    path: string
    enabled: boolean
}

/**
 * Read-only service that loads detailed metadata for stable load_xxx tools.
 */
export class LoadCapabilityService {
    /**
     * Load a named capability detail payload without refreshing capability lists.
     *
     * @param kind Capability family requested by the model.
     * @param name Exact capability name to load.
     * @param config Runtime task configuration used for read-only adapters.
     * @returns Structured Webview and model payload.
     */
    async load(kind: LoadCapabilityKind, name: string, config: TaskConfig): Promise<LoadCapabilityPayload> {
        try {
            switch (kind) {
                case "mcp":
                    return this.loadMcp(name, config)
                case "skill":
                    return this.loadSkill(name, config)
                case "workflow":
                    return this.loadWorkflow(name, config)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return createFailedPayload(kind, name, message)
        }
    }

    /**
     * Load MCP server tool metadata from the current hub snapshot.
     *
     * @param name Exact MCP capability name, preferably server.tool.
     * @param config Runtime task configuration.
     * @returns MCP load payload.
     */
    private loadMcp(name: string, config: TaskConfig): LoadCapabilityPayload {
        const servers = config.services.mcpHub
            .getServers()
            .filter((server) => server.disabled !== true && config.capabilityToggles.mcpServers[server.name] === true)
        const match = servers
            .flatMap((server) => (server.tools ?? []).map((tool) => ({ server, tool })))
            .find(({ server, tool }) => `${server.name}.${tool.name}` === name || tool.name === name)

        if (!match) {
            return createFailedPayload("mcp", name, `Unknown or unavailable MCP tool '${name}'.`)
        }

        const inputSchema = this.objectDetail(match.tool.inputSchema)
        return {
            tool: "loadCapability",
            kind: "mcp",
            status: "completed",
            name,
            source: "mcp",
            enabled: match.server.status === "connected",
            summary: `${match.server.name}.${match.tool.name}: ${match.tool.description ?? "No description provided."}`,
            details: [
                { label: "Server", value: match.server.name },
                { label: "Tool", value: match.tool.name },
                { label: "Description", value: match.tool.description ?? "No description provided." },
                { label: "Input schema", value: inputSchema },
                {
                    label: "Usage",
                    value: `Call use_mcp_tool with server_name='${match.server.name}' and tool_name='${match.tool.name}'.`,
                },
                { label: "Available", value: match.server.status === "connected" ? "yes" : match.server.status },
            ],
        }
    }

    /**
     * Load skill metadata and full instruction body from existing skill loaders.
     *
     * @param name Exact skill name.
     * @param config Runtime task configuration.
     * @returns Skill load payload.
     */
    private async loadSkill(name: string, config: TaskConfig): Promise<LoadCapabilityPayload> {
        const stateManager = config.services.stateManager
        const toggles = config.capabilityToggles
        const remoteSkillEntries = stateManager.getRemoteConfigSettings().remoteGlobalSkills || []
        const skills = await discoverAvailableSkills(config.cwd, {
            remoteSkillEntries,
            globalSkillsToggles: toggles.globalSkillsToggles,
            localSkillsToggles: toggles.localSkillsToggles,
            remoteSkillsToggles: toggles.remoteSkillsToggles,
        })
        const content = await getSkillContent(name, skills, remoteSkillEntries)
        if (!content) {
            return createFailedPayload("skill", name, `Unknown or disabled skill '${name}'.`)
        }

        const source = content.path.startsWith("remote:") ? "remote" : content.source
        const apiConfig = config.services.stateManager.getApiConfiguration()
        const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
        const provider = resolveProvider(apiConfig, currentMode)
        const globalCount = skills.filter((skill) => skill.source === "global").length
        const projectCount = skills.filter((skill) => skill.source === "project").length
        telemetryService.safeCapture(
            () =>
                telemetryService.captureSkillUsed({
                    ulid: config.ulid ?? "",
                    skillName: content.name,
                    skillSource: content.source === "global" ? "global" : "project",
                    skillsAvailableGlobal: globalCount,
                    skillsAvailableProject: projectCount,
                    provider,
                    modelId: config.api.getModel().id,
                }),
            "LoadCapabilityService.loadSkill",
        )

        return {
            tool: "loadCapability",
            kind: "skill",
            status: "completed",
            name,
            source,
            enabled: true,
            summary: `${content.name}: ${content.description}`,
            details: [
                { label: "Name", value: content.name },
                { label: "Description", value: content.description },
                { label: "Source", value: source },
                { label: "Path", value: content.path },
                { label: "Enabled", value: "yes" },
            ],
            body: content.instructions,
        }
    }

    /**
     * Load workflow metadata from local, global, or remote workflow adapters.
     *
     * @param name Exact workflow name.
     * @param config Runtime task configuration.
     * @returns Workflow load payload.
     */
    private async loadWorkflow(name: string, config: TaskConfig): Promise<LoadCapabilityPayload> {
        const workflows = await this.collectWorkflows(config)
        const workflow = workflows.find((entry) => entry.name === name && entry.enabled)
        if (!workflow) {
            return createFailedPayload("workflow", name, `Unknown or disabled workflow '${name}'.`)
        }

        return {
            tool: "loadCapability",
            kind: "workflow",
            status: "completed",
            name,
            source: workflow.source,
            enabled: workflow.enabled,
            summary: `${workflow.name}: ${workflow.description}`,
            details: [
                { label: "Name", value: workflow.name },
                { label: "Description", value: workflow.description },
                { label: "Source", value: workflow.source },
                { label: "Path", value: workflow.path },
                { label: "Enabled", value: workflow.enabled ? "yes" : "no" },
            ],
            body: workflow.body,
        }
    }

    /**
     * Collect enabled and disabled workflow entries without mutating toggle state.
     *
     * @param config Runtime task configuration.
     * @returns Workflow entries from disk and remote settings.
     */
    private async collectWorkflows(config: TaskConfig): Promise<WorkflowEntry[]> {
        const taskToggles = config.capabilityToggles
        const entries: WorkflowEntry[] = []
        for (const directory of getWorkflowsScanDirectories(config.cwd)) {
            const toggles = directory.source === "global" ? taskToggles.globalWorkflowToggles : taskToggles.localWorkflowToggles
            const filePaths = await this.readWorkflowFiles(directory.path)
            for (const filePath of filePaths) {
                const content = await fs.readFile(filePath, "utf8")
                const parsed = parseYamlFrontmatter(content)
                const name = this.extractName(parsed.data, filePath)
                entries.push({
                    name,
                    description: this.extractDescription(parsed.data),
                    body: parsed.body.trim(),
                    source: directory.source,
                    path: filePath,
                    enabled: toggles[filePath] !== false,
                })
            }
        }

        return [...entries, ...this.collectRemoteWorkflows(config)]
    }

    /**
     * Collect remote workflow entries from current remote config settings.
     *
     * @param config Runtime task configuration.
     * @returns Remote workflow entries.
     */
    private collectRemoteWorkflows(config: TaskConfig): WorkflowEntry[] {
        const remoteWorkflows = config.services.stateManager.getRemoteConfigSettings().remoteGlobalWorkflows || []
        const toggles = config.capabilityToggles.remoteWorkflowToggles
        return remoteWorkflows.map((entry: GlobalInstructionsFile) => {
            const parsed = parseYamlFrontmatter(entry.contents)
            return {
                name: entry.name,
                description: this.extractDescription(parsed.data),
                body: parsed.body.trim(),
                source: "remote",
                path: `remote:${entry.name}`,
                enabled: entry.alwaysEnabled || toggles[entry.name] !== false,
            }
        })
    }

    /**
     * Read workflow files from a directory recursively.
     *
     * @param directoryPath Directory path to scan.
     * @returns Absolute markdown workflow file paths.
     */
    private async readWorkflowFiles(directoryPath: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(directoryPath, { withFileTypes: true })
            const nested = await Promise.all(
                entries.map(async (entry) => {
                    const entryPath = path.join(directoryPath, entry.name)
                    if (entry.isDirectory()) {
                        return this.readWorkflowFiles(entryPath)
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
     * Extract a display name from frontmatter or file name.
     *
     * @param data Parsed frontmatter data.
     * @param filePath Workflow file path.
     * @returns Stable workflow display name.
     */
    private extractName(data: Record<string, unknown>, filePath: string): string {
        return typeof data.name === "string" && data.name.trim()
            ? data.name.trim()
            : path.basename(filePath, path.extname(filePath))
    }

    /**
     * Extract a description from frontmatter.
     *
     * @param data Parsed frontmatter data.
     * @returns Workflow description or fallback text.
     */
    private extractDescription(data: Record<string, unknown>): string {
        return typeof data.description === "string" && data.description.trim()
            ? data.description.trim()
            : "No description provided."
    }

    /**
     * Normalize an optional object detail for payload rendering.
     *
     * @param value Unknown object-like metadata value.
     * @returns Object detail safe for JSON rendering.
     */
    private objectDetail(value: object | undefined): Record<string, unknown> {
        return value ? (value as Record<string, unknown>) : {}
    }
}
