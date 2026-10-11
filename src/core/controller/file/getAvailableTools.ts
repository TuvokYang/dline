import { isForbiddenSubagentTool, REQUIRED_SUBAGENT_TOOL } from "@core/task/tools/subagent/subagent-tool-policy"
import { AvailableToolsResponse, ToolGroup, ToolInfo } from "@shared/proto/dline/file"
import { DlineDefaultTool } from "@shared/tools"
import type { Controller } from ".."

/**
 * Tool descriptions for subagent configuration UI.
 * Only includes tools that are safe and relevant for subagents.
 */
const TOOL_DESCRIPTIONS: Record<string, { description: string; isReadOnly: boolean }> = {
    [DlineDefaultTool.FILE_READ]: { description: "Read file contents", isReadOnly: true },
    [DlineDefaultTool.SEARCH]: { description: "Search files using regex", isReadOnly: true },
    [DlineDefaultTool.LIST_FILES]: { description: "List directory contents", isReadOnly: true },
    [DlineDefaultTool.LIST_CODE_DEF]: { description: "List code definitions", isReadOnly: true },
    [DlineDefaultTool.BROWSER]: { description: "Browser automation", isReadOnly: true },
    [DlineDefaultTool.WEB_FETCH]: { description: "Fetch web content", isReadOnly: true },
    [DlineDefaultTool.WEB_SEARCH]: { description: "Search the web", isReadOnly: true },
    [DlineDefaultTool.LOAD_SKILL]: { description: "Load Skill instructions", isReadOnly: true },
    [DlineDefaultTool.MCP_USE]: { description: "Use an MCP tool", isReadOnly: true },
    [DlineDefaultTool.MCP_ACCESS]: { description: "Access an MCP resource", isReadOnly: true },
    [DlineDefaultTool.MCP_DOCS]: { description: "Load MCP documentation", isReadOnly: true },
    [DlineDefaultTool.GENERATE_EXPLANATION]: { description: "Generate diff explanation", isReadOnly: true },
    [DlineDefaultTool.FIND_REFERENCES]: { description: "Find symbol references", isReadOnly: true },
    [DlineDefaultTool.GENERATE_IMAGE]: { description: "Generate or edit task image artifacts", isReadOnly: false },
    [DlineDefaultTool.FILE_NEW]: { description: "Write a new file", isReadOnly: false },
    [DlineDefaultTool.FILE_EDIT]: { description: "Edit an existing file", isReadOnly: false },
    [DlineDefaultTool.BASH]: { description: "Execute CLI commands", isReadOnly: false },
    [DlineDefaultTool.ATTEMPT]: { description: "Complete the task", isReadOnly: false },
    [DlineDefaultTool.APPLY_PATCH]: { description: "Apply a unified diff patch", isReadOnly: false },
    [DlineDefaultTool.SPAWN_TASK]: { description: "Spawn a new task", isReadOnly: false },
    [DlineDefaultTool.CHANGE_TODO_LIST]: { description: "Change the TODO list", isReadOnly: false },
    [DlineDefaultTool.RENAME]: { description: "Rename a symbol", isReadOnly: false },
    [DlineDefaultTool.REPLACE_TEXT]: { description: "Replace text across files", isReadOnly: false },
}

/**
 * Tools excluded from subagent configuration (internal/system tools).
 *
 * Turn-ending tools are not listed here: they are excluded by the shared
 * subagent tool policy, so this set holds only the internal tools that policy
 * does not already cover. Restating them here is what let this list drift.
 */
const EXCLUDED_TOOLS = new Set([
    DlineDefaultTool.TODO,
    DlineDefaultTool.CONDENSE,
    DlineDefaultTool.SUMMARIZE_TASK,
    DlineDefaultTool.REPORT_BUG,
    DlineDefaultTool.NEW_RULE,
    DlineDefaultTool.WORKING_RESPOND,
    DlineDefaultTool.LEGACY_ACT_MODE_RESPOND,
    DlineDefaultTool.PHASE_REPORT,
    DlineDefaultTool.LEGACY_STATUS_UPDATE,
])

/**
 * Returns available tools grouped by category for subagent configuration UI.
 * Tools are dynamically generated from DlineDefaultTool enum to stay in sync.
 */
export async function getAvailableTools(_controller: Controller): Promise<AvailableToolsResponse> {
    const readOnlyGroup: ToolInfo[] = []
    const writeGroup: ToolInfo[] = []

    for (const toolName of Object.values(DlineDefaultTool)) {
        if (EXCLUDED_TOOLS.has(toolName)) continue
        // A turn-ending tool hands control back to a user the subagent does not
        // have, so offering it would produce a subagent that cannot progress.
        if (isForbiddenSubagentTool(toolName)) continue

        const info = TOOL_DESCRIPTIONS[toolName]
        if (!info) continue

        const toolInfo = ToolInfo.create({
            name: toolName,
            description: info.description,
            isReadOnly: info.isReadOnly,
            required: toolName === REQUIRED_SUBAGENT_TOOL,
        })

        if (info.isReadOnly) {
            readOnlyGroup.push(toolInfo)
        } else {
            writeGroup.push(toolInfo)
        }
    }

    return AvailableToolsResponse.create({
        groups: [
            ToolGroup.create({
                name: "Read-only",
                description: "Safe tools that do not modify files or execute commands",
                tools: readOnlyGroup,
            }),
            ToolGroup.create({
                name: "Write",
                description: "⚠️ Tools that can modify files or execute commands — use with caution",
                tools: writeGroup,
            }),
        ],
    })
}
