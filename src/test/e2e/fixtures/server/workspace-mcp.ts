import type { IncomingMessage, ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod/v4"

export const E2E_WORKSPACE_MCP_PATH = "/mock/mcp/workspace"

export function getE2EWorkspaceMcpUrl(baseUrl: string): string {
	return `${baseUrl}${E2E_WORKSPACE_MCP_PATH}`
}

function createWorkspaceMcpServer(): McpServer {
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
		async ({ value }) => ({ content: [{ type: "text", text: value }] }),
	)
	return server
}

function sendMethodNotAllowed(response: ServerResponse): void {
	response.writeHead(405, {
		Allow: "POST",
		"Content-Type": "application/json",
	})
	response.end(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32_000, message: "Method not allowed." },
			id: null,
		}),
	)
}

export async function handleE2EWorkspaceMcpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	parsedBody: unknown,
): Promise<void> {
	if (request.method !== "POST") {
		sendMethodNotAllowed(response)
		return
	}

	const server = createWorkspaceMcpServer()
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	let closed = false
	const close = () => {
		if (closed) return
		closed = true
		void Promise.allSettled([transport.close(), server.close()])
	}
	response.once("close", close)

	try {
		await server.connect(transport)
		await transport.handleRequest(request, response, parsedBody)
	} catch (error) {
		if (!response.headersSent) {
			response.writeHead(500, { "Content-Type": "application/json" })
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32_603,
						message: error instanceof Error ? error.message : "Internal MCP fixture error",
					},
					id: null,
				}),
			)
			return
		}
		response.destroy(error instanceof Error ? error : undefined)
	}
}
