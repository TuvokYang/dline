import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { getServerAuthHash } from "@/utils/mcpAuth"
import { isOAuthFlowCancelled, McpOAuthReregistrationRequiredError } from "./McpOAuthLoopback"
import { McpOAuthAuthorizationNotPreparedError, type McpOAuthFlow, McpOAuthManager } from "./McpOAuthManager"
import type { McpConnection } from "./types"

/** What the Authenticate flow needs from the hub that owns the server connections. */
export interface McpAuthenticationHost {
    connections(): readonly McpConnection[]
    restartConnection(serverName: string): Promise<void>
    authorizationRequired(serverName: string, serverUrl: string, reauthorization: boolean): Promise<void>
}

/**
 * The Authenticate flow a user starts for an MCP server, and its outcome.
 *
 * McpOAuthManager owns client registration and the authorization itself. This connects it to the
 * hub's connections: it starts the authorization, redeems the code through the connection's
 * transport, reconnects the server and tells the user how it went.
 */
export class McpAuthentication {
    readonly oauth: McpOAuthManager

    constructor(private readonly host: McpAuthenticationHost) {
        this.oauth = new McpOAuthManager((serverHash, code) => this.finishOAuth(serverHash, code), {
            onAuthorizationRequired: ({ serverName, serverUrl, reauthorization }) =>
                this.host.authorizationRequired(serverName, serverUrl, reauthorization),
        })
    }

    /** Opens the server's authorization in the browser; the outcome is reported when it settles. */
    async initiate(serverName: string): Promise<void> {
        const connection = this.host.connections().find((conn) => conn.server.name === serverName)
        if (!connection) {
            throw new Error(`No connection found for server: ${serverName}`)
        }

        const serverUrl = JSON.parse(connection.server.config).url
        if (!serverUrl) {
            throw new Error(`No URL found in config for server: ${serverName}`)
        }

        const displayName = connection.server.displayName ?? serverName
        let flow: McpOAuthFlow | undefined
        try {
            flow = await this.oauth.startOAuthFlow(serverName, serverUrl, displayName)
        } catch (error) {
            if (error instanceof McpOAuthAuthorizationNotPreparedError) {
                // A post-auth 401 can arrive without a pending redirect. Invalidate the exact saved
                // token, reconnect once so the SDK prepares a URL, then continue this same click.
                await this.oauth.prepareReauthorization(serverName, serverUrl)
                await this.host.restartConnection(serverName)
                const restarted = this.host.connections().find((candidate) => candidate.server.name === serverName)
                if (restarted?.server.status === "connected") return
                flow = await this.oauth.startOAuthFlow(serverName, serverUrl, displayName)
            } else {
                if (error instanceof McpOAuthReregistrationRequiredError) {
                    // Reconnecting registers a redirect Dline can serve and stores a new authorization URL.
                    await this.host.restartConnection(serverName)
                }
                throw error
            }
        }
        if (flow) {
            void this.settle(getServerAuthHash(serverName, serverUrl), flow, displayName)
        }
    }

    /** Completes an authorization that came back through the URI handler and tells the user the outcome. */
    async completeFromCallback(serverHash: string, code: string, state: string | null): Promise<void> {
        const server = this.lookupConnection(serverHash)?.server
        await this.reportOutcome(server?.displayName ?? server?.name, () => this.complete(serverHash, code, state))
    }

    async dispose(): Promise<void> {
        await this.oauth.dispose()
    }

    /** Validates the URI-handler callback's state, redeems the code and reconnects the server. */
    private async complete(serverHash: string, code: string, state: string | null): Promise<void> {
        this.findConnection(serverHash)

        // Validate state for CSRF protection (if provided)
        if (state && !this.oauth.validateAndClearState(serverHash, state)) {
            throw new Error("Invalid OAuth state - possible CSRF attack")
        }

        await this.finishOAuth(serverHash, code)
        await this.reconnectAuthenticated(serverHash)
    }

    /** Waits for a loopback authorization on the shared coordinator, then reconnects the server. */
    private async settle(serverHash: string, flow: McpOAuthFlow, displayName: string): Promise<void> {
        try {
            await flow.result
        } catch (error) {
            if (!isOAuthFlowCancelled(error)) {
                this.reportFailure(displayName, error)
            }
            return
        }
        await this.reportOutcome(displayName, () => this.reconnectAuthenticated(serverHash))
    }

    private async reportOutcome(displayName: string | undefined, complete: () => Promise<void>): Promise<void> {
        try {
            await complete()
            HostProvider.window.showMessage({
                type: ShowMessageType.INFORMATION,
                message: `Successfully authenticated ${describeMcpServer(displayName)}`,
            })
        } catch (error) {
            this.reportFailure(displayName, error)
        }
    }

    private reportFailure(displayName: string | undefined, error: unknown): void {
        Logger.error("Failed to complete MCP OAuth:", error)
        const reason = error instanceof Error ? error.message : String(error)
        HostProvider.window.showMessage({
            type: ShowMessageType.ERROR,
            message: `Failed to authenticate ${describeMcpServer(displayName)}: ${reason}`,
        })
    }

    private lookupConnection(serverHash: string): McpConnection | undefined {
        return this.host.connections().find((conn) => {
            const config = JSON.parse(conn.server.config)
            return config.url ? getServerAuthHash(conn.server.name, config.url) === serverHash : false
        })
    }

    private findConnection(serverHash: string): McpConnection {
        const connection = this.lookupConnection(serverHash)
        if (!connection) {
            throw new Error(`No connection found for server hash: ${serverHash}`)
        }
        return connection
    }

    /** Redeems the code through the transport; the MCP SDK exchanges it and saves the tokens. */
    private async finishOAuth(serverHash: string, code: string): Promise<void> {
        const connection = this.findConnection(serverHash)
        // finishAuth is only available on SSE and StreamableHTTP transports
        if (connection.transport instanceof SSEClientTransport || connection.transport instanceof StreamableHTTPClientTransport) {
            await connection.transport.finishAuth(code)
        } else {
            throw new Error("OAuth is only supported for SSE and HTTP transports")
        }
    }

    private async reconnectAuthenticated(serverHash: string): Promise<void> {
        const connection = this.findConnection(serverHash)
        Logger.log(`[McpOAuth] Authentication completed for ${connection.server.name}`)

        connection.server.oauthAuthStatus = "authenticated"
        connection.server.oauthRequired = true
        connection.server.error = ""

        // Restart connection to complete setup with authenticated transport
        await this.host.restartConnection(connection.server.name)
    }
}

/** Names the server in a user-facing message, or falls back to a generic label when it is no longer known. */
function describeMcpServer(displayName: string | undefined): string {
    return displayName ? `MCP server "${displayName}"` : "MCP server"
}
