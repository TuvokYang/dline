import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    OpenAiCodexProfileAuthRepository,
    type OpenAiOAuthCredentials,
} from "@/core/storage/secrets/OpenAiCodexProfileAuthRepository"
import { OpenAiCodexProfileSessionRegistry, type OpenAiCodexRefreshStrategy } from "./session"
import { OpenAiCodexOAuthTokenError } from "./strategy"

const NOW = 1_900_000_000_000

function credential(owner: string, expires = NOW + 3_600_000): OpenAiOAuthCredentials {
    return {
        type: "openai-codex",
        access_token: `${owner}-access`,
        refresh_token: `${owner}-refresh`,
        expires,
        email: `${owner}@example.test`,
        accountId: `${owner}-account`,
    }
}

function jwt(payload: Record<string, unknown>): string {
    return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

function credentialWithoutRefresh(owner: string, expires = NOW + 3_600_000): OpenAiOAuthCredentials {
    return {
        type: "openai-codex",
        access_token: `${owner}-access`,
        expires,
        email: `${owner}@example.test`,
        accountId: `${owner}-account`,
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe("OpenAI Codex Profile OAuth session registry", () => {
    let root: string
    let repository: OpenAiCodexProfileAuthRepository

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-codex-profile-session-"))
        repository = new OpenAiCodexProfileAuthRepository({ secretsDir: path.join(root, "secrets") })
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(root, { recursive: true, force: true })
    })

    function registry(refreshCredential: OpenAiCodexRefreshStrategy["refreshCredential"]) {
        return new OpenAiCodexProfileSessionRegistry({
            repository,
            strategy: { refreshCredential },
            now: () => NOW,
        })
    }

    it("returns one credential snapshot per Profile without mixing account context", async () => {
        await repository.save("profile-a", credential("a"))
        await repository.save("profile-b", credential("b"))
        const sessions = registry(vi.fn())

        await expect(sessions.getCredentialContext("profile-a")).resolves.toEqual({
            accessToken: "a-access",
            expires: NOW + 3_600_000,
            accountId: "a-account",
        })
        await expect(sessions.getCredentialContext("profile-b")).resolves.toEqual({
            accessToken: "b-access",
            expires: NOW + 3_600_000,
            accountId: "b-account",
        })
    })

    it("prefers the official access-token account identity over a stale stored account ID", async () => {
        await repository.save("profile-a", {
            ...credential("a"),
            access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "access-token-account" } }),
            accountId: "stale-stored-account",
        })
        const sessions = registry(vi.fn())

        await expect(sessions.getCredentialContext("profile-a")).resolves.toEqual({
            accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "access-token-account" } }),
            expires: NOW + 3_600_000,
            accountId: "access-token-account",
        })
    })

    it("uses an unexpired credential without a refresh token", async () => {
        await repository.save("profile-a", credentialWithoutRefresh("a"))
        const refreshCredential = vi.fn()
        const sessions = registry(refreshCredential)

        await expect(sessions.getCredentialContext("profile-a")).resolves.toEqual({
            accessToken: "a-access",
            expires: NOW + 3_600_000,
            accountId: "a-account",
        })
        await expect(sessions.getAuthStatus("profile-a")).resolves.toBe("authenticated")
        expect(refreshCredential).not.toHaveBeenCalled()
    })

    it("does not refresh an expired credential without a refresh token", async () => {
        await repository.save("profile-a", credentialWithoutRefresh("a", NOW - 1))
        const refreshCredential = vi.fn()
        const sessions = registry(refreshCredential)

        await expect(sessions.getAuthStatus("profile-a")).resolves.toBe("reauthentication-required")
        await expect(sessions.getCredentialContext("profile-a")).resolves.toBeNull()
        await expect(sessions.forceRefreshCredentialContext("profile-a")).resolves.toBeNull()
        expect(refreshCredential).not.toHaveBeenCalled()
        await expect(repository.read("profile-a")).resolves.toMatchObject({
            status: "valid",
            credential: { access_token: "a-access" },
        })
    })

    it("deduplicates concurrent refreshes for the same Profile", async () => {
        await repository.save("profile-a", credential("a", NOW - 1))
        const gate = deferred<OpenAiOAuthCredentials>()
        const refreshCredential = vi.fn(() => gate.promise)
        const sessions = registry(refreshCredential)

        const first = sessions.getCredentialContext("profile-a")
        const second = sessions.forceRefreshCredentialContext("profile-a")
        await vi.waitFor(() => expect(refreshCredential).toHaveBeenCalledTimes(1))
        gate.resolve(credential("a-new"))

        await expect(Promise.all([first, second])).resolves.toEqual([
            { accessToken: "a-new-access", expires: NOW + 3_600_000, accountId: "a-new-account" },
            { accessToken: "a-new-access", expires: NOW + 3_600_000, accountId: "a-new-account" },
        ])
    })

    it("allows different Profiles to refresh in parallel", async () => {
        await repository.save("profile-a", credential("a"))
        await repository.save("profile-b", credential("b"))
        const gates = {
            a: deferred<OpenAiOAuthCredentials>(),
            b: deferred<OpenAiOAuthCredentials>(),
        }
        const refreshCredential = vi.fn((current: OpenAiOAuthCredentials) =>
            current.access_token === "a-access" ? gates.a.promise : gates.b.promise,
        )
        const sessions = registry(refreshCredential)

        const profileA = sessions.forceRefreshCredentialContext("profile-a")
        const profileB = sessions.forceRefreshCredentialContext("profile-b")
        await vi.waitFor(() => expect(refreshCredential).toHaveBeenCalledTimes(2))
        gates.b.resolve(credential("b-new"))
        await expect(profileB).resolves.toMatchObject({ accessToken: "b-new-access", accountId: "b-new-account" })
        gates.a.resolve(credential("a-new"))
        await expect(profileA).resolves.toMatchObject({ accessToken: "a-new-access", accountId: "a-new-account" })
    })

    it("does not let an old refresh overwrite a newly saved browser credential", async () => {
        await repository.save("profile-a", credential("old"))
        const gate = deferred<OpenAiOAuthCredentials>()
        const refreshCredential = vi.fn(() => gate.promise)
        const sessions = registry(refreshCredential)

        const refresh = sessions.forceRefreshCredentialContext("profile-a")
        await vi.waitFor(() => expect(refreshCredential).toHaveBeenCalledOnce())
        await sessions.saveCredential("profile-a", credential("browser"))
        gate.resolve(credential("stale-refresh"))

        await expect(refresh).resolves.toMatchObject({ accessToken: "browser-access", accountId: "browser-account" })
        await expect(repository.read("profile-a")).resolves.toEqual({
            status: "valid",
            credential: credential("browser"),
        })
    })

    it("does not let an old refresh resurrect a signed-out Profile", async () => {
        await repository.save("profile-a", credential("old"))
        const gate = deferred<OpenAiOAuthCredentials>()
        const refreshCredential = vi.fn(() => gate.promise)
        const sessions = registry(refreshCredential)

        const refresh = sessions.forceRefreshCredentialContext("profile-a")
        await vi.waitFor(() => expect(refreshCredential).toHaveBeenCalledOnce())
        await sessions.clearCredential("profile-a")
        gate.resolve(credential("stale-refresh"))

        await expect(refresh).resolves.toBeNull()
        await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
    })

    it("marks only the Profile whose refresh token received invalid_grant", async () => {
        await repository.save("profile-a", credential("a"))
        await repository.save("profile-b", credential("b"))
        const refreshCredential = vi.fn(async (current: OpenAiOAuthCredentials) => {
            if (current.access_token === "a-access") {
                throw new OpenAiCodexOAuthTokenError("INVALID_GRANT", "The OAuth refresh credential is no longer valid.", 400)
            }
            return credential("b-new")
        })
        const sessions = registry(refreshCredential)

        await expect(sessions.forceRefreshCredentialContext("profile-a")).resolves.toBeNull()
        await expect(sessions.getAuthStatus("profile-a")).resolves.toBe("reauthentication-required")
        await expect(sessions.forceRefreshCredentialContext("profile-b")).resolves.toMatchObject({ accessToken: "b-new-access" })
        await expect(sessions.getAuthStatus("profile-b")).resolves.toBe("authenticated")
        await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
        await expect(repository.read("profile-b")).resolves.toMatchObject({
            status: "valid",
            credential: { access_token: "b-new-access" },
        })
    })

    it("distinguishes missing, malformed and refreshable-expired Profile states", async () => {
        const sessions = registry(vi.fn())
        await expect(sessions.getAuthStatus("missing-profile")).resolves.toBe("missing")
        await fs.mkdir(repository.secretsDir, { recursive: true })
        await fs.writeFile(repository.filePath("malformed-profile"), "{malformed", "utf8")
        await repository.save("expired-profile", credential("expired", NOW - 1))

        await expect(sessions.getAuthStatus("malformed-profile")).resolves.toBe("malformed")
        await expect(sessions.getAuthStatus("expired-profile")).resolves.toBe("refreshable-expired")
    })
})
