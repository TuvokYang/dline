import net from "node:net"
import { type LocalOAuthCallbackPages, OAuthFlowError, renderAuthResultPage } from "@/services/oauth"
import type { GetCallbackUrlFn } from "./McpOAuthRedirectResolver"

const LOOPBACK_HOST = "127.0.0.1"

/**
 * Ports offered first for MCP loopback redirects.
 *
 * A port is fixed into the registered `redirect_uri`, so a stable range lets a saved client
 * registration be reused across sessions. Any free port is used when the whole range is taken.
 */
const LOOPBACK_PORTS: readonly number[] = Array.from({ length: 20 }, (_, index) => 48820 + index)

/** Browser pages for one MCP server's loopback authorization, naming the server the user authorized. */
export function mcpOAuthCallbackPages(serverDisplayName: string): LocalOAuthCallbackPages {
    return {
        success: renderAuthResultPage({
            status: "success",
            title: "Authorization successful",
            description: `Dline received the authorization for MCP server "${serverDisplayName}" and is reconnecting it.`,
            hint: "Close this window and return to your editor.",
        }),
        failure: renderAuthResultPage({
            status: "failure",
            title: "Authorization failed",
            description: `Dline could not complete the authorization for MCP server "${serverDisplayName}".`,
            hint: "Close this window and click Authenticate again in Dline's MCP settings.",
        }),
    }
}

/**
 * The registered redirect cannot be served, e.g. another program took its port before the user
 * authenticated; the server must reconnect so the SDK registers a redirect again.
 */
export class McpOAuthReregistrationRequiredError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "McpOAuthReregistrationRequiredError"
    }
}

/**
 * Loopback redirect ports for MCP OAuth when the host callback is not a web URI.
 *
 * MCP authorization servers register clients dynamically and accept only localhost or HTTPS
 * redirect URIs, so a custom-scheme host callback such as desktop VS Code's `vscode://` is
 * rejected at registration. Registration happens when a server connects, long before the user
 * clicks Authenticate, so a port is reserved per server when its redirect is resolved; the shared
 * OAuth coordinator listens on it only while an authorization is pending.
 */
export class McpOAuthLoopback {
    /** Registered loopback port per server hash, unique within this process. */
    private readonly ports = new Map<string, number>()

    /**
     * Callback URL source for one server: the host callback when it is already a web URI
     * (VS Code Web, standalone), otherwise a loopback URL on a free port.
     */
    callbackUrlSource(serverHash: string, hostCallbackUrl: GetCallbackUrlFn): GetCallbackUrlFn {
        return async (path, preferredPort) => {
            const hostUrl = await hostCallbackUrl(path, preferredPort)
            if (isWebUri(hostUrl)) {
                this.ports.delete(serverHash)
                return hostUrl
            }
            const port = await this.reservePort(serverHash, preferredPort)
            return `http://${LOOPBACK_HOST}:${port}${path}`
        }
    }

    /** Whether this server's redirect is a loopback URL that Dline itself must serve. */
    owns(serverHash: string): boolean {
        return this.ports.has(serverHash)
    }

    /** Forgets a server's reserved port, so its next redirect is resolved afresh. */
    release(serverHash: string): void {
        this.ports.delete(serverHash)
    }

    clear(): void {
        this.ports.clear()
    }

    private async reservePort(serverHash: string, preferredPort: number | undefined): Promise<number> {
        const reservedByOthers = new Set(
            [...this.ports].filter(([hash]) => hash !== serverHash).map(([, reservedPort]) => reservedPort),
        )
        const candidates = [preferredPort, this.ports.get(serverHash), ...LOOPBACK_PORTS].filter(
            (candidate): candidate is number => candidate !== undefined && !reservedByOthers.has(candidate),
        )
        for (const candidate of new Set(candidates)) {
            if (await canListen(candidate)) {
                this.ports.set(serverHash, candidate)
                return candidate
            }
        }
        const port = await anyFreePort()
        this.ports.set(serverHash, port)
        return port
    }
}

export function isWebUri(uri: string): boolean {
    try {
        const { protocol } = new URL(uri)
        return protocol === "http:" || protocol === "https:"
    } catch {
        return false
    }
}

export function isCallbackPortInUse(error: unknown): boolean {
    return error instanceof OAuthFlowError && error.code === "CALLBACK_PORT_IN_USE"
}

/** A flow replaced by a newer Authenticate click, or stopped because the server was removed. */
export function isOAuthFlowCancelled(error: unknown): boolean {
    return error instanceof OAuthFlowError && error.code === "FLOW_CANCELLED"
}

function canListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.createServer()
        probe.once("error", () => resolve(false))
        probe.listen(port, LOOPBACK_HOST, () => probe.close(() => resolve(true)))
    })
}

function anyFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.once("error", reject)
        probe.listen(0, LOOPBACK_HOST, () => {
            const address = probe.address()
            const port = typeof address === "object" && address ? address.port : 0
            probe.close(() => (port ? resolve(port) : reject(new Error("No free loopback port for the MCP OAuth callback."))))
        })
    })
}
