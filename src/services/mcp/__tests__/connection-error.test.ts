import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InvalidClientError, InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type { McpServer } from "@shared/mcp"
import { describe, expect, it } from "vitest"
import { classifyMcpConnectionError, describeMcpConnectionError, projectMcpAuthorizationFailure } from "../connection-error"

function refused(address: string): Error {
    return Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" })
}

describe("describeMcpConnectionError", () => {
    it("names the network reason a failed fetch keeps in its cause", () => {
        const error = new TypeError("fetch failed", { cause: refused("127.0.0.1:3000") })

        expect(describeMcpConnectionError(error)).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:3000")
    })

    it("takes the first address's reason when every address of the host failed", () => {
        const cause = Object.assign(new AggregateError([refused("::1:3000"), refused("127.0.0.1:3000")], ""), {
            code: "ECONNREFUSED",
        })

        expect(describeMcpConnectionError(new TypeError("fetch failed", { cause }))).toBe(
            "fetch failed: connect ECONNREFUSED ::1:3000",
        )
    })

    it("prefixes the code when the reason does not name it", () => {
        const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })

        expect(describeMcpConnectionError(new TypeError("fetch failed", { cause }))).toBe(
            "fetch failed: ECONNRESET: socket hang up",
        )
    })

    it("keeps an error without a cause, or one that already names it, as it is", () => {
        expect(describeMcpConnectionError(new Error("MCP connection timed out after 30000ms: docs"))).toBe(
            "MCP connection timed out after 30000ms: docs",
        )
        const named = new Error("connect ECONNREFUSED 127.0.0.1:3000", { cause: refused("127.0.0.1:3000") })
        expect(describeMcpConnectionError(named)).toBe("connect ECONNREFUSED 127.0.0.1:3000")
        expect(describeMcpConnectionError("closed")).toBe("closed")
    })
})

describe("classifyMcpConnectionError", () => {
    it.each([
        new UnauthorizedError(),
        new InvalidClientError("client authentication failed"),
        new InvalidGrantError("refresh token expired"),
        new StreamableHTTPError(401, "Server returned 401 after successful authentication"),
    ])("classifies an authorization failure without relying on its prose", (error) => {
        expect(classifyMcpConnectionError(error).kind).toBe("authorization_required")
    })

    it("keeps an unavailable server distinct from an authorization failure", () => {
        const error = new TypeError("fetch failed", { cause: refused("127.0.0.1:3000") })

        expect(classifyMcpConnectionError(error)).toMatchObject({
            kind: "server_unavailable",
            message: "fetch failed: connect ECONNREFUSED 127.0.0.1:3000",
        })
    })

    it("prefers concrete network failure evidence over an incidental 401 field", () => {
        const error = Object.assign(new TypeError("fetch failed", { cause: refused("127.0.0.1:3000") }), { code: 401 })

        expect(classifyMcpConnectionError(error).kind).toBe("server_unavailable")
    })

    it("does not turn an authorization-server outage or an MCP 5xx into a reauthorization request", () => {
        expect(classifyMcpConnectionError(new ServerError("authorization server unavailable")).kind).toBe("other")
        expect(classifyMcpConnectionError(new StreamableHTTPError(503, "Service Unavailable")).kind).toBe("other")
    })

    it("projects distinct initial authorization and reauthorization states", () => {
        const server: McpServer = { name: "show3d", config: "{}", status: "connecting" }

        projectMcpAuthorizationFailure(server, false)
        expect(server).toMatchObject({
            status: "disconnected",
            oauthRequired: true,
            oauthAuthStatus: "unauthenticated",
            error: "Authorization is required. Authenticate to connect, or retry if the server was restarted.",
        })

        projectMcpAuthorizationFailure(server, true)
        expect(server).toMatchObject({
            oauthAuthStatus: "reauthentication-required",
            error: "Authorization for this server is no longer valid. Reauthorize to reconnect.",
        })
    })
})
