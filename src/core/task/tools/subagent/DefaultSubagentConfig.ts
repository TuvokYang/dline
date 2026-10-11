import { DlineDefaultTool } from "@shared/tools"
import type { AgentBaseConfig } from "./AgentConfigLoader"

export const DEFAULT_SUBAGENT_NAME = "default"
export const DEFAULT_SUBAGENT_FILE_NAME = "default.yml"

export const DEFAULT_SUBAGENT_ALLOWED_TOOLS: DlineDefaultTool[] = [
    DlineDefaultTool.FILE_READ,
    DlineDefaultTool.LIST_FILES,
    DlineDefaultTool.SEARCH,
    DlineDefaultTool.LIST_CODE_DEF,
    DlineDefaultTool.LOAD_SKILL,
    DlineDefaultTool.ATTEMPT,
]

export const DEFAULT_SUBAGENT_CONFIG: AgentBaseConfig = {
    name: DEFAULT_SUBAGENT_NAME,
    description: "Built-in readonly research subagent",
    tools: [...DEFAULT_SUBAGENT_ALLOWED_TOOLS],
    systemPrompt: "",
}

export const DEFAULT_SUBAGENT_YAML_CONTENT = `---
name: default
description: Built-in readonly research subagent
tools:
  - read_file
  - list_files
  - search_files
  - list_code_definition_names
  - load_skill
  - attempt_completion
skills: []
# maxOutputTokens is measured in tokens. Omit it for the dynamic 5% default,
# use 0.05 for a ratio, or use a positive integer such as 10240 for an absolute budget.
---
You are the default readonly research subagent. Explore the codebase, read relevant files, trace call chains, and report concise, actionable findings.
`

/** Check whether a requested subagent name selects the built-in profile. */
export function isDefaultSubagentName(name: string | undefined): boolean {
    return name?.trim().toLowerCase() === DEFAULT_SUBAGENT_NAME
}
