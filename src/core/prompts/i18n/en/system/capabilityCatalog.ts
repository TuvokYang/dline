// English capability-catalog prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    heading: "# Capabilities",
    nativeHeading: "# CAPABILITIES",
    mcpTitle: "MCP",
    skillsTitle: "Skills",
    workflowsTitle: "Workflows",
    subagentsTitle: "Subagents",
    subagentsGuidance:
        "Subagents delegate self-contained research or analysis to isolated workers with explicit tool and Skill visibility, preserving the main task's context and enabling parallel progress when subtasks are independent. Use `use_subagent` for one default or named subagent. Use `use_subagents` for one to five parallel default subtasks.",
    subagentsListIntroduction: "The Subagents available to the current task are listed below:",
    inputSchemaHeading: "Input Schema:",
    availableToolsHeading: "Available Tools",
    entry: "- `@NAME@`: @DESCRIPTION@",
    group: "## @TITLE@\n@GUIDANCE@\n\n@LIST_INTRODUCTION@\n@ENTRIES@",
}

export default prompts
