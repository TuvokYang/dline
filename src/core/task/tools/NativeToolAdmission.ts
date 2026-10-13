import { CLINE_MCP_TOOL_IDENTIFIER } from "@shared/mcp"
import { type ClineTool, DlineDefaultTool } from "@shared/tools"

const INTERNAL_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(["task_progress"])

/** Return the runtime name used to admit a provider-native tool call. */
export function normalizeNativeToolName(toolName: string): string {
    return toolName.includes(CLINE_MCP_TOOL_IDENTIFIER) ? DlineDefaultTool.MCP_USE : toolName
}

/** Internal native calls are protocol helpers, not ordinary user-facing tools. */
export function isInternalNativeToolName(toolName: string): boolean {
    return INTERNAL_NATIVE_TOOL_NAMES.has(toolName)
}

/** Read the function name one provider-native tool definition advertises, in any supported schema shape. */
export function readNativeToolName(tool: ClineTool): string | undefined {
    if ("function" in tool && typeof tool.function?.name === "string") return tool.function.name
    if ("name" in tool && typeof tool.name === "string") return tool.name
    return undefined
}

/** Whether a provider-native tool definition projects a connected MCP server's tool rather than a Dline tool. */
export function isMcpNativeTool(tool: ClineTool): boolean {
    return readNativeToolName(tool)?.includes(CLINE_MCP_TOOL_IDENTIFIER) === true
}

/** Extract the exact function names exposed to one provider request. */
export function getAdvertisedNativeToolNames(tools: readonly ClineTool[] | undefined): ReadonlySet<string> {
    const names = new Set<string>()
    for (const tool of tools ?? []) {
        const name = readNativeToolName(tool)
        if (typeof name === "string" && name.length > 0) {
            names.add(normalizeNativeToolName(name))
        }
    }
    return names
}
