import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"

export type ClineTool = OpenAITool | AnthropicTool | GoogleTool

// Define available tool ids
export enum ClineDefaultTool {
    ASK = "ask_followup_question",
    ATTEMPT = "attempt_completion",
    BASH = "execute_command",
    KILL_COMMAND = "kill_command",
    FILE_EDIT = "replace_in_file",
    FILE_READ = "read_file",
    FILE_NEW = "write_to_file",
    SEARCH = "search_files",
    LIST_FILES = "list_files",
    LIST_CODE_DEF = "list_code_definition_names",
    BROWSER = "browser_action",
    MCP_USE = "use_mcp_tool",
    MCP_ACCESS = "access_mcp_resource",
    MCP_DOCS = "load_mcp_documentation",
    NEW_TASK = "new_task",
    MAKE_PLAN = "make_plan",
    ACT_MODE = "act_mode_respond",
    QNA_RESPOND = "qna_respond",
    GENERATE_REPORT = "generate_report",
    TODO = "focus_chain",
    WEB_FETCH = "web_fetch",
    WEB_SEARCH = "web_search",
    CONDENSE = "condense",
    SUMMARIZE_TASK = "summarize_task",
    REPORT_BUG = "report_bug",
    NEW_RULE = "new_rule",
    APPLY_PATCH = "apply_patch",
    GENERATE_EXPLANATION = "generate_explanation",
    LOAD_MCP = "load_mcp",
    LOAD_SKILL = "load_skill",
    LOAD_WORKFLOW = "load_workflow",
    USE_SUBAGENT = "use_subagent",
    USE_SUBAGENTS = "use_subagents",
    SPAWN_TASK = "spawn_task",
    CHANGE_TODO_LIST = "change_todo_list",
    FIND_REFERENCES = "find_references",
    RENAME = "rename",
    REPLACE_TEXT = "replace_text",
    STATUS_UPDATE = "status_update",
    GENERATE_IMAGE = "generate_image",
}

// Array of all tool names for compatibility
// Automatically generated from the enum values
export const toolUseNames = Object.values(ClineDefaultTool) as ClineDefaultTool[]

const dynamicToolUseNamesByNamespace = new Map<string, Set<string>>()

export function setDynamicToolUseNames(namespace: string, names: string[]): void {
    dynamicToolUseNamesByNamespace.set(namespace, new Set(names.map((name) => name.trim()).filter(Boolean)))
}

export function getToolUseNames(): string[] {
    const defaults = [...toolUseNames]
    const dynamic = Array.from(dynamicToolUseNamesByNamespace.values()).flatMap((set) => Array.from(set))
    return Array.from(new Set([...defaults, ...dynamic]))
}

// Tools that are safe to run in parallel with the initial checkpoint commit
// These are tools that do not modify the workspace state
export const READ_ONLY_TOOLS = [
    ClineDefaultTool.LIST_FILES,
    ClineDefaultTool.FILE_READ,
    ClineDefaultTool.SEARCH,
    ClineDefaultTool.LIST_CODE_DEF,
    ClineDefaultTool.BROWSER,
    ClineDefaultTool.ASK,
    ClineDefaultTool.WEB_SEARCH,
    ClineDefaultTool.WEB_FETCH,
    ClineDefaultTool.LOAD_MCP,
    ClineDefaultTool.LOAD_SKILL,
    ClineDefaultTool.LOAD_WORKFLOW,
    ClineDefaultTool.FIND_REFERENCES,
] as const

/**
 * Conversational / TURN-END tools whose handler.execute() presents a UI interaction
 * and awaits user input via interactions.open(). These must be auto-approved so
 * BLOCK_EXECUTION_STARTED → EXECUTE_TOOL → handler.execute() fires.
 */
export const CONVERSATIONAL_TOOL_NAMES = new Set<ClineDefaultTool>([
    ClineDefaultTool.ATTEMPT,
    ClineDefaultTool.QNA_RESPOND,
    ClineDefaultTool.MAKE_PLAN,
    ClineDefaultTool.ACT_MODE,
    ClineDefaultTool.ASK,
    ClineDefaultTool.GENERATE_REPORT,
])
