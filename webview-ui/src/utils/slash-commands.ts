import { type InputSemanticCatalog, indexCommandTriggers } from "@shared/input-semantics/catalog"
import { namespacedCommandTrigger } from "@shared/input-semantics/command-namespace"
import type { SlashCommandNamespace } from "@shared/input-semantics/document"
import type { McpServer } from "@shared/mcp"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { PLATFORM_CONFIG, PlatformType } from "@/config/platform.config"
import {
    getBuiltInSlashCommands,
    pathToCommandName,
    pathToSkillName,
    type SlashCommand,
} from "../../../src/shared/slashCommands.ts"

/** Menu sections in display order; keyboard navigation follows the same order. */
export const SLASH_MENU_SECTIONS = ["default", "workflow", "skill", "mcp"] as const
export type SlashMenuSection = (typeof SLASH_MENU_SECTIONS)[number]

/** The command namespace each menu section writes its triggers in. */
const SECTION_NAMESPACE: Readonly<Record<SlashMenuSection, SlashCommandNamespace>> = {
    default: "cmd",
    workflow: "workflow",
    skill: "skill",
    mcp: "mcp",
}

function sectionOf(command: SlashCommand): SlashMenuSection {
    return SLASH_MENU_SECTIONS.find((section) => section === command.section) ?? "default"
}

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = getBuiltInSlashCommands(
    PLATFORM_CONFIG.type === PlatformType.VSCODE ? "vscode" : "standalone",
)

/**
 * Get workflow slash commands from enabled toggles.
 * Name format: "workflow:xxx" (without .md extension).
 */
export function getWorkflowCommands(
    localWorkflowToggles: Record<string, boolean>,
    globalWorkflowToggles: Record<string, boolean>,
    remoteWorkflowToggles?: Record<string, boolean>,
    remoteWorkflows?: any[],
    workflowDescriptions?: Record<string, string>,
): SlashCommand[] {
    const { workflows: localWorkflows, nameSet: localWorkflowNames } = Object.entries(localWorkflowToggles)
        .filter(([_, enabled]) => enabled)
        .reduce(
            (acc, [filePath, _]) => {
                const baseName = pathToCommandName(filePath)

                acc.workflows.push({
                    name: baseName,
                    section: "workflow",
                    description: workflowDescriptions?.[baseName],
                } as SlashCommand)

                acc.nameSet.add(baseName)

                return acc
            },
            { workflows: [] as SlashCommand[], nameSet: new Set<string>() },
        )

    const globalWorkflows = Object.entries(globalWorkflowToggles)
        .filter(([_, enabled]) => enabled)
        .flatMap(([filePath, _]) => {
            const baseName = pathToCommandName(filePath)

            if (localWorkflowNames.has(baseName)) {
                return []
            }

            return [
                {
                    name: baseName,
                    section: "workflow",
                    description: workflowDescriptions?.[baseName],
                },
            ] as SlashCommand[]
        })

    // Add remote workflows that are enabled
    const remoteWorkflowCommands: SlashCommand[] = []
    if (remoteWorkflows && remoteWorkflowToggles) {
        for (const workflow of remoteWorkflows) {
            const enabled = workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false
            if (enabled) {
                remoteWorkflowCommands.push({
                    name: workflow.name,
                    section: "workflow",
                    description: workflowDescriptions?.[workflow.name],
                })
            }
        }
    }

    const workflows = [...localWorkflows, ...globalWorkflows, ...remoteWorkflowCommands]
    return workflows
}

/**
 * Get skill slash commands from enabled toggles.
 * Name format: "skills:xxx".
 */
export function getSkillCommands(
    localSkillsToggles: Record<string, boolean> = {},
    globalSkillsToggles: Record<string, boolean> = {},
    remoteSkills?: any[],
    remoteSkillsToggles?: Record<string, boolean>,
    availableSkillCommands?: SlashCommand[],
): SlashCommand[] {
    if (availableSkillCommands) {
        return availableSkillCommands.map((command) => ({ ...command, section: "skill" }))
    }

    const skillNames = new Set<string>()
    const commands: SlashCommand[] = []

    // Local skills
    for (const [path, enabled] of Object.entries(localSkillsToggles)) {
        if (enabled && path) {
            const name = pathToSkillName(path)
            skillNames.add(name)
            commands.push({
                name,
                section: "skill",
            } as SlashCommand)
        }
    }

    // Global skills (skip if local exists with same name)
    for (const [path, enabled] of Object.entries(globalSkillsToggles)) {
        if (enabled && path) {
            const name = pathToSkillName(path)
            if (skillNames.has(name)) continue
            skillNames.add(name)
            commands.push({
                name,
                section: "skill",
            } as SlashCommand)
        }
    }

    // Remote skills
    if (remoteSkills && remoteSkillsToggles) {
        for (const skill of remoteSkills) {
            const enabled = skill.alwaysEnabled || remoteSkillsToggles[skill.name] !== false
            if (enabled && !skillNames.has(skill.name)) {
                skillNames.add(skill.name)
                commands.push({
                    name: skill.name,
                    section: "skill",
                } as SlashCommand)
            }
        }
    }

    return commands
}

/**
 * Gets MCP prompt commands from connected MCP servers
 * Format: mcp:<server-name>:<prompt-name>
 */
export function getMcpPromptCommands(mcpServers: McpServer[] = []): SlashCommand[] {
    const commands: SlashCommand[] = []

    for (const server of mcpServers) {
        if (server.status !== "connected" || !server.prompts) {
            continue
        }

        for (const prompt of server.prompts) {
            commands.push({
                name: `${server.name}:${prompt.name}`,
                description: prompt.description || prompt.title || `MCP prompt from ${server.name}`,
                section: "mcp",
            })
        }
    }

    return commands
}

/** Capability state the slash menu reads its entries and labels from. */
export interface SlashCommandSources {
    readonly localWorkflowToggles?: Record<string, boolean>
    readonly globalWorkflowToggles?: Record<string, boolean>
    readonly remoteWorkflowToggles?: Record<string, boolean>
    readonly remoteWorkflows?: GlobalInstructionsFile[]
    readonly mcpServers?: McpServer[]
    readonly localSkillsToggles?: Record<string, boolean>
    readonly globalSkillsToggles?: Record<string, boolean>
    readonly remoteSkills?: GlobalInstructionsFile[]
    readonly remoteSkillsToggles?: Record<string, boolean>
    readonly workflowDescriptions?: Record<string, string>
    readonly availableSkillCommands?: SlashCommand[]
}

/**
 * The trigger a menu row writes for a command, sigil included: the command's
 * name in its section's namespace, spelled by the shared namespace rules.
 */
export function slashCommandTrigger(command: SlashCommand): string {
    return command.section === undefined
        ? `/${command.name}`
        : namespacedCommandTrigger(SECTION_NAMESPACE[sectionOf(command)], command.name)
}

/** One slash menu row: what it shows, and the catalog entity a pick asks for. */
export interface SlashMenuEntry {
    /** Label, description and section shown in the menu. */
    readonly command: SlashCommand
    readonly section: SlashMenuSection
    /** Catalog identity of the command. */
    readonly commandId: string
    /** Spelling the pick writes; unique within the menu, so it also keys the row. */
    readonly trigger: string
}

/**
 * Every command the slash menu may offer, grouped by section in menu order.
 *
 * Capability toggles say what the user enabled and supply labels, but the
 * catalog decides what exists: an entry whose trigger the catalog does not
 * resolve would be inserted and then sent as plain text, so it is never
 * offered. Sources that list the same command twice yield one row.
 */
export function getAvailableSlashCommands(sources: SlashCommandSources, catalog: InputSemanticCatalog): SlashMenuEntry[] {
    const candidates = [
        ...DEFAULT_SLASH_COMMANDS,
        ...getWorkflowCommands(
            sources.localWorkflowToggles ?? {},
            sources.globalWorkflowToggles ?? {},
            sources.remoteWorkflowToggles,
            sources.remoteWorkflows,
            sources.workflowDescriptions,
        ),
        ...getSkillCommands(
            sources.localSkillsToggles,
            sources.globalSkillsToggles,
            sources.remoteSkills,
            sources.remoteSkillsToggles,
            sources.availableSkillCommands,
        ),
        ...getMcpPromptCommands(sources.mcpServers),
    ]
    const triggers = indexCommandTriggers(catalog)
    const entries = new Map<string, SlashMenuEntry>()
    for (const command of candidates) {
        const trigger = slashCommandTrigger(command)
        const descriptor = triggers.get(trigger)
        if (!descriptor || entries.has(trigger)) continue
        entries.set(trigger, { command, section: sectionOf(command), commandId: descriptor.id, trigger })
    }
    const rank = (entry: SlashMenuEntry) => SLASH_MENU_SECTIONS.indexOf(entry.section)
    return [...entries.values()].sort((left, right) => rank(left) - rank(right))
}

/**
 * Menu rows offered for a partial name, matched by case-insensitive prefix of
 * the name or of the namespaced trigger, so `/li` and `/skills:li` both find
 * `/skills:lint`.
 *
 * Matching is a search convenience only; the pick writes the row's exact
 * trigger, so admission still sees the case-sensitive form.
 */
export function getMatchingSlashCommands(query: string, entries: readonly SlashMenuEntry[]): SlashMenuEntry[] {
    if (!query) return [...entries]
    const needle = query.toLowerCase()
    return entries.filter(
        (entry) => entry.command.name.toLowerCase().startsWith(needle) || entry.trigger.slice(1).toLowerCase().startsWith(needle),
    )
}
