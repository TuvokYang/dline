import type { Empty } from "@shared/proto/dline/common"
import { McpServers } from "@shared/proto/dline/mcp"
import { convertMcpServersToProtoMcpServers } from "@/shared/proto-conversions/mcp/mcp-server-conversion"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * RPC handler for getting the latest MCP servers
 * @param controller The controller instance
 * @param _request Empty request
 * @returns McpServers response with list of all MCP servers
 */
export async function getLatestMcpServers(controller: Controller, _request: Empty): Promise<McpServers> {
    try {
        const mcpServers = await controller.getLatestMcpServersForOwner()

        // Convert to proto format
        const protoServers = convertMcpServersToProtoMcpServers(mcpServers)

        return McpServers.create({ mcpServers: protoServers })
    } catch (error) {
        Logger.error("Error fetching latest MCP servers:", error)
        throw error
    }
}
