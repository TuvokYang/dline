import { CLINE_MCP_TOOL_IDENTIFIER } from "@shared/mcp"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { materializeNativeToolCall } from "../DefaultProductionProviderService"

describe("native MCP tool materialization", () => {
    it("decodes the advertised MCP namespace into the canonical handler contract", () => {
        const tool = materializeNativeToolCall(
            `server-uid${CLINE_MCP_TOOL_IDENTIFIER}search_docs`,
            { query: "otel", limit: 5 },
            (key) => (key === "server-uid" ? "docs" : key),
        )

        expect(tool).toEqual({
            name: ClineDefaultTool.MCP_USE,
            params: {
                server_name: "docs",
                tool_name: "search_docs",
                arguments: JSON.stringify({ query: "otel", limit: 5 }),
            },
        })
    })

    it("keeps ordinary native tools unchanged", () => {
        expect(materializeNativeToolCall("read_file", { path: "README.md" })).toEqual({
            name: "read_file",
            params: { path: "README.md" },
        })
    })
})
