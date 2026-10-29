import { StringRequest } from "@shared/proto/dline/common"
import { McpServers } from "@shared/proto/dline/mcp"
import { Logger } from "@/shared/services/Logger"
import { convertMcpServersToProtoMcpServers } from "../../../shared/proto-conversions/mcp/mcp-server-conversion"
import type { Controller } from "../index"

/**
 * Deletes an MCP server
 * @param controller The controller instance
 * @param request The delete server request
 * @returns The list of remaining MCP servers after deletion
 */
export async function deleteMcpServer(controller: Controller, request: StringRequest): Promise<McpServers> {
    try {
        // Call the RPC variant to delete the server and get updated server list
        await controller.mcpHub?.deleteServerRPC(request.value)
        const mcpServers = await controller.getLatestMcpServersForOwner()

        // Convert application types to protobuf types
        const protoServers = convertMcpServersToProtoMcpServers(mcpServers)

        return McpServers.create({ mcpServers: protoServers })
    } catch (error) {
        Logger.error(`Failed to delete MCP server: ${error}`)
        throw error
    }
}
