import type { McpServer } from "@shared/mcp"
import { EmptyRequest } from "@shared/proto/dline/common"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../../index"
import { cleanupMcpSubscriptions, sendMcpServersUpdate, subscribeToMcpServers } from "../subscribeToMcpServers"

describe("MCP server subscription updates", () => {
    const controllers: Controller[] = []

    afterEach(() => {
        for (const controller of controllers.splice(0)) cleanupMcpSubscriptions(controller)
    })

    it("pushes the registered owner snapshot without waiting for workspace registration", async () => {
        const server = {
            name: "workspace-docs@aaaaaaaa",
            config: "{}",
            status: "connected",
            disabled: false,
            source: "workspace",
        } as McpServer
        const controller = {
            mcpHub: undefined,
            getMcpServersForOwner: vi.fn(() => [server]),
            getLatestMcpServersForOwner: vi.fn(async () => {
                throw new Error("subscription updates must not wait for workspace registration")
            }),
        } as unknown as Controller
        controllers.push(controller)
        const responseStream = vi.fn(async () => undefined)

        await subscribeToMcpServers(controller, EmptyRequest.create({}), responseStream)
        await sendMcpServersUpdate()

        expect(controller.getMcpServersForOwner).toHaveBeenCalledOnce()
        expect(controller.getLatestMcpServersForOwner).not.toHaveBeenCalled()
        expect(responseStream).toHaveBeenCalledWith(
            expect.objectContaining({
                mcpServers: [expect.objectContaining({ name: server.name, disabled: false })],
            }),
            false,
        )
    })
})
