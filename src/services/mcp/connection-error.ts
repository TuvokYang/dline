import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type { McpServer } from "@shared/mcp"

export type McpConnectionFailureKind = "authorization_required" | "server_unavailable" | "other"

export interface McpConnectionFailure {
    readonly kind: McpConnectionFailureKind
    readonly message: string
}

const AUTHORIZATION_ERROR_CODES = new Set(["invalid_client", "invalid_grant", "unauthorized_client", "invalid_token"])
const SERVER_UNAVAILABLE_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
])

/** Classify a connection failure before projecting it to retry or authorization UI. */
export function classifyMcpConnectionError(error: unknown): McpConnectionFailure {
    const message = describeMcpConnectionError(error)
    // Network evidence wins over an incidental 401 field on a wrapper: no authorization flow can
    // recover a server that did not answer.
    if (hasUnavailableServerSignal(error)) return { kind: "server_unavailable", message }
    if (isAuthorizationFailure(error)) return { kind: "authorization_required", message }
    return { kind: "other", message }
}

/** Project the one authorization-blocked state consumed by the MCP server row. */
export function projectMcpAuthorizationFailure(server: McpServer, reauthorization: boolean): boolean {
    const oauthAuthStatus = reauthorization ? "reauthentication-required" : "unauthenticated"
    const error = reauthorization
        ? "Authorization for this server is no longer valid. Reauthorize to reconnect."
        : "Authorization is required. Authenticate to connect, or retry if the server was restarted."
    const changed =
        server.status !== "disconnected" ||
        server.oauthRequired !== true ||
        server.oauthAuthStatus !== oauthAuthStatus ||
        server.error !== error
    server.status = "disconnected"
    server.oauthRequired = true
    server.oauthAuthStatus = oauthAuthStatus
    server.error = error
    return changed
}

/**
 * Describe why a connection to an MCP server failed, for the server's error row.
 *
 * Node's fetch reports every network failure as "fetch failed" and keeps the
 * reason (refused, reset, unknown host) in `cause`; without it the row cannot
 * tell a server that is down from one that answered with an error.
 */
export function describeMcpConnectionError(error: unknown): string {
    if (!(error instanceof Error)) return String(error)
    const reason = describeCause(error.cause)
    return reason && !error.message.includes(reason) ? `${error.message}: ${reason}` : error.message
}

function isAuthorizationFailure(error: unknown): boolean {
    if (error instanceof UnauthorizedError) return true
    if (error instanceof OAuthError && AUTHORIZATION_ERROR_CODES.has(error.errorCode)) return true
    if ((error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401) return true
    if (!isRecord(error)) return false
    return error.code === 401 || error.status === 401 || error.statusCode === 401
}

function hasUnavailableServerSignal(error: unknown): boolean {
    if (error instanceof Error && /^MCP connection timed out after \d+ms:/.test(error.message)) return true
    return walkErrors(error).some((entry) => {
        const code = (entry as NodeJS.ErrnoException).code
        return typeof code === "string" && SERVER_UNAVAILABLE_CODES.has(code)
    })
}

function walkErrors(error: unknown): Error[] {
    const found: Error[] = []
    const pending: unknown[] = [error]
    const visited = new Set<unknown>()
    while (pending.length > 0) {
        const current = pending.shift()
        if (!(current instanceof Error) || visited.has(current)) continue
        visited.add(current)
        found.push(current)
        if (current.cause !== undefined) pending.push(current.cause)
        if (current instanceof AggregateError) pending.push(...current.errors)
    }
    return found
}

function describeCause(cause: unknown): string | undefined {
    if (!(cause instanceof Error)) return undefined
    const code = (cause as NodeJS.ErrnoException).code
    // A host that resolves to several addresses fails with one error per address.
    const first = cause instanceof AggregateError ? cause.errors.find((entry) => entry instanceof Error) : undefined
    const message = cause.message || (first instanceof Error ? first.message : "")
    if (!message) return code
    return code && !message.includes(code) ? `${code}: ${message}` : message
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}
