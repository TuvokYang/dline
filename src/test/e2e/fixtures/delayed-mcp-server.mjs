#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

const startupDelayMs = Number.parseInt(process.env.DLINE_E2E_MCP_STARTUP_DELAY_MS ?? "12000", 10)
await new Promise((resolve) => setTimeout(resolve, startupDelayMs))

const server = new McpServer({
    name: "dline-e2e-delayed",
    version: "1.0.0",
})

server.registerTool(
    "e2e_delayed_echo",
    {
        description: "E2E delayed MCP capability marker",
        inputSchema: { value: z.string() },
    },
    async ({ value }) => ({ content: [{ type: "text", text: value }] }),
)

await server.connect(new StdioServerTransport())
