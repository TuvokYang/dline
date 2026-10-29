/**
 * Metadata for a file-based slash command type (skill, workflow, rule).
 * Used by parseSlashCommands to locate and load content.
 */
export type SkillMeta = {
    name: string
    path: string
    enabled: boolean
    source: "project" | "global" | "remote"
}

export type WorkflowMeta = {
    name: string
    path: string
    enabled: boolean
}

export type RuleMeta = {
    name: string
    path: string
    enabled: boolean
}

/**
 * Context passed to parseSlashCommands containing name→path mappings
 * for all file-based slash command categories.
 * NOT persisted — generated fresh by refreshRules() on each call.
 */
export type SlashContext = {
    skill: Record<string, SkillMeta>
    workflow: Record<string, WorkflowMeta>
    rule: Record<string, RuleMeta>
}

/** Default descriptions for XML desc attribute, by command type. */
export const SLASH_TYPE_DESC: Record<string, string> = {
    skill: "Specialized instructions for a specific task",
    workflow: "A sequence of steps for a specific operation",
    rule: "Project-level rules and conventions",
    mcp: "Prompt from an MCP server",
}
