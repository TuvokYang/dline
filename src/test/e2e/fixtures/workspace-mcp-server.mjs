#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

const server = new McpServer({
	name: "dline-e2e-workspace",
	version: "1.0.0",
})

server.registerTool(
	"e2e_workspace_echo",
	{
		description: "E2E workspace MCP capability marker",
		inputSchema: { value: z.string() },
	},
	async ({ value }) => ({
		content:
			value === "E2E_MCP_AGGREGATE"
				? [
						{ type: "text", text: "E2E_MCP_AGGREGATE_FIRST" },
						{ type: "text", text: "E2E_MCP_AGGREGATE_SECOND" },
					]
				: [{ type: "text", text: value }],
	}),
)

await server.connect(new StdioServerTransport())
