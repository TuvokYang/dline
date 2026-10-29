import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hosts/host-provider", () => ({
    HostProvider: { get: () => ({ getCallbackUrl: async (callbackPath: string) => `vscode://tuvokyang.dline${callbackPath}` }) },
}))
vi.mock("@/utils/env", () => ({ openExternal: async () => {} }))

import { resetMcpOAuthStore } from "@core/storage/secrets/McpOAuthStore"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import type { OAuthFlowLease } from "@/services/oauth"
import { getServerAuthHash } from "@/utils/mcpAuth"
import { McpOAuthManager } from "../McpOAuthManager"

const SERVER_NAME = "remote-tools"
const unsharedLease: OAuthFlowLease = { acquire: async () => ({ release: async () => {} }) }

interface RegistrationServer {
    url: string
    readonly registrations: number
    close(): Promise<void>
}

/** Authorization server that, like oidc-provider, issues a new client_id for every dynamic registration. */
async function startRegistrationServer(): Promise<RegistrationServer> {
    let origin = ""
    let registrations = 0
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
                json(201, { ...JSON.parse(body), client_id: `client-${registrations}` })
                return
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
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
}

type PersistedEntry = Record<string, unknown> & {
    client_info?: { client_id: string }
    tokens?: { access_token: string }
    pending_auth_url?: string
}

describe("McpOAuthManager client registration", () => {
    const previousDlineDir = process.env.DLINE_DIR
    let dataRoot: string
    let server: RegistrationServer
    let managers: McpOAuthManager[]

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dline-mcp-oauth-"))
        process.env.DLINE_DIR = dataRoot
        resetMcpOAuthStore()
        server = await startRegistrationServer()
        managers = []
    })

    afterEach(async () => {
        await Promise.all(managers.map((manager) => manager.dispose()))
        await server.close()
        resetMcpOAuthStore()
        if (previousDlineDir === undefined) {
            delete process.env.DLINE_DIR
        } else {
            process.env.DLINE_DIR = previousDlineDir
        }
        fs.rmSync(dataRoot, { recursive: true, force: true })
    })

    const createManager = (): McpOAuthManager => {
        const manager = new McpOAuthManager(async () => {}, { leaseFor: () => unsharedLease })
        managers.push(manager)
        return manager
    }
    const storePath = () => path.join(dataRoot, "data", "secrets", "mcp_oauth.json")
    const serverHash = () => getServerAuthHash(SERVER_NAME, server.url)
    const persistedEntry = (): PersistedEntry | undefined =>
        (JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, PersistedEntry>)[serverHash()]

    /** Another Dline window writes the shared store through its own process-local storage instance. */
    const writeFromAnotherWindow = (change: (entry: PersistedEntry) => PersistedEntry): void => {
        const otherWindow = new ClineFileStorage<PersistedEntry>(storePath(), "AnotherWindow", { fileMode: 0o600 })
        otherWindow.set(serverHash(), change({ ...(otherWindow.get(serverHash()) ?? {}) }))
    }

    it("reuses the client another window registered for the same redirect instead of registering again", async () => {
        const provider = await createManager().getOrCreateProvider(SERVER_NAME, server.url)
        const redirectUrl = String(provider.redirectUrl)
        writeFromAnotherWindow(() => ({
            client_info: { client_id: "client-from-other-window", redirect_uris: [redirectUrl] },
            redirect_url_at_registration: redirectUrl,
        }))

        await expect(auth(provider, { serverUrl: server.url })).resolves.toBe("REDIRECT")

        expect(server.registrations).toBe(0)
        expect(persistedEntry()?.client_info?.client_id).toBe("client-from-other-window")
        expect(new URL(persistedEntry()?.pending_auth_url ?? "").searchParams.get("client_id")).toBe("client-from-other-window")
    })

    it("sees and keeps the tokens another window saved for the shared client", async () => {
        const provider = await createManager().getOrCreateProvider(SERVER_NAME, server.url)
        await auth(provider, { serverUrl: server.url })
        writeFromAnotherWindow((entry) => ({
            ...entry,
            tokens: { access_token: "token-from-other-window", token_type: "Bearer" },
            tokens_saved_at: Date.now(),
        }))

        await provider.saveCodeVerifier("verifier-for-next-authorization")

        expect((await provider.tokens())?.access_token).toBe("token-from-other-window")
        expect(persistedEntry()?.tokens?.access_token).toBe("token-from-other-window")
        expect(persistedEntry()?.client_info?.client_id).toBe("client-1")
    })

    it("registers once when connects to the same server overlap in one window", async () => {
        const manager = createManager()
        const connect = async () => auth(await manager.getOrCreateProvider(SERVER_NAME, server.url), { serverUrl: server.url })

        await expect(Promise.all([connect(), connect(), connect()])).resolves.toEqual(["REDIRECT", "REDIRECT", "REDIRECT"])

        expect(server.registrations).toBe(1)
        expect(persistedEntry()?.client_info?.client_id).toBe("client-1")
    })
})
