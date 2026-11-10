import { describe, expect, it } from "vitest"
import type { UiMessage } from "../ExtensionMessage"
import { parseMcpServerResponse, parseMcpToolRequest } from "./mcpResponseRows"

const structured = (status: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "mcp_server_response", requestTs: 42, responses: ["result"], ...status })

describe("MCP response presentation", () => {
    it.each([true, false])("preserves the explicit boolean status %s", (isError) => {
        expect(parseMcpServerResponse(structured({ isError }))).toEqual({ requestTs: 42, responses: ["result"], isError })
    })

    it("keeps legacy structured and plain-text responses without inventing a status", () => {
        expect(parseMcpServerResponse(structured())).toEqual({ requestTs: 42, responses: ["result"] })
        expect(parseMcpServerResponse("Error: quoted example")).toEqual({ responses: ["Error: quoted example"] })
    })

    it.each(["true", 1, null])("does not coerce malformed status %s into a failure", (isError) => {
        expect(parseMcpServerResponse(structured({ isError }))).toEqual({ requestTs: 42, responses: ["result"] })
    })

    it("identifies only tool requests, not resources or response rows", () => {
        const request: UiMessage = {
            ts: 42,
            type: "say",
            say: "use_mcp_server",
            text: JSON.stringify({ type: "use_mcp_tool", serverName: "docs", toolName: "search" }),
        }
        expect(parseMcpToolRequest(request)).toEqual({ serverName: "docs", toolName: "search" })
        expect(
            parseMcpToolRequest({ ...request, text: JSON.stringify({ type: "access_mcp_resource", serverName: "docs" }) }),
        ).toBeUndefined()
        expect(parseMcpToolRequest({ ...request, say: "mcp_server_response" })).toBeUndefined()
        expect(parseMcpToolRequest({ ...request, text: "{" })).toBeUndefined()
    })
})
