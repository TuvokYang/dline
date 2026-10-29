import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    getLegacyOpenAiCodexAuthPath,
    OpenAiCodexProfileAuthRepository,
    type OpenAiOAuthCredentials,
} from "@/core/storage/secrets"
import { OpenAiCodexOAuthManager } from "./oauth"
import { OpenAiCodexOAuthStrategy, OpenAiCodexOAuthTokenError, resolveOpenAiCodexAccessTokenAccountId } from "./strategy"

const NOW = 1_900_000_000_000

function credentials(owner: string): OpenAiOAuthCredentials {
    return {
        type: "openai-codex",
        access_token: `${owner}-access`,
        refresh_token: `${owner}-refresh`,
        expires: NOW + 3_600_000,
        email: `${owner}@example.test`,
        accountId: `${owner}-account`,
        accountType: "pro",
    }
}

function jwt(payload: Record<string, unknown>): string {
    return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

describe("OpenAI Codex OAuth strategy and Profile storage", () => {
    let root: string
    let secretsDir: string
    let repository: OpenAiCodexProfileAuthRepository

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-codex-session-storage-"))
        secretsDir = path.join(root, "data", "secrets")
        repository = new OpenAiCodexProfileAuthRepository({ secretsDir })
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(root, { recursive: true, force: true })
    })

    it("stores and resolves credentials only by stable Profile ID", async () => {
        const manager = new OpenAiCodexOAuthManager({
            repository,
            profileCatalogLoader: async () => [
                { id: "profile-a", provider: "openai-codex" },
                { id: "profile-b", provider: "openai-codex" },
            ],
        })
        await manager.saveCredentials("profile-a", credentials("a"))
        await manager.saveCredentials("profile-b", credentials("b"))

        await expect(repository.read("profile-a")).resolves.toEqual({ status: "valid", credential: credentials("a") })
        await expect(repository.read("profile-b")).resolves.toEqual({ status: "valid", credential: credentials("b") })
        await expect(manager.getCredentialContext("profile-a")).resolves.toMatchObject({ accessToken: "a-access" })
        await expect(manager.getCredentialContext("profile-b")).resolves.toMatchObject({ accessToken: "b-access" })
        await expect(fs.access(path.join(root, "data", "secrets.json"))).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("runs the lazy Catalog migration once across repeated status queries", async () => {
        const profileCatalogLoader = vi.fn(async () => [{ id: "profile-a", provider: "openai-codex" }])
        const manager = new OpenAiCodexOAuthManager({ repository, profileCatalogLoader })

        await expect(manager.getAuthStatus("profile-a")).resolves.toBe("missing")
        await expect(manager.getAuthStatus("profile-a")).resolves.toBe("missing")
        expect(profileCatalogLoader).toHaveBeenCalledOnce()
    })

    it("lets an independently authorized Profile override a malformed legacy source", async () => {
        const legacyPath = getLegacyOpenAiCodexAuthPath(secretsDir)
        await fs.mkdir(secretsDir, { recursive: true })
        await fs.writeFile(legacyPath, "{malformed", "utf8")
        await repository.save("profile-a", credentials("a"))
        const manager = new OpenAiCodexOAuthManager({
            repository,
            profileCatalogLoader: async () => [{ id: "profile-a", provider: "openai-codex" }],
        })

        await expect(manager.getAuthStatus("profile-a")).resolves.toBe("authenticated")
        await expect(manager.getCredentialContext("profile-a")).resolves.toMatchObject({ accessToken: "a-access" })
        expect(await fs.readFile(legacyPath, "utf8")).toBe("{malformed")
    })

    it("lazily routes the dedicated legacy file through the Provider adapter without StateManager", async () => {
        const legacyPath = getLegacyOpenAiCodexAuthPath(secretsDir)
        await fs.mkdir(secretsDir, { recursive: true })
        await fs.writeFile(legacyPath, JSON.stringify(credentials("legacy")), { mode: 0o600 })
        const manager = new OpenAiCodexOAuthManager({
            repository,
            profileCatalogLoader: async () => [{ id: "profile-a", provider: "openai-codex" }],
        })

        await expect(manager.getCredentialContext("profile-a")).resolves.toMatchObject({
            accessToken: "legacy-access",
            accountId: "legacy-account",
        })
        await expect(repository.read("profile-a")).resolves.toEqual({ status: "valid", credential: credentials("legacy") })
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("keeps a shared legacy credential blocked until every original Profile is independently authorized", async () => {
        const legacyPath = getLegacyOpenAiCodexAuthPath(secretsDir)
        await fs.mkdir(secretsDir, { recursive: true })
        await fs.writeFile(legacyPath, JSON.stringify(credentials("legacy")), { mode: 0o600 })
        const manager = new OpenAiCodexOAuthManager({
            repository,
            profileCatalogLoader: async () => [
                { id: "profile-a", provider: "openai-codex" },
                { id: "profile-b", provider: "openai-codex" },
            ],
        })

        await expect(manager.getAuthStatus("profile-a")).resolves.toBe("legacy-shared")
        await expect(manager.getAuthStatus("profile-b")).resolves.toBe("legacy-shared")
        await manager.saveCredentials("profile-a", credentials("a"))
        await expect(manager.getAuthStatus("profile-a")).resolves.toBe("authenticated")
        await expect(manager.getAuthStatus("profile-b")).resolves.toBe("legacy-shared")
        await manager.saveCredentials("profile-b", credentials("b"))
        await expect(manager.getAuthStatus("profile-b")).resolves.toBe("authenticated")
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("builds the Codex authorization request and exchanges code without sending state", async () => {
        const fetchImpl = vi.fn(
            async (_input: string | URL | Request, _init?: RequestInit) =>
                new Response(
                    JSON.stringify({
                        access_token: jwt({
                            "https://api.openai.com/auth": { chatgpt_account_id: "account-from-access-token" },
                            chatgpt_account_id: "wrong-top-level-account",
                        }),
                        refresh_token: "new-refresh",
                        id_token: jwt({
                            "https://api.openai.com/auth": {
                                chatgpt_account_id: "wrong-id-token-account",
                                chatgpt_plan_type: "pro",
                            },
                        }),
                        expires_in: 3600,
                        email: "owner@example.test",
                    }),
                    { status: 200 },
                ),
        )
        const strategy = new OpenAiCodexOAuthStrategy({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })
        const authorizationUrl = strategy.buildAuthorizationUrl({
            redirectUri: "http://localhost:1455/auth/callback",
            codeChallenge: "challenge",
            state: "csrf-state",
        })

        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256")
        expect(authorizationUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true")
        expect(authorizationUrl.searchParams.get("id_token_add_organizations")).toBe("true")
        expect(authorizationUrl.searchParams.get("originator")).toBe("codex_cli_rs")
        expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
        expect(authorizationUrl.searchParams.get("scope")).toBe(
            "openid profile email offline_access api.connectors.read api.connectors.invoke",
        )
        expect(authorizationUrl.searchParams.get("state")).toBe("csrf-state")
        expect(strategy.callbackRedirectHost).toBe("localhost")
        await expect(
            strategy.exchangeAuthorizationCode({
                code: "authorization-code",
                codeVerifier: "verifier",
                redirectUri: "http://localhost:1455/auth/callback",
            }),
        ).resolves.toEqual({
            type: "openai-codex",
            access_token: jwt({
                "https://api.openai.com/auth": { chatgpt_account_id: "account-from-access-token" },
                chatgpt_account_id: "wrong-top-level-account",
            }),
            refresh_token: "new-refresh",
            expires: NOW + 3_600_000,
            email: "owner@example.test",
            accountId: "account-from-access-token",
            accountType: "pro",
        })
        const requestBody = String(fetchImpl.mock.calls[0]?.[1]?.body)
        expect(requestBody).toContain("code=authorization-code")
        expect(requestBody).toContain("code_verifier=verifier")
        expect(requestBody).not.toContain("csrf-state")
    })

    it("uses the official access-token account claim precedence", () => {
        expect(
            resolveOpenAiCodexAccessTokenAccountId(
                jwt({
                    "https://api.openai.com/auth": { chatgpt_account_id: "nested-account" },
                    organizations: [{ id: "default-organization", is_default: true }],
                    chatgpt_account_id: "top-level-account",
                }),
            ),
        ).toEqual({ accountId: "nested-account", source: "access-token-auth" })
        expect(
            resolveOpenAiCodexAccessTokenAccountId(
                jwt({
                    organizations: [
                        { id: "first-non-default", is_default: false },
                        { id: "default-organization", is_default: true },
                    ],
                    chatgpt_account_id: "top-level-account",
                }),
            ),
        ).toEqual({ accountId: "default-organization", source: "access-token-default-organization" })
        expect(
            resolveOpenAiCodexAccessTokenAccountId(
                jwt({
                    organizations: [{ id: "first-non-default", is_default: false }],
                    chatgpt_account_id: "top-level-account",
                }),
            ),
        ).toEqual({ accountId: "top-level-account", source: "access-token-top-level" })
    })

    it("rotates refresh credentials while preserving reusable strategy metadata", async () => {
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify({ access_token: "rotated-access", expires_in: 7200 }), { status: 200 }),
        )
        const strategy = new OpenAiCodexOAuthStrategy({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })
        const reusableCredential = { ...credentials("shared"), type: "gpt-team" }

        await expect(strategy.refreshCredential(reusableCredential)).resolves.toEqual({
            ...reusableCredential,
            access_token: "rotated-access",
            expires: NOW + 7_200_000,
        })
    })

    it("classifies invalid_grant without exposing the provider response", async () => {
        const secretPayload = "invalid_grant provider-refresh-token-must-not-leak"
        const strategy = new OpenAiCodexOAuthStrategy({
            fetchImpl: vi.fn(async () => new Response(secretPayload, { status: 400 })) as unknown as typeof fetch,
        })

        const error = await strategy.refreshCredential(credentials("a")).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(OpenAiCodexOAuthTokenError)
        expect(error).toMatchObject({ code: "INVALID_GRANT", status: 400 })
        expect(String(error)).not.toContain(secretPayload)
        expect(String(error)).not.toContain("a-refresh")
    })
})
