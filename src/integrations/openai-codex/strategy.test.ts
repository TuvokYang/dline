import { describe, expect, it, vi } from "vitest"
import { OpenAiCodexOAuthStrategy } from "./strategy"

const NOW = 1_900_000_000_000

describe("OpenAiCodexOAuthStrategy", () => {
    it("accepts an authorization-code response without a refresh token", async () => {
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify({ access_token: "access-only", expires_in: 3600 }), { status: 200 }),
        ) as unknown as typeof fetch
        const strategy = new OpenAiCodexOAuthStrategy({
            configuration: { tokenEndpoint: "https://token.example.test" },
            fetchImpl,
            now: () => NOW,
        })

        await expect(
            strategy.exchangeAuthorizationCode({
                code: "authorization-code",
                codeVerifier: "verifier",
                redirectUri: "http://localhost:1455/auth/callback",
            }),
        ).resolves.toEqual({
            type: "openai-codex",
            access_token: "access-only",
            expires: NOW + 3_600_000,
        })
    })

    it("rejects refresh without a refresh token before making a network request", async () => {
        const fetchImpl = vi.fn()
        const strategy = new OpenAiCodexOAuthStrategy({ fetchImpl: fetchImpl as unknown as typeof fetch })

        await expect(
            strategy.refreshCredential({
                type: "openai-codex",
                access_token: "access-only",
                expires: NOW + 3_600_000,
            }),
        ).rejects.toMatchObject({
            code: "REFRESH_TOKEN_UNAVAILABLE",
        })
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})
