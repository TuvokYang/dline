import { CLINE_MCP_TOOL_IDENTIFIER } from "@shared/mcp"
import { ClineDefaultTool, type ClineTool } from "@shared/tools"

const INTERNAL_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(["task_progress"])

/** Return the runtime name used to admit a provider-native tool call. */
export function normalizeNativeToolName(toolName: string): string {
    return toolName.includes(CLINE_MCP_TOOL_IDENTIFIER) ? ClineDefaultTool.MCP_USE : toolName
}

/** Internal native calls are protocol helpers, not ordinary user-facing tools. */
export function isInternalNativeToolName(toolName: string): boolean {
    return INTERNAL_NATIVE_TOOL_NAMES.has(toolName)
}

/** Extract the exact function names exposed to one provider request. */
export function getAdvertisedNativeToolNames(tools: readonly ClineTool[] | undefined): ReadonlySet<string> {
    const names = new Set<string>()
    for (const tool of tools ?? []) {
        const name =
            "function" in tool && typeof tool.function?.name === "string"
                ? tool.function.name
                : "name" in tool && typeof tool.name === "string"
                  ? tool.name
                  : undefined
        if (typeof name === "string" && name.length > 0) {
            names.add(normalizeNativeToolName(name))
        }
    }
    return names
}
