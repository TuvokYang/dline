import type { McpServer } from "../../../shared/mcp"
import { nativeMcpToolName } from "../../../shared/mcp-native-name"
import { DlineDefaultTool } from "../../../shared/tools"
import type { PromptProfile } from "../profiles/types"
import type { ProfileToolSpec } from "./profile-tool-set"

/** Returns an MCP JSON schema as an opaque immutable provider boundary value. */
function readSchema(inputSchema: object | undefined): object {
    return inputSchema ?? { type: "object", properties: {} }
}

/** Converts one enabled MCP server to canonical opaque tool descriptors. */
export function createMcpToolSpecs(profile: PromptProfile, server: McpServer): readonly ProfileToolSpec[] {
    return (server.tools ?? []).map((tool) => {
        const name = nativeMcpToolName(server.uid ?? server.name, tool.name)
        const inputSchema = readSchema(tool.inputSchema)
        return {
            profile,
            transport: "native",
            id: DlineDefaultTool.MCP_USE,
            name,
            description: `${server.name}: ${tool.description ?? tool.name}`,
            inputSchema,
        }
    })
}
