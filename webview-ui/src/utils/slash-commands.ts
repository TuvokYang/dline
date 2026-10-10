import type { McpServer } from "@shared/mcp"
import { PLATFORM_CONFIG, PlatformType } from "@/config/platform.config"
import {
    getBuiltInSlashCommands,
    pathToCommandName,
    pathToSkillName,
    type SlashCommand,
} from "../../../src/shared/slashCommands.ts"

export type { SlashCommand }

/**
 * Map section to prefix used when inserting the command into the input.
 * "default" → "cmd", "workflow" → "workflow", "skill" → "skills", "mcp" → "mcp"
 */
export function sectionToPrefix(section?: string): string {
    switch (section) {
        case "default":
            return "cmd"
        case "workflow":
            return "workflow"
        case "skill":
            return "skills"
        case "mcp":
            return "mcp"
        default:
            return ""
    }
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

// Regex for detecting slash commands in text
// Must be at start of string OR preceded by whitespace to avoid matching URLs/paths
// e.g., matches "/newtask" or "text /newtask" but not "http://example.com/newtask"
// Note: Colons are allowed to support MCP prompt commands like /mcp:server:prompt
export const slashCommandRegex = /(^|\s)(\/[a-zA-Z0-9_.:@-]+)(?=\s|$)/
export const slashCommandRegexGlobal = new RegExp(slashCommandRegex.source, "g")
// Regex for detecting a slash command at the end of text (for deletion)
// Must be at start OR preceded by whitespace, captures the whole command including slash
export const slashCommandDeleteRegex = /(^|\s)(\/[a-zA-Z0-9_.:@-]+)$/

/**
 * Removes a slash command at the cursor position
 */
export function removeSlashCommand(text: string, position: number): { newText: string; newPosition: number } {
    const beforeCursor = text.slice(0, position)
    const afterCursor = text.slice(position)

    // Check if we're at the end of a slash command (anywhere in text, not just at start)
    const matchEnd = beforeCursor.match(slashCommandDeleteRegex)

    if (matchEnd) {
        // matchEnd[1] is the whitespace or empty string before the slash
        // matchEnd[2] is the slash command (e.g., "/newtask")
        const slashCommand = matchEnd[2]
        const newText = text.slice(0, position - slashCommand.length) + afterCursor.replace(" ", "") // removes the first space after the command
        const newPosition = position - slashCommand.length
        return { newText, newPosition }
    }

    // If we're not at the end of a slash command, just return the original text and position
    return { newText: text, newPosition: position }
}

/**
 * Determines whether the slash command menu should be displayed based on text input.
 * Only shows for the FIRST valid slash command position in the message - subsequent
 * slash commands won't trigger suggestions since only one is processed per message.
 */
export function shouldShowSlashCommandsMenu(text: string, cursorPosition: number): boolean {
    const beforeCursor = text.slice(0, cursorPosition)

    // first check if there is a slash before the cursor
    const slashIndex = beforeCursor.lastIndexOf("/")

    if (slashIndex === -1) {
        return false
    }

    // Check if slash is preceded by whitespace or is at the beginning
    // This allows slash commands anywhere in the message, similar to @ mentions
    const charBeforeSlash = slashIndex > 0 ? beforeCursor[slashIndex - 1] : null
    if (charBeforeSlash !== null && !/\s/.test(charBeforeSlash)) {
        return false
    }

    // potential partial or full command
    const textAfterSlash = beforeCursor.slice(slashIndex + 1)

    // don't show menu if there's whitespace after the slash but before the cursor
    if (/\s/.test(textAfterSlash)) {
        return false
    }

    // Only show suggestions for the FIRST slash command in the message.
    // Check if there's already a valid slash command earlier in the text.
    // A valid earlier slash command is one that: starts at beginning or after whitespace,
    // and is followed by whitespace (meaning it's complete).
    // Note: Colons are allowed to support MCP prompt commands like /mcp:server:prompt
    const firstSlashCommandRegex = /(^|\s)\/[a-zA-Z0-9_.:@-]+\s/
    const textBeforeCurrentSlash = text.slice(0, slashIndex)
    if (firstSlashCommandRegex.test(textBeforeCurrentSlash)) {
        return false
    }

    return true
}

/**
 * Gets filtered slash commands that match the current input
 */
export function getMatchingSlashCommands(
    query: string,
    localWorkflowToggles: Record<string, boolean> = {},
    globalWorkflowToggles: Record<string, boolean> = {},
    remoteWorkflowToggles?: Record<string, boolean>,
    remoteWorkflows?: any[],
    mcpServers: McpServer[] = [],
    localSkillsToggles: Record<string, boolean> = {},
    globalSkillsToggles: Record<string, boolean> = {},
    remoteSkills?: any[],
    remoteSkillsToggles?: Record<string, boolean>,
    workflowDescriptions?: Record<string, string>,
    availableSkillCommands?: SlashCommand[],
): SlashCommand[] {
    const workflowCommands = getWorkflowCommands(
        localWorkflowToggles,
        globalWorkflowToggles,
        remoteWorkflowToggles,
        remoteWorkflows,
        workflowDescriptions,
    )
    const skillCommands = getSkillCommands(
        localSkillsToggles,
        globalSkillsToggles,
        remoteSkills,
        remoteSkillsToggles,
        availableSkillCommands,
    )
    const mcpPromptCommands = getMcpPromptCommands(mcpServers)
    const allCommands = [...DEFAULT_SLASH_COMMANDS, ...workflowCommands, ...skillCommands, ...mcpPromptCommands]

    if (!query) {
        return allCommands
    }

    // filter commands that start with the query (case insensitive)
    return allCommands.filter((cmd) => cmd.name.toLowerCase().startsWith(query.toLowerCase()))
}

/**
 * Insert a slash command at position or replace partial command
 */
export function insertSlashCommand(
    text: string,
    commandName: string,
    partialCommandLength: number,
    cursorPosition: number,
): { newValue: string; commandIndex: number } {
    // Find the slash nearest to cursor (before cursor position)
    const beforeCursor = text.slice(0, cursorPosition)
    const slashIndex = beforeCursor.lastIndexOf("/")

    const beforeSlash = text.substring(0, slashIndex + 1)
    const afterPartialCommand = text.substring(slashIndex + 1 + partialCommandLength)

    // replace the partial command with the full command
    const newValue =
        beforeSlash + commandName + (afterPartialCommand.startsWith(" ") ? afterPartialCommand : ` ${afterPartialCommand}`)

    return { newValue, commandIndex: slashIndex }
}

/**
 * Determines the validation state of a slash command
 * Returns partial if we have a partial match against valid commands, or full for full match
 */
export function validateSlashCommand(
    command: string,
    localWorkflowToggles: Record<string, boolean> = {},
    globalWorkflowToggles: Record<string, boolean> = {},
    remoteWorkflowToggles?: Record<string, boolean>,
    remoteWorkflows?: any[],
    mcpServers: McpServer[] = [],
    localSkillsToggles: Record<string, boolean> = {},
    globalSkillsToggles: Record<string, boolean> = {},
    remoteSkills?: any[],
    remoteSkillsToggles?: Record<string, boolean>,
    workflowDescriptions?: Record<string, string>,
    availableSkillCommands?: SlashCommand[],
): "full" | "partial" | null {
    if (!command) {
        return null
    }

    const workflowCommands = getWorkflowCommands(
        localWorkflowToggles,
        globalWorkflowToggles,
        remoteWorkflowToggles,
        remoteWorkflows,
        workflowDescriptions,
    )
    const skillCommands = getSkillCommands(
        localSkillsToggles,
        globalSkillsToggles,
        remoteSkills,
        remoteSkillsToggles,
        availableSkillCommands,
    )
    const mcpPromptCommands = getMcpPromptCommands(mcpServers)
    const allCommands = [...DEFAULT_SLASH_COMMANDS, ...workflowCommands, ...skillCommands, ...mcpPromptCommands]

    // case insensitive matching
    const exactMatch = allCommands.some((cmd) => cmd.name.toLowerCase() === command.toLowerCase())

    if (exactMatch) {
        return "full"
    }

    const partialMatch = allCommands.some((cmd) => cmd.name.toLowerCase().startsWith(command.toLowerCase()))

    if (partialMatch) {
        return "partial"
    }

    return null // no match
}
