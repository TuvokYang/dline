import { EmptyRequest } from "@shared/proto/dline/common"
import { McpServers } from "@shared/proto/dline/mcp"
import { convertMcpServersToProtoMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Per-controller subscription sets to isolate MCP server updates between
// independent webviews. When a controller is disposed its subscribers
// are removed so dead streams don't accumulate in the global set.
const controllerSubscriptions = new Map<Controller, Set<StreamingResponseHandler<McpServers>>>()

/**
 * Subscribe to MCP servers events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToMcpServers(
    controller: Controller,
    _request: EmptyRequest,
    responseStream: StreamingResponseHandler<McpServers>,
    requestId?: string,
): Promise<void> {
    // Add this subscription under the owning controller
    let subs = controllerSubscriptions.get(controller)
    if (!subs) {
        subs = new Set()
        controllerSubscriptions.set(controller, subs)
    }
    subs.add(responseStream)

    // Register cleanup when the connection is closed
    const cleanup = () => {
        const set = controllerSubscriptions.get(controller)
        if (set) {
            set.delete(responseStream)
            if (set.size === 0) {
                controllerSubscriptions.delete(controller)
            }
        }
    }

    // Register the cleanup function with the request registry if we have a requestId
    if (requestId) {
        getRequestRegistry().registerRequest(requestId, cleanup, { type: "mcpServers_subscription" }, responseStream)
    }

    // Send initial state if available
    if (controller.mcpHub) {
        const mcpServers = await controller.getLatestMcpServersForOwner()
        if (mcpServers.length > 0) {
            try {
                const protoServers = McpServers.create({
                    mcpServers: convertMcpServersToProtoMcpServers(mcpServers),
                })
                await responseStream(
                    protoServers,
                    false, // Not the last message
                )
            } catch (error) {
                Logger.error("Error sending initial MCP servers:", error)
                const set = controllerSubscriptions.get(controller)
                if (set) {
                    set.delete(responseStream)
                    if (set.size === 0) controllerSubscriptions.delete(controller)
                }
            }
        }
    }
}

/**
 * Send an MCP servers update to all active subscribers
 * @param mcpServers The MCP servers to send
 */
export async function sendMcpServersUpdate(): Promise<void> {
    // Build an owner-scoped payload for each controller so workspace descriptors do not leak across panels.
    const promises: Promise<void>[] = []
    for (const [controller, subs] of controllerSubscriptions) {
        const mcpServers = McpServers.create({
            mcpServers: convertMcpServersToProtoMcpServers(controller.getMcpServersForOwner()),
        })
        for (const responseStream of subs) {
            promises.push(
                responseStream(mcpServers, false).catch((error) => {
                    Logger.error("Error sending MCP servers update:", error)
                    // Remove the dead stream from whichever controller owns it
                    for (const [ctrl, set] of controllerSubscriptions) {
                        if (set.delete(responseStream)) {
                            if (set.size === 0) controllerSubscriptions.delete(ctrl)
                            break
                        }
                    }
                }),
            )
        }
    }
    await Promise.all(promises)
}

/**
 * Remove all subscriptions belonging to a specific controller.
 * Called from Controller.dispose() to prevent dead streams from
 * accumulating in the global subscription set.
 */
export function cleanupMcpSubscriptions(controller: Controller): void {
    controllerSubscriptions.delete(controller)
}
