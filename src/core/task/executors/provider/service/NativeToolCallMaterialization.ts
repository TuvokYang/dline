import type { ToolUse } from "@core/assistant-message"
import { CLINE_MCP_TOOL_IDENTIFIER } from "@shared/mcp"
import type { McpToolAddress } from "@shared/mcp-native-name"
import { DlineDefaultTool } from "@/shared/tools"
import { parsePartialToolInput } from "../../../tools/partial-tool-input"

/** Maps the two halves of a native MCP function name to the server and tool they address. */
export type McpToolResolver = (serverKey: string, toolSegment: string) => McpToolAddress

const identityMcpToolResolver: McpToolResolver = (serverKey, toolSegment) => ({ serverName: serverKey, toolName: toolSegment })

function parseArguments(value: unknown): Readonly<Record<string, unknown>> {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>
    if (typeof value !== "string" || value.trim().length === 0) return {}
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    } catch {
        return {}
    }
}

function toolParams(input: Readonly<Record<string, unknown>>): ToolUse["params"] {
    return Object.fromEntries(
        Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
    ) as ToolUse["params"]
}

/** Split a native MCP function name at its first separator; undefined for an ordinary tool name. */
function decodeNativeMcpToolName(name: string, resolveTool: McpToolResolver): McpToolAddress | undefined {
    const marker = name.indexOf(CLINE_MCP_TOOL_IDENTIFIER)
    if (marker < 0) return undefined
    return resolveTool(name.slice(0, marker), name.slice(marker + CLINE_MCP_TOOL_IDENTIFIER.length))
}

/** Decode the native MCP function namespace into the canonical use_mcp_tool contract. */
export function materializeNativeToolCall(
    name: string,
    argumentsValue: unknown,
    resolveTool: McpToolResolver = identityMcpToolResolver,
): Pick<ToolUse, "name" | "params"> {
    const parsedArguments = parseArguments(argumentsValue)
    const address = decodeNativeMcpToolName(name, resolveTool)
    if (!address) return { name: name as ToolUse["name"], params: toolParams(parsedArguments) }
    return {
        name: DlineDefaultTool.MCP_USE,
        params: {
            server_name: address.serverName,
            tool_name: address.toolName,
            arguments: JSON.stringify(parsedArguments),
        },
    }
}

/** Materialize the display-safe portion of an incomplete native tool call. */
export function materializePartialNativeToolCall(
    name: string,
    argumentsValue: unknown,
    resolveTool: McpToolResolver = identityMcpToolResolver,
): Pick<ToolUse, "name" | "params"> {
    const input = parsePartialToolInput(argumentsValue)
    const address = decodeNativeMcpToolName(name, resolveTool)
    if (!address) return { name: name as ToolUse["name"], params: toolParams(input) }
    return {
        name: DlineDefaultTool.MCP_USE,
        params: {
            server_name: address.serverName,
            tool_name: address.toolName,
            arguments: JSON.stringify(input),
        },
    }
}
