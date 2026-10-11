import { CLINE_MCP_TOOL_IDENTIFIER, type McpServer } from "../../../shared/mcp"
import { DlineDefaultTool } from "../../../shared/tools"
import type { PromptProfile } from "../profiles/types"
import type { ProfileToolSpec } from "./profile-tool-set"

/** Returns an MCP JSON schema as an opaque immutable provider boundary value. */
function readSchema(inputSchema: object | undefined): object {
    return inputSchema ?? { type: "object", properties: {} }
}

/** Converts one enabled MCP server to canonical opaque tool descriptors. */
export function createMcpToolSpecs(profile: PromptProfile, server: McpServer): readonly ProfileToolSpec[] {
    return (server.tools ?? []).flatMap((tool) => {
        const name = `${server.uid ?? server.name}${CLINE_MCP_TOOL_IDENTIFIER}${tool.name}`
        if (name.length > 64) return []
        const inputSchema = readSchema(tool.inputSchema)
        return [
            {
                profile,
                transport: "native",
                id: DlineDefaultTool.MCP_USE,
                name,
                description: `${server.name}: ${tool.description ?? tool.name}`,
                inputSchema,
            },
        ]
    })
}
