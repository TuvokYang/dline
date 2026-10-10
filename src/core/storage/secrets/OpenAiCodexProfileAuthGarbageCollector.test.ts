import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { OpenAiCodexProfileAuthGarbageCollector } from "./OpenAiCodexProfileAuthGarbageCollector"
import { getLegacyHashedOpenAiCodexProfileAuthPath, getLegacyOpenAiCodexAuthPath } from "./OpenAiCodexProfileAuthPath"
import { OpenAiCodexProfileAuthRepository, type OpenAiOAuthCredentials } from "./OpenAiCodexProfileAuthRepository"

const credentials: OpenAiOAuthCredentials = {
    access_token: "access",
    refresh_token: "refresh",
    expires: 1_900_000_000_000,
}

describe("OpenAiCodexProfileAuthGarbageCollector", () => {
    let root: string
    let secretsDir: string
    let repository: OpenAiCodexProfileAuthRepository
    let collector: OpenAiCodexProfileAuthGarbageCollector

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-codex-auth-gc-"))
        secretsDir = path.join(root, "data", "secrets")
        repository = new OpenAiCodexProfileAuthRepository({ secretsDir })
        collector = new OpenAiCodexProfileAuthGarbageCollector({ secretsDir })
        await repository.save("retained-profile", credentials)
        await repository.save("deleted-profile", { ...credentials, access_token: "deleted" })
        await repository.save("switched-profile", { ...credentials, access_token: "switched" })
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("removes deleted and provider-switched credentials while retaining same-ID edits", async () => {
        const result = await collector.collect([
            { id: "retained-profile", provider: "openai-codex", name: "Renamed", modelId: "new-model" },
            { id: "switched-profile", provider: "openai" },
            { id: "duplicated-profile", provider: "openai-codex" },
        ])

        expect(result.deletedFileNames).toHaveLength(2)
        await expect(repository.read("retained-profile")).resolves.toMatchObject({ status: "valid" })
        await expect(repository.read("deleted-profile")).resolves.toEqual({ status: "missing" })
        await expect(repository.read("switched-profile")).resolves.toEqual({ status: "missing" })
        await expect(repository.read("duplicated-profile")).resolves.toEqual({ status: "missing" })
    })

    it("normalizes retained credentials to one Profile-ID file and deletes orphaned hashed files", async () => {
        const duplicateLegacyPath = getLegacyHashedOpenAiCodexProfileAuthPath(secretsDir, "retained-profile")
        const orphanedLegacyPath = getLegacyHashedOpenAiCodexProfileAuthPath(secretsDir, "orphaned-profile")
        await fs.writeFile(duplicateLegacyPath, JSON.stringify({ ...credentials, access_token: "stale-retained" }), "utf8")
        await fs.writeFile(orphanedLegacyPath, JSON.stringify({ ...credentials, access_token: "orphaned" }), "utf8")

        const result = await collector.collect([{ id: "retained-profile", provider: "openai-codex" }])

        await expect(repository.read("retained-profile")).resolves.toMatchObject({
            status: "valid",
            credential: { access_token: "access" },
        })
        await expect(fs.access(duplicateLegacyPath)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(orphanedLegacyPath)).rejects.toMatchObject({ code: "ENOENT" })
        expect(result.deletedFileNames).toContain(path.basename(orphanedLegacyPath))
    })

    it("does not delete the legacy shared source or unrelated secret files", async () => {
        const legacyPath = getLegacyOpenAiCodexAuthPath(secretsDir)
        const unrelatedPath = path.join(secretsDir, "api_keys.json")
        await fs.writeFile(legacyPath, JSON.stringify(credentials), "utf8")
        await fs.writeFile(unrelatedPath, "{}", "utf8")

        await collector.collect([{ id: "retained-profile", provider: "openai-codex" }])

        await expect(fs.access(legacyPath)).resolves.toBeUndefined()
        await expect(fs.access(unrelatedPath)).resolves.toBeUndefined()
    })
})
