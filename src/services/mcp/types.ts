import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { McpServer } from "@shared/mcp"
import { z } from "zod"
import { ServerConfigSchema } from "./schemas"

export type Transport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

export type McpConnection = {
    server: McpServer
    client: Client
    transport: Transport
    authProvider?: OAuthClientProvider
    /**
     * The `${env:...}` variable the user declined to provide. Such a connection stays
     * closed until its configuration changes or the user restarts it or clears its values.
     */
    missingVariable?: string
}

export type McpTransportType = "stdio" | "sse" | "http"

export type McpServerConfig = z.infer<typeof ServerConfigSchema>
