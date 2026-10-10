import { McpServerSource } from "@shared/proto/dline/mcp"
import { describe, expect, it } from "vitest"
import { convertMcpServersToProtoMcpServers, convertProtoMcpServersToMcpServers } from "../mcp-server-conversion"

describe("MCP server source metadata conversion", () => {
    it("preserves workspace source and display metadata across the proto bridge", () => {
        const source = {
            name: "docs@aaaaaaaa",
            displayName: "docs",
            description: "Workspace docs",
            source: "workspace" as const,
            config: JSON.stringify({ type: "stdio", command: "node", env: { API_TOKEN: "$" + "{env:DOCS_TOKEN}" } }),
            status: "connected" as const,
        }

        const [proto] = convertMcpServersToProtoMcpServers([source])
        expect(proto.source).toBe(McpServerSource.MCP_SERVER_SOURCE_WORKSPACE)
        expect(proto.displayName).toBe("docs")
        expect(proto.description).toBe("Workspace docs")

        const [roundTripped] = convertProtoMcpServersToMcpServers([proto])
        expect(roundTripped).toMatchObject(source)
    })

    it("maps legacy proto messages without source metadata to settings", () => {
        const [server] = convertProtoMcpServersToMcpServers([
            {
                name: "global",
                config: "{}",
                status: 0,
                tools: [],
                resources: [],
                resourceTemplates: [],
                prompts: [],
                source: McpServerSource.MCP_SERVER_SOURCE_SETTINGS,
            },
        ])
        expect(server.source).toBe("settings")
        expect(server.displayName).toBeUndefined()
    })
})
