import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hosts/host-provider", () => ({
    HostProvider: {
        get: () => ({ getCallbackUrl: async (callbackPath: string) => `https://workspace.example.test/callback${callbackPath}` }),
    },
}))
vi.mock("@/utils/env", () => ({ openExternal: async () => {} }))

import { getMcpOAuthServer, resetMcpOAuthStore, updateMcpOAuthServer } from "@core/storage/secrets/McpOAuthStore"
import type { OAuthFlowLease } from "@/services/oauth"
import { getServerAuthHash } from "@/utils/mcpAuth"
import { McpOAuthAuthorizationNotPreparedError, McpOAuthManager } from "../McpOAuthManager"

const SERVER_NAME = "remote-tools"
const unsharedLease: OAuthFlowLease = { acquire: async () => ({ release: async () => {} }) }

type RefreshFailure = "invalid_client" | "invalid_grant" | "server_error"

interface RecoveryServer {
    readonly url: string
    readonly registrations: number
    readonly refreshRequests: number
    close(): Promise<void>
}

async function startRecoveryServer(refreshFailure: RefreshFailure): Promise<RecoveryServer> {
    let origin = ""
    let registrations = 0
    let refreshRequests = 0
    const server = http.createServer((request, response) => {
        let body = ""
        request.on("data", (chunk) => {
            body += chunk
        })
        request.on("end", () => {
            const url = new URL(request.url ?? "/", origin)
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { "Content-Type": "application/json" })
                response.end(JSON.stringify(payload))
            }
            if (url.pathname === "/.well-known/oauth-authorization-server") {
                json(200, {
                    issuer: origin,
                    authorization_endpoint: `${origin}/authorize`,
                    token_endpoint: `${origin}/token`,
                    registration_endpoint: `${origin}/register`,
                    response_types_supported: ["code"],
                    code_challenge_methods_supported: ["S256"],
                })
                return
            }
            if (url.pathname === "/register" && request.method === "POST") {
                registrations += 1
                json(201, { ...JSON.parse(body), client_id: `replacement-client-${registrations}` })
                return
            }
            if (url.pathname === "/token" && request.method === "POST") {
                const form = new URLSearchParams(body)
                if (form.get("grant_type") === "refresh_token") {
                    refreshRequests += 1
                    if (refreshFailure === "server_error") {
                        json(500, { error: "server_error", error_description: "authorization server unavailable" })
                    } else {
                        json(400, { error: refreshFailure, error_description: `${refreshFailure} during refresh` })
                    }
                    return
                }
            }
            response.writeHead(404)
            response.end()
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
        url: `${origin}/mcp`,
        get registrations() {
            return registrations
        },
        get refreshRequests() {
            return refreshRequests
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
}

function staleClient(redirectUrl: string): OAuthClientInformationFull {
    return {
        client_id: "stale-client",
        redirect_uris: [redirectUrl],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Dline test",
    }
}

const staleTokens: OAuthTokens = {
    access_token: "stale-access-token",
    refresh_token: "stale-refresh-token",
    token_type: "Bearer",
    expires_in: 1,
}

async function seedStaleCredentials(provider: OAuthClientProvider): Promise<void> {
    await provider.saveClientInformation?.(staleClient(String(provider.redirectUrl)))
    await provider.saveTokens(staleTokens)
}

describe("McpOAuthManager credential invalidation", () => {
    const previousDlineDir = process.env.DLINE_DIR
    let dataRoot: string
    let manager: McpOAuthManager
    let server: RecoveryServer | undefined
    let authorizationEvents: { serverName: string; serverUrl: string; reauthorization: boolean }[]

    beforeEach(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dline-mcp-oauth-invalidation-"))
        process.env.DLINE_DIR = dataRoot
        resetMcpOAuthStore()
        authorizationEvents = []
        manager = new McpOAuthManager(async () => {}, {
            leaseFor: () => unsharedLease,
            onAuthorizationRequired: (event) => {
                authorizationEvents.push(event)
            },
        })
    })

    afterEach(async () => {
        await manager.dispose()
        await server?.close()
        server = undefined
        resetMcpOAuthStore()
        if (previousDlineDir === undefined) {
            delete process.env.DLINE_DIR
        } else {
            process.env.DLINE_DIR = previousDlineDir
        }
        fs.rmSync(dataRoot, { recursive: true, force: true })
    })

    it("clears an invalid client, registers a replacement and prepares reauthorization", async () => {
        server = await startRecoveryServer("invalid_client")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        await seedStaleCredentials(provider)

        await expect(auth(provider, { serverUrl: server.url })).resolves.toBe("REDIRECT")

        const persisted = getMcpOAuthServer(getServerAuthHash(SERVER_NAME, server.url))
        expect(server.refreshRequests).toBe(1)
        expect(server.registrations).toBe(1)
        expect((persisted?.client_info as { client_id?: string } | undefined)?.client_id).toBe("replacement-client-1")
        expect(persisted?.tokens).toBeUndefined()
        expect(new URL(String(persisted?.pending_auth_url)).searchParams.get("client_id")).toBe("replacement-client-1")
        expect(manager.isReauthorizationRequired(SERVER_NAME, server.url)).toBe(true)
        expect(authorizationEvents).toEqual([{ serverName: SERVER_NAME, serverUrl: server.url, reauthorization: true }])
    })

    it("clears an invalid refresh grant but reuses the registered client", async () => {
        server = await startRecoveryServer("invalid_grant")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        await seedStaleCredentials(provider)

        await expect(auth(provider, { serverUrl: server.url })).resolves.toBe("REDIRECT")

        const persisted = getMcpOAuthServer(getServerAuthHash(SERVER_NAME, server.url))
        expect(server.refreshRequests).toBe(1)
        expect(server.registrations).toBe(0)
        expect((persisted?.client_info as { client_id?: string } | undefined)?.client_id).toBe("stale-client")
        expect(persisted?.tokens).toBeUndefined()
        expect(new URL(String(persisted?.pending_auth_url)).searchParams.get("client_id")).toBe("stale-client")
        expect(manager.isReauthorizationRequired(SERVER_NAME, server.url)).toBe(true)
    })

    it("stores a fresh authorization URL when refresh is temporarily unavailable", async () => {
        server = await startRecoveryServer("server_error")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        await seedStaleCredentials(provider)

        await expect(auth(provider, { serverUrl: server.url })).resolves.toBe("REDIRECT")

        const persisted = getMcpOAuthServer(getServerAuthHash(SERVER_NAME, server.url))
        expect(server.refreshRequests).toBe(1)
        expect(new URL(String(persisted?.pending_auth_url)).searchParams.get("client_id")).toBe("stale-client")
        expect(manager.isReauthorizationRequired(SERVER_NAME, server.url)).toBe(true)
    })

    it("invalidates tokens even when this provider has not read the persisted credential yet", async () => {
        server = await startRecoveryServer("invalid_grant")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        const serverHash = getServerAuthHash(SERVER_NAME, server.url)
        updateMcpOAuthServer(serverHash, (current) => ({
            ...current,
            tokens: { access_token: "unread-access-token", refresh_token: "unread-refresh-token", token_type: "Bearer" },
            tokens_saved_at: Date.now(),
        }))

        await provider.invalidateCredentials?.("tokens")

        const persisted = getMcpOAuthServer(serverHash)
        expect(persisted?.tokens).toBeUndefined()
        expect(persisted?.reauthorization_required).toBe(true)
    })

    it("invalidates a client even when this provider has not read the registration yet", async () => {
        server = await startRecoveryServer("invalid_client")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        const serverHash = getServerAuthHash(SERVER_NAME, server.url)
        updateMcpOAuthServer(serverHash, (current) => ({
            ...current,
            client_info: staleClient(String(provider.redirectUrl)),
            redirect_url_at_registration: String(provider.redirectUrl),
            tokens: { access_token: "unread-access-token", refresh_token: "unread-refresh-token", token_type: "Bearer" },
            tokens_saved_at: Date.now(),
        }))

        await provider.invalidateCredentials?.("all")

        const persisted = getMcpOAuthServer(serverHash)
        expect(persisted?.client_info).toBeUndefined()
        expect(persisted?.tokens).toBeUndefined()
        expect(persisted?.reauthorization_required).toBe(true)
    })

    it("does not delete tokens another window rotated after this provider read them", async () => {
        server = await startRecoveryServer("invalid_grant")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        await seedStaleCredentials(provider)
        await provider.tokens()

        const serverHash = getServerAuthHash(SERVER_NAME, server.url)
        updateMcpOAuthServer(serverHash, (current) => ({
            ...current,
            tokens: { access_token: "rotated-access-token", refresh_token: "rotated-refresh-token", token_type: "Bearer" },
            tokens_saved_at: Date.now(),
        }))

        await provider.invalidateCredentials?.("tokens")

        const persisted = getMcpOAuthServer(serverHash)
        expect((persisted?.tokens as { access_token?: string } | undefined)?.access_token).toBe("rotated-access-token")
    })

    it("does not delete a newer cross-window token when Reauthorize follows an older request's 401", async () => {
        server = await startRecoveryServer("invalid_grant")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        await seedStaleCredentials(provider)

        const serverHash = getServerAuthHash(SERVER_NAME, server.url)
        updateMcpOAuthServer(serverHash, (current) => ({
            ...current,
            tokens: { access_token: "rotated-access-token", refresh_token: "rotated-refresh-token", token_type: "Bearer" },
            tokens_saved_at: Date.now(),
        }))

        await manager.prepareReauthorization(SERVER_NAME, server.url)

        const persisted = getMcpOAuthServer(serverHash)
        expect((persisted?.tokens as { access_token?: string } | undefined)?.access_token).toBe("rotated-access-token")
    })

    it("prepares a fresh authorization URL when Reauthorize is clicked after a bare post-auth 401", async () => {
        server = await startRecoveryServer("invalid_grant")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        await seedStaleCredentials(provider)

        await expect(manager.startOAuthFlow(SERVER_NAME, server.url)).rejects.toBeInstanceOf(
            McpOAuthAuthorizationNotPreparedError,
        )
        await manager.prepareReauthorization(SERVER_NAME, server.url)
        await expect(auth(provider, { serverUrl: server.url })).resolves.toBe("REDIRECT")

        const persisted = getMcpOAuthServer(getServerAuthHash(SERVER_NAME, server.url))
        expect(persisted?.tokens).toBeUndefined()
        expect(persisted?.pending_auth_url).toBeTypeOf("string")
        expect(manager.isReauthorizationRequired(SERVER_NAME, server.url)).toBe(true)
    })

    it("clears reauthorization state after fresh tokens are saved", async () => {
        server = await startRecoveryServer("invalid_grant")
        const provider = await manager.getOrCreateProvider(SERVER_NAME, server.url)
        await seedStaleCredentials(provider)
        await expect(auth(provider, { serverUrl: server.url })).resolves.toBe("REDIRECT")

        await provider.saveTokens({
            access_token: "fresh-access-token",
            refresh_token: "fresh-refresh-token",
            token_type: "Bearer",
        })

        const persisted = getMcpOAuthServer(getServerAuthHash(SERVER_NAME, server.url))
        expect(manager.isReauthorizationRequired(SERVER_NAME, server.url)).toBe(false)
        expect(persisted?.pending_auth_url).toBeUndefined()
        expect((persisted?.tokens as { access_token?: string } | undefined)?.access_token).toBe("fresh-access-token")
    })
})
