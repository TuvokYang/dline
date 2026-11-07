#!/usr/bin/env node

// WS126 subagent capability selection fixture.
// It exposes one selected tool/resource pair plus real-but-unselected ones that
// must never reach the child, so tests can assert a true negative oracle.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

const server = new McpServer({
    name: "ws126-capability-resource-fixture",
    version: "1.0.0",
})

server.registerTool(
    "e2e_ws126_echo",
    {
        description: "Echo selected input",
        inputSchema: { value: z.string() },
    },
    async ({ value }) => ({ content: [{ type: "text", text: value }] }),
)

server.registerTool(
    "e2e_ws126_unselected",
    {
        description: "A real tool excluded from the child selection",
        inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: "E2E_WS126_SECRET_TOOL_BODY" }] }),
)

// The selected URI ends with `/Guide`; the unselected one differs only by case
// (`/guide`), so case-insensitive matching would leak the secret resource body.
server.registerResource(
    "upper-guide",
    "ws126-fixture://repo/Guide",
    { description: "Selected guide", mimeType: "text/plain" },
    async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/plain", text: "E2E_WS126_UPPER_RESOURCE_BODY" }],
    }),
)

server.registerResource(
    "lower-guide",
    "ws126-fixture://repo/guide",
    { description: "Unselected case-distinct guide", mimeType: "text/plain" },
    async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/plain", text: "E2E_WS126_LOWER_SECRET_RESOURCE_BODY" }],
    }),
)

await server.connect(new StdioServerTransport())
