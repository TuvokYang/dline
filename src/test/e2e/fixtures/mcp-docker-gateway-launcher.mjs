#!/usr/bin/env node

import { existsSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

/**
 * E2E stand-in for the `docker mcp gateway run --profile dline` command.
 *
 * Keeps the user-facing stdio config shape while letting the test control
 * startup failures deterministically:
 * - Before the marker file exists: exits immediately (simulates a gateway that
 *   is still starting / a transient spawn failure).
 * - After the marker file exists: serves a deterministic stdio MCP catalog in
 *   process. CI runners have no Docker MCP gateway or `dline` profile, so the
 *   recovery path must not depend on one.
 */

const markerPath = process.env.DLINE_E2E_MCP_MARKER
if (!markerPath || !existsSync(markerPath)) {
	console.error("MCP gateway not ready yet")
	process.exit(1)
}

const server = new McpServer({
	name: "dline-e2e-docker-gateway",
	version: "1.0.0",
})

server.registerTool(
	"e2e_gateway_echo",
	{
		description: "E2E stand-in for a tool exposed by the Docker MCP gateway",
		inputSchema: { value: z.string() },
	},
	async ({ value }) => ({ content: [{ type: "text", text: value }] }),
)

await server.connect(new StdioServerTransport())
