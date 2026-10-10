import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FileLock } from "../backend/jsonl/FileLock"
import {
    getLegacyHashedOpenAiCodexProfileAuthFileName,
    getLegacyHashedOpenAiCodexProfileAuthPath,
    getOpenAiCodexProfileAuthFileName,
    getOpenAiCodexProfileAuthPath,
} from "./OpenAiCodexProfileAuthPath"
import {
    OpenAiCodexProfileAuthRepository,
    type OpenAiOAuthCredentials,
    parseOpenAiOAuthCredentials,
} from "./OpenAiCodexProfileAuthRepository"

const credentials: OpenAiOAuthCredentials = {
    type: "gpt-team",
    access_token: "access-a",
    refresh_token: "refresh-a",
    expires: 1_900_000_000_000,
    email: "profile@example.test",
    accountId: "account-a",
    accountType: "team",
}

describe("OpenAiCodexProfileAuthRepository", () => {
    let root: string
    let secretsDir: string
    let repository: OpenAiCodexProfileAuthRepository

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-codex-profile-auth-"))
        secretsDir = path.join(root, "data", "secrets")
        repository = new OpenAiCodexProfileAuthRepository({ secretsDir })
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("uses the escaped Profile ID as a deterministic traversal-safe file suffix", () => {
        const fileName = getOpenAiCodexProfileAuthFileName("../../profile-a")
        const filePath = getOpenAiCodexProfileAuthPath(secretsDir, "../../profile-a")

        expect(fileName).toBe("openai_codex_oauth_..%2F..%2Fprofile-a.json")
        expect(getOpenAiCodexProfileAuthFileName("profile-a")).toBe("openai_codex_oauth_profile-a.json")
        expect(getLegacyHashedOpenAiCodexProfileAuthFileName("../../profile-a")).toBe(
            "openai_codex_1ba7dff874a224231bbcf39de2baacad.json",
        )
        expect(path.dirname(filePath)).toBe(path.resolve(secretsDir))
    })

    it("stores two profiles in two independent atomic credential files", async () => {
        await repository.save("profile-a", credentials)
        await repository.save("profile-b", { ...credentials, access_token: "access-b", refresh_token: "refresh-b" })

        const pathA = repository.filePath("profile-a")
        const pathB = repository.filePath("profile-b")
        expect(pathA).not.toBe(pathB)
        await expect(repository.read("profile-a")).resolves.toMatchObject({
            status: "valid",
            credential: { access_token: "access-a" },
        })
        await expect(repository.read("profile-b")).resolves.toMatchObject({
            status: "valid",
            credential: { access_token: "access-b" },
        })
        expect((await fs.readdir(secretsDir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
        await expect(fs.access(path.join(root, "data", "secrets.json"))).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(path.join(secretsDir, "api_keys.json"))).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("migrates one legacy hashed file to the Profile-ID path without losing private fields", async () => {
        const legacyPath = getLegacyHashedOpenAiCodexProfileAuthPath(secretsDir, "profile-a")
        await fs.mkdir(secretsDir, { recursive: true })
        await fs.writeFile(legacyPath, JSON.stringify({ ...credentials, provider_private_claim: "private-value" }), {
            mode: 0o600,
        })

        await expect(repository.read("profile-a")).resolves.toEqual({ status: "valid", credential: credentials })
        expect(JSON.parse(await fs.readFile(repository.filePath("profile-a"), "utf8"))).toMatchObject({
            access_token: "access-a",
            provider_private_claim: "private-value",
        })
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it.skipIf(process.platform === "win32")("writes owner-only file permissions", async () => {
        await repository.save("profile-a", credentials)
        const stat = await fs.stat(repository.filePath("profile-a"))
        expect(stat.mode & 0o777).toBe(0o600)
    })

    it("accepts an optional refresh token and a missing or non-Codex type", () => {
        expect(parseOpenAiOAuthCredentials({ ...credentials, type: undefined })).toMatchObject({ access_token: "access-a" })
        expect(parseOpenAiOAuthCredentials({ ...credentials, type: "cloud-code" })).toMatchObject({ type: "cloud-code" })
        expect(parseOpenAiOAuthCredentials({ ...credentials, refresh_token: undefined })).not.toHaveProperty("refresh_token")
        expect(() => parseOpenAiOAuthCredentials({ ...credentials, access_token: "" })).toThrow(/access_token/)
        expect(() => parseOpenAiOAuthCredentials({ ...credentials, refresh_token: "" })).toThrow(/refresh_token/)
        expect(() => parseOpenAiOAuthCredentials({ ...credentials, refresh_token: 42 })).toThrow(/refresh_token/)
        expect(() => parseOpenAiOAuthCredentials({ ...credentials, expires: 123 })).toThrow(/expires/)
    })

    it("persists a credential without synthesizing a refresh token", async () => {
        const withoutRefreshToken: OpenAiOAuthCredentials = {
            type: "openai-codex",
            access_token: "access-only",
            expires: 1_900_000_000_000,
        }

        await repository.save("profile-a", withoutRefreshToken)

        await expect(repository.read("profile-a")).resolves.toEqual({
            status: "valid",
            credential: withoutRefreshToken,
        })
        expect(JSON.parse(await fs.readFile(repository.filePath("profile-a"), "utf8"))).not.toHaveProperty("refresh_token")
    })

    it("atomically imports a credential without refresh token and preserves only its unknown secret fields", async () => {
        await repository.save("profile-a", credentials)
        await fs.writeFile(
            repository.filePath("profile-a"),
            JSON.stringify({ ...credentials, stale_private_claim: "stale-value" }),
            "utf8",
        )

        const imported = await repository.importCredential("profile-a", {
            type: "gpt-team",
            access_token: "manual-access",
            expires: 1_900_000_000_000,
            provider_private_claim: "private-value",
        })

        expect(imported).toEqual({ type: "gpt-team", access_token: "manual-access", expires: 1_900_000_000_000 })
        const stored = JSON.parse(await fs.readFile(repository.filePath("profile-a"), "utf8"))
        expect(stored).toMatchObject({
            type: "gpt-team",
            access_token: "manual-access",
            provider_private_claim: "private-value",
        })
        expect(stored).not.toHaveProperty("refresh_token")
        expect(stored).not.toHaveProperty("stale_private_claim")
    })

    it("keeps unknown fields only in the secret file and never exposes them from reads", async () => {
        await fs.mkdir(secretsDir, { recursive: true })
        await fs.writeFile(
            repository.filePath("profile-a"),
            JSON.stringify({ ...credentials, provider_private_claim: "private-value" }),
            { mode: 0o600 },
        )

        const read = await repository.read("profile-a")
        expect(read).toEqual({ status: "valid", credential: credentials })
        await repository.save("profile-a", { ...credentials, access_token: "rotated" })
        expect(JSON.parse(await fs.readFile(repository.filePath("profile-a"), "utf8"))).toMatchObject({
            access_token: "rotated",
            provider_private_claim: "private-value",
        })
    })

    it("reports malformed files without deleting or replacing them", async () => {
        await fs.mkdir(secretsDir, { recursive: true })
        const filePath = repository.filePath("profile-a")
        await fs.writeFile(filePath, "{malformed", "utf8")

        await expect(repository.read("profile-a")).resolves.toMatchObject({ status: "malformed" })
        expect(await fs.readFile(filePath, "utf8")).toBe("{malformed")
    })

    it("uses the shared file lock for same-profile writes", async () => {
        await fs.mkdir(secretsDir, { recursive: true })
        const filePath = repository.filePath("profile-a")
        const externalLock = new FileLock()
        await externalLock.acquire(filePath)
        try {
            await expect(repository.save("profile-a", credentials)).rejects.toThrow(/Failed to acquire lock/)
        } finally {
            await externalLock.release(filePath)
        }
    })

    it("deletes both current and legacy files only for the requested profile", async () => {
        await repository.save("profile-a", credentials)
        await repository.save("profile-b", { ...credentials, access_token: "access-b" })
        const legacyPathA = getLegacyHashedOpenAiCodexProfileAuthPath(secretsDir, "profile-a")
        await fs.writeFile(legacyPathA, JSON.stringify({ ...credentials, access_token: "stale-access" }), "utf8")

        await repository.delete("profile-a")

        await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
        await expect(fs.access(repository.filePath("profile-a"))).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(legacyPathA)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(repository.read("profile-b")).resolves.toMatchObject({ status: "valid" })
    })
})
