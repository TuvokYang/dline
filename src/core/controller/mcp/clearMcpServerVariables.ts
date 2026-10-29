import { StringRequest } from "@shared/proto/dline/common"
import { McpServers } from "@shared/proto/dline/mcp"
import { convertMcpServersToProtoMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Forgets the values saved for an MCP server's `${env:...}` references in its own
 * scope and reconnects it; a value that is still missing is asked for again.
 */
export async function clearMcpServerVariables(controller: Controller, request: StringRequest): Promise<McpServers> {
    try {
        await controller.mcpHub?.clearSavedVariablesRPC(request.value)
        const mcpServers = await controller.getLatestMcpServersForOwner()
        return McpServers.create({ mcpServers: convertMcpServersToProtoMcpServers(mcpServers) })
    } catch (error) {
        Logger.error(`Failed to clear saved variables for MCP server ${request.value}:`, error)
        throw error
    }
}
