import { EmptyRequest } from "@shared/proto/dline/common"
import { McpMarketplaceCatalog } from "@shared/proto/dline/mcp"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

const subs = new Map<Controller, Set<StreamingResponseHandler<McpMarketplaceCatalog>>>()

export async function subscribeToMcpMarketplaceCatalog(
    controller: Controller,
    _request: EmptyRequest,
    responseStream: StreamingResponseHandler<McpMarketplaceCatalog>,
    requestId?: string,
): Promise<void> {
    let set = subs.get(controller)
    if (!set) {
        set = new Set()
        subs.set(controller, set)
    }
    set.add(responseStream)
    const cleanup = () => {
        const s = subs.get(controller)
        if (s) {
            s.delete(responseStream)
            if (s.size === 0) subs.delete(controller)
        }
    }
    if (requestId)
        getRequestRegistry().registerRequest(requestId, cleanup, { type: "mcp_marketplace_subscription" }, responseStream)
}

export async function sendMcpMarketplaceCatalogEvent(controller: Controller, catalog: McpMarketplaceCatalog): Promise<void> {
    const set = subs.get(controller)
    if (!set || set.size === 0) return
    const promises = Array.from(set).map(async (rs) => {
        try {
            await rs(catalog, false)
        } catch (e) {
            Logger.error("Error sending MCP marketplace catalog event:", e)
            set.delete(rs)
        }
    })
    await Promise.all(promises)
}
