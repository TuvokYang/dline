/**
 * The registered tool-name catalog of canonical Usage facts (WS-111).
 *
 * A tool name reaches the wire only when it belongs to this catalog. Free text
 * never does: an MCP server name is chosen by the user, so it is folded into
 * {@link MCP_TOOL_CATEGORY} instead of being uploaded, and any other unknown
 * name is counted as unlisted rather than transmitted.
 *
 * The catalog mirrors `DlineDefaultTool`. It is written out here instead of
 * derived at runtime because the wire contract must not change just because a
 * tool was added or removed in a release: an old server would otherwise start
 * rejecting batches from a newer client.
 */

import { DlineDefaultTool } from "@shared/tools"
import { isRegisteredToolName, MCP_TOOL_CATEGORY, TOOL_NAME_PATTERN } from "../contracts/usageExecution"

/**
 * Tool names this client may report by name.
 *
 * `focus_chain` is absent on purpose: applying a checklist is not a tool block
 * that settles, and its effect is already described by `todos`.
 */
const CATALOG: ReadonlySet<string> = new Set<string>([
    DlineDefaultTool.ASK,
    DlineDefaultTool.ATTEMPT,
    DlineDefaultTool.BASH,
    DlineDefaultTool.KILL_COMMAND,
    DlineDefaultTool.FILE_EDIT,
    DlineDefaultTool.FILE_READ,
    DlineDefaultTool.FILE_NEW,
    DlineDefaultTool.SEARCH,
    DlineDefaultTool.LIST_FILES,
    DlineDefaultTool.LIST_CODE_DEF,
    DlineDefaultTool.BROWSER,
    DlineDefaultTool.MCP_USE,
    DlineDefaultTool.MCP_ACCESS,
    DlineDefaultTool.MCP_DOCS,
    DlineDefaultTool.NEW_TASK,
    DlineDefaultTool.MAKE_PLAN,
    DlineDefaultTool.WORKING_RESPOND,
    DlineDefaultTool.QNA_RESPOND,
    DlineDefaultTool.GENERATE_REPORT,
    DlineDefaultTool.WEB_FETCH,
    DlineDefaultTool.WEB_SEARCH,
    DlineDefaultTool.CONDENSE,
    DlineDefaultTool.SUMMARIZE_TASK,
    DlineDefaultTool.REPORT_BUG,
    DlineDefaultTool.NEW_RULE,
    DlineDefaultTool.APPLY_PATCH,
    DlineDefaultTool.GENERATE_EXPLANATION,
    DlineDefaultTool.LOAD_MCP,
    DlineDefaultTool.LOAD_SKILL,
    DlineDefaultTool.LOAD_WORKFLOW,
    DlineDefaultTool.USE_SUBAGENT,
    DlineDefaultTool.USE_SUBAGENTS,
    DlineDefaultTool.SPAWN_TASK,
    DlineDefaultTool.CHANGE_TODO_LIST,
    DlineDefaultTool.FIND_REFERENCES,
    DlineDefaultTool.RENAME,
    DlineDefaultTool.REPLACE_TEXT,
    DlineDefaultTool.PHASE_REPORT,
    DlineDefaultTool.GENERATE_IMAGE,
])

/**
 * The wire name of a settled tool block, or `undefined` when the block must be
 * counted as unlisted.
 *
 * Returning `undefined` is the honest answer for three different situations and
 * the caller treats all of them the same way:
 *
 * - the tool is one this contract does not name (a future or plugin tool);
 * - the name is not a well-formed wire identity;
 * - the caller could not resolve a name at all, which happens when a restored
 *   task can no longer read the invocation its block refers to.
 */
export function canonicalToolName(toolName: string | undefined): string | undefined {
    if (toolName === undefined) return undefined
    const normalized = toolName.trim().toLowerCase()
    if (normalized.length === 0) return undefined
    if (CATALOG.has(normalized)) return normalized
    // Every MCP server name is user-supplied, so only the category is reported.
    if (normalized.startsWith("mcp__") || normalized.startsWith("mcp/") || normalized.startsWith("mcp.")) {
        return MCP_TOOL_CATEGORY
    }
    // An unregistered but well-formed name still cannot be transmitted: the
    // reader would group two different tools under one identity after a rename.
    return undefined
}

/** Whether the catalog recognizes a name as a reportable wire identity. */
export function isCatalogToolName(toolName: string): boolean {
    return CATALOG.has(toolName) || toolName === MCP_TOOL_CATEGORY
}

/** Guard used by tests and validators that need the two rules to agree. */
export function assertCatalogMatchesPattern(): readonly string[] {
    return [...CATALOG, MCP_TOOL_CATEGORY].filter((name) => !isRegisteredToolName(name) || !TOOL_NAME_PATTERN.test(name))
}
