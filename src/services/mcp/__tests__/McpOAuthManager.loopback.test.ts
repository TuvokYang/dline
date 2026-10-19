import http from "node:http"
import type { AddressInfo } from "node:net"
import net from "node:net"
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hostCallback = vi.hoisted(() => ({ base: "vscode://tuvokyang.dline" }))
const secretStore = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const browser = vi.hoisted(() => ({ open: async (_url: string): Promise<void> => {} }))

vi.mock("@core/storage/secrets", () => ({
    getAllMcpOAuthSecrets: () => structuredClone(secretStore.value),
    setAllMcpOAuthSecrets: (value: Record<string, unknown>) => {
        secretStore.value = structuredClone(value)
    },
}))
vi.mock("@/hosts/host-provider", () => ({
    HostProvider: { get: () => ({ getCallbackUrl: async (path: string) => `${hostCallback.base}${path}` }) },
}))
vi.mock("@/utils/env", () => ({ openExternal: (url: string) => browser.open(url) }))

import type { OAuthFlowLease } from "@/services/oauth"
import { McpOAuthReregistrationRequiredError } from "../McpOAuthLoopback"
import { type McpOAuthCodeExchange, McpOAuthManager } from "../McpOAuthManager"

const SERVER_NAME = "remote-tools"
const AUTHORIZATION_CODE = "authorization-code-1"

const unsharedLease: OAuthFlowLease = { acquire: async () => ({ release: async () => {} }) }

function createManager(exchange: McpOAuthCodeExchange): McpOAuthManager {
    return new McpOAuthManager(exchange, { leaseFor: () => unsharedLease })
}

interface AuthorizationServer {
    url: string
    registeredRedirects: string[][]
    close(): Promise<void>
}

/**
 * Authorization server that, like strict MCP servers, accepts only web redirect URIs at
 * dynamic client registration and redeems a code only for the redirect URI it registered.
 */
async function startAuthorizationServer(): Promise<AuthorizationServer> {
    const registeredRedirects: string[][] = []
    let origin = ""
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", origin)
        const body = await readBody(request)
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
            const metadata = JSON.parse(body) as { redirect_uris: string[] }
            registeredRedirects.push(metadata.redirect_uris)
            const webOnly = metadata.redirect_uris.every((uri) => ["http:", "https:"].includes(new URL(uri).protocol))
            if (!webOnly) {
                json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris must only contain web uris" })
                return
            }
            json(201, { ...metadata, client_id: `client-${registeredRedirects.length}` })
            return
        }
        if (url.pathname === "/authorize") {
            const redirect = new URL(url.searchParams.get("redirect_uri") ?? "")
            redirect.searchParams.set("code", AUTHORIZATION_CODE)
            redirect.searchParams.set("state", url.searchParams.get("state") ?? "")
            response.writeHead(302, { Location: redirect.toString() })
            response.end()
            return
        }
        if (url.pathname === "/token" && request.method === "POST") {
            const form = new URLSearchParams(body)
            const registered = registeredRedirects.at(-1) ?? []
            if (form.get("code") !== AUTHORIZATION_CODE || !registered.includes(form.get("redirect_uri") ?? "")) {
                json(400, { error: "invalid_grant" })
                return
            }
            json(200, { access_token: "access-token-1", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" })
            return
        }
        response.writeHead(404)
        response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
        url: `${origin}/mcp`,
        registeredRedirects,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
}

function readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = ""
        request.on("data", (chunk) => {
            body += chunk
        })
        request.on("end", () => resolve(body))
        request.on("error", reject)
    })
}

/** Browser stand-in: follows the authorization redirect and loads the callback page. */
function followAuthorizationInBrowser(pages: { status: number; callbackUrl: string }[]) {
    browser.open = async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: "manual" })
        const callbackUrl = authorization.headers.get("location") ?? ""
        const page = await fetch(callbackUrl)
        await page.text()
        pages.push({ status: page.status, callbackUrl })
    }
}

function isWebUri(uri: string): boolean {
    return ["http:", "https:"].includes(new URL(uri).protocol)
}

describe("McpOAuthManager redirect for MCP authorization servers", () => {
    let authorizationServer: AuthorizationServer
    let manager: McpOAuthManager | undefined

    beforeEach(async () => {
        secretStore.value = {}
        hostCallback.base = "vscode://tuvokyang.dline"
        authorizationServer = await startAuthorizationServer()
    })

    afterEach(async () => {
        await manager?.dispose()
        manager = undefined
        await authorizationServer.close()
    })

    it("registers a loopback redirect instead of the vscode:// host callback and completes through it", async () => {
        const exchangedCodes: string[] = []
        manager = createManager(async (_serverHash, code) => {
            exchangedCodes.push(code)
            await auth(provider, { serverUrl: authorizationServer.url, authorizationCode: code })
        })
        const provider = await manager.getOrCreateProvider(SERVER_NAME, authorizationServer.url)

        expect(await auth(provider, { serverUrl: authorizationServer.url })).toBe("REDIRECT")
        expect(authorizationServer.registeredRedirects).toHaveLength(1)
        const [registered] = authorizationServer.registeredRedirects[0]
        expect(isWebUri(registered)).toBe(true)
        expect(new URL(registered).hostname).toBe("127.0.0.1")

        const pages: { status: number; callbackUrl: string }[] = []
        followAuthorizationInBrowser(pages)
        const flow = await manager.startOAuthFlow(SERVER_NAME, authorizationServer.url)
        await flow?.result

        expect(flow).toBeDefined()
        expect(exchangedCodes).toEqual([AUTHORIZATION_CODE])
        expect(pages).toHaveLength(1)
        expect(pages[0].status).toBe(200)
        expect(new URL(pages[0].callbackUrl).origin).toBe(new URL(registered).origin)
        expect((await provider.tokens())?.access_token).toBe("access-token-1")
        // The callback endpoint exists only while an authorization is pending.
        await expect(fetch(registered)).rejects.toThrow()
    })

    it("completes on a second Authenticate click after the first exchange failed", async () => {
        let attempts = 0
        manager = createManager(async (_serverHash, code) => {
            attempts++
            if (attempts === 1) {
                throw new Error("token endpoint unavailable")
            }
            await auth(provider, { serverUrl: authorizationServer.url, authorizationCode: code })
        })
        const provider = await manager.getOrCreateProvider(SERVER_NAME, authorizationServer.url)
        await auth(provider, { serverUrl: authorizationServer.url })

        const pages: { status: number; callbackUrl: string }[] = []
        followAuthorizationInBrowser(pages)
        const first = await manager.startOAuthFlow(SERVER_NAME, authorizationServer.url)
        await expect(first?.result).rejects.toThrow()
        const second = await manager.startOAuthFlow(SERVER_NAME, authorizationServer.url)
        await second?.result

        expect(pages.map((page) => page.status)).toEqual([500, 200])
        expect((await provider.tokens())?.access_token).toBe("access-token-1")
    })

    it("keeps a web host callback such as the VS Code Web external URI and gives every click a fresh state", async () => {
        hostCallback.base = "https://codespace-1.github.dev/callback"
        manager = createManager(async () => {})
        const provider = await manager.getOrCreateProvider(SERVER_NAME, authorizationServer.url)

        expect(await auth(provider, { serverUrl: authorizationServer.url })).toBe("REDIRECT")
        expect(authorizationServer.registeredRedirects[0][0].startsWith("https://codespace-1.github.dev/callback/")).toBe(true)

        const openedStates: string[] = []
        browser.open = async (url) => {
            openedStates.push(new URL(url).searchParams.get("state") ?? "")
        }
        expect(await manager.startOAuthFlow(SERVER_NAME, authorizationServer.url)).toBeUndefined()
        await manager.startOAuthFlow(SERVER_NAME, authorizationServer.url)

        const serverHash = new URL(authorizationServer.registeredRedirects[0][0]).pathname.split("/").pop() ?? ""
        expect(openedStates[0]).not.toBe(openedStates[1])
        expect(manager.validateAndClearState(serverHash, openedStates[1])).toBe(true)
    })

    it("registers a new callback port when the registered one is taken before the user authenticates", async () => {
        manager = createManager(async () => {})
        const provider = await manager.getOrCreateProvider(SERVER_NAME, authorizationServer.url)
        await auth(provider, { serverUrl: authorizationServer.url })
        const registeredPort = Number(new URL(authorizationServer.registeredRedirects[0][0]).port)

        const blocker = net.createServer()
        await new Promise<void>((resolve) => blocker.listen(registeredPort, "127.0.0.1", resolve))
        try {
            let opened = false
            browser.open = async () => {
                opened = true
            }
            await expect(manager.startOAuthFlow(SERVER_NAME, authorizationServer.url)).rejects.toBeInstanceOf(
                McpOAuthReregistrationRequiredError,
            )
            expect(opened).toBe(false)

            const replacement = await manager.getOrCreateProvider(SERVER_NAME, authorizationServer.url)
            expect(await auth(replacement, { serverUrl: authorizationServer.url })).toBe("REDIRECT")
            expect(authorizationServer.registeredRedirects).toHaveLength(2)
            expect(Number(new URL(authorizationServer.registeredRedirects[1][0]).port)).not.toBe(registeredPort)
        } finally {
            await new Promise<void>((resolve) => blocker.close(() => resolve()))
        }
    })
})
