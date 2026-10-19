import { describe, expect, it, vi } from "vitest"
import type { McpHub as McpHubInstance } from "../McpHub"
import type { McpConnection } from "../types"

vi.mock("@core/controller/mcp/subscribeToMcpServers", () => ({
    sendMcpServersUpdate: vi.fn(),
    subscribeToMcpServers: vi.fn(),
}))

const { McpHub } = await import("../McpHub")

type McpHubTestAccess = {
    promptCatalogChangeListeners: Set<() => void>
    notificationCallbacks: Set<(serverName: string, level: string, message: string) => void>
    fileWatchers: Map<string, unknown>
    workspaceMcpRegistry: { dispose(): Promise<void> }
    mcpOAuthManager: { dispose(): Promise<void> }
    promptCatalogSignature: string
    notifyPromptCatalogChanged(): void
    publishPromptCatalogIfChanged(): void
}

type McpHubStaticTestAccess = {
    _refCount: number
}

function getTestAccess(hub: McpHubInstance): McpHubTestAccess {
    return hub as unknown as McpHubTestAccess
}

function getStaticTestAccess(): McpHubStaticTestAccess {
    return McpHub as unknown as McpHubStaticTestAccess
}

function createHub(): McpHubInstance {
    const hub = Object.create(McpHub.prototype) as McpHubInstance
    getTestAccess(hub).promptCatalogChangeListeners = new Set()
    return hub
}

describe("McpHub prompt catalog events", () => {
    it("multicasts catalog changes independently from chat notification callbacks", () => {
        const hub = createHub()
        const first = vi.fn()
        const second = vi.fn()
        const unsubscribeFirst = hub.subscribeToPromptCatalogChanges(first)
        hub.subscribeToPromptCatalogChanges(second)

        getTestAccess(hub).notifyPromptCatalogChanged()
        unsubscribeFirst()
        getTestAccess(hub).notifyPromptCatalogChanged()

        expect(first).toHaveBeenCalledOnce()
        expect(second).toHaveBeenCalledTimes(2)
    })

    it("publishes only when the prompt-visible tool catalog signature changes", () => {
        const hub = createHub()
        const listener = vi.fn()
        hub.subscribeToPromptCatalogChanges(listener)
        hub.connections = [
            {
                server: {
                    name: "docs",
                    config: "{}",
                    status: "connected",
                    tools: [
                        {
                            name: "search",
                            description: "Search docs",
                            inputSchema: {
                                type: "object",
                                properties: { privateMarker: { type: "string" }, limit: { type: "number" } },
                            },
                        },
                    ],
                },
            } as unknown as McpConnection,
        ]
        const access = getTestAccess(hub)
        const server = hub.connections[0].server
        const tool = server.tools?.[0]
        if (!tool) throw new Error("Expected MCP test tool")

        access.publishPromptCatalogIfChanged()
        expect(access.promptCatalogSignature).not.toContain("privateMarker")
        server.error = "UI-only error"
        access.publishPromptCatalogIfChanged()
        tool.description = "  Search   docs  "
        access.publishPromptCatalogIfChanged()
        tool.inputSchema = {
            properties: { limit: { type: "number" }, privateMarker: { type: "string" } },
            type: "object",
        }
        access.publishPromptCatalogIfChanged()
        tool.inputSchema = {
            properties: { limit: { type: "integer" }, privateMarker: { type: "string" } },
            type: "object",
        }
        access.publishPromptCatalogIfChanged()
        server.uid = "new-native-tool-id"
        access.publishPromptCatalogIfChanged()
        tool.description = "Search project docs"
        access.publishPromptCatalogIfChanged()
        server.disabled = true
        access.publishPromptCatalogIfChanged()

        expect(listener).toHaveBeenCalledTimes(5)
    })

    it("clears prompt catalog listeners when the shared hub is fully disposed", async () => {
        const hub = createHub()
        const listener = vi.fn()
        hub.subscribeToPromptCatalogChanges(listener)
        getStaticTestAccess()._refCount = 1
        hub.connections = []
        const access = getTestAccess(hub)
        access.notificationCallbacks = new Set()
        access.fileWatchers = new Map()
        access.workspaceMcpRegistry = { dispose: vi.fn().mockResolvedValue(undefined) }
        access.mcpOAuthManager = { dispose: vi.fn().mockResolvedValue(undefined) }

        await hub.dispose()
        access.notifyPromptCatalogChanged()

        expect(listener).not.toHaveBeenCalled()
    })
})
