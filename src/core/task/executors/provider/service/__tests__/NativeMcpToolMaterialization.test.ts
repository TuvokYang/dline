import { CLINE_MCP_TOOL_IDENTIFIER } from "@shared/mcp"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { materializeNativeToolCall } from "../DefaultProductionProviderService"

describe("native MCP tool materialization", () => {
    it("decodes the advertised MCP namespace into the canonical handler contract", () => {
        const tool = materializeNativeToolCall(
            `server-uid${CLINE_MCP_TOOL_IDENTIFIER}search_docs`,
            { query: "otel", limit: 5 },
            (serverKey, toolSegment) => ({ serverName: serverKey === "server-uid" ? "docs" : serverKey, toolName: toolSegment }),
        )

        expect(tool).toEqual({
            name: DlineDefaultTool.MCP_USE,
            params: {
                server_name: "docs",
                tool_name: "search_docs",
                arguments: JSON.stringify({ query: "otel", limit: 5 }),
            },
        })
    })

    it("lets the resolver restore a tool that travels under a hashed segment", () => {
        const tool = materializeNativeToolCall(`docs${CLINE_MCP_TOOL_IDENTIFIER}_0123abcd`, {}, (serverKey, toolSegment) => ({
            serverName: serverKey,
            toolName: toolSegment === "_0123abcd" ? "a_tool_name_too_long_for_the_provider" : toolSegment,
        }))

        expect(tool.params).toMatchObject({ server_name: "docs", tool_name: "a_tool_name_too_long_for_the_provider" })
    })

    it("keeps ordinary native tools unchanged", () => {
        expect(materializeNativeToolCall("read_file", { path: "README.md" })).toEqual({
            name: "read_file",
            params: { path: "README.md" },
        })
    })
})
