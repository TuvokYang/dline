import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { OpenAiCodexProfileAuthMigration } from "./OpenAiCodexProfileAuthMigration"
import { getLegacyOpenAiCodexAuthMigrationPath, getLegacyOpenAiCodexAuthPath } from "./OpenAiCodexProfileAuthPath"
import { OpenAiCodexProfileAuthRepository, type OpenAiOAuthCredentials } from "./OpenAiCodexProfileAuthRepository"

const credentials: OpenAiOAuthCredentials = {
    type: "openai-codex",
    access_token: "legacy-access",
    refresh_token: "legacy-refresh",
    expires: 1_900_000_000_000,
}

const codexProfile = (id: string) => ({ id, provider: "openai-codex" })

describe("OpenAiCodexProfileAuthMigration", () => {
    let root: string
    let secretsDir: string
    let repository: OpenAiCodexProfileAuthRepository
    let migration: OpenAiCodexProfileAuthMigration

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-codex-auth-migration-"))
        secretsDir = path.join(root, "data", "secrets")
        repository = new OpenAiCodexProfileAuthRepository({ secretsDir })
        migration = new OpenAiCodexProfileAuthMigration({ secretsDir, repository })
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    async function writeLegacy(value: unknown): Promise<string> {
        const legacyPath = getLegacyOpenAiCodexAuthPath(secretsDir)
        await fs.mkdir(secretsDir, { recursive: true })
        await fs.writeFile(legacyPath, JSON.stringify(value), { mode: 0o600 })
        return legacyPath
    }

    it("moves a valid legacy credential to the only Codex profile without exposing unknown secret fields", async () => {
        const legacyPath = await writeLegacy({ ...credentials, provider_private_claim: "private-value" })
        await expect(migration.migrate([codexProfile("profile-a")])).resolves.toEqual({
            status: "migrated",
            profileId: "profile-a",
        })
        await expect(repository.read("profile-a")).resolves.toEqual({ status: "valid", credential: credentials })
        expect(JSON.parse(await fs.readFile(repository.filePath("profile-a"), "utf8"))).toMatchObject({
            provider_private_claim: "private-value",
        })
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("does not copy a rotating refresh token when multiple legacy Codex profiles exist", async () => {
        const legacyPath = await writeLegacy(credentials)
        await expect(migration.migrate([codexProfile("profile-a"), codexProfile("profile-b")])).resolves.toEqual({
            status: "legacy-shared",
            profileIds: ["profile-a", "profile-b"],
        })
        await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
        await expect(repository.read("profile-b")).resolves.toEqual({ status: "missing" })
        await expect(fs.access(legacyPath)).resolves.toBeUndefined()
        expect(JSON.parse(await fs.readFile(getLegacyOpenAiCodexAuthMigrationPath(secretsDir), "utf8"))).toEqual({
            schemaVersion: 1,
            mode: "legacy-shared",
            profileIds: ["profile-a", "profile-b"],
        })
    })

    it("persists the shared decision across restarts and retires it only after every original profile is resolved", async () => {
        const legacyPath = await writeLegacy(credentials)
        const markerPath = getLegacyOpenAiCodexAuthMigrationPath(secretsDir)
        await migration.migrate([codexProfile("profile-a"), codexProfile("profile-b")])

        const restarted = new OpenAiCodexProfileAuthMigration({ secretsDir, repository })
        await expect(restarted.migrate([codexProfile("profile-b")])).resolves.toEqual({
            status: "legacy-shared",
            profileIds: ["profile-b"],
        })
        await expect(repository.read("profile-b")).resolves.toEqual({ status: "missing" })
        await expect(fs.access(legacyPath)).resolves.toBeUndefined()

        await repository.save("profile-b", {
            ...credentials,
            access_token: "independent-access",
            refresh_token: "independent-refresh",
        })
        await expect(restarted.migrate([codexProfile("profile-b")])).resolves.toEqual({ status: "legacy-retired" })
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("fails closed when the durable legacy-shared marker is malformed", async () => {
        const legacyPath = await writeLegacy(credentials)
        const markerPath = getLegacyOpenAiCodexAuthMigrationPath(secretsDir)
        const tokenBearingMarker = {
            schemaVersion: 1,
            mode: "legacy-shared",
            profileIds: ["profile-a"],
            access_token: "must-not-be-accepted",
        }
        await fs.writeFile(markerPath, JSON.stringify(tokenBearingMarker), "utf8")

        await expect(migration.migrate([codexProfile("profile-a")])).resolves.toEqual({ status: "malformed-marker" })
        await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
        await expect(fs.access(legacyPath)).resolves.toBeUndefined()
        expect(JSON.parse(await fs.readFile(markerPath, "utf8"))).toEqual(tokenBearingMarker)
    })

    it("preserves a malformed legacy source and returns a non-secret diagnostic", async () => {
        const legacyPath = getLegacyOpenAiCodexAuthPath(secretsDir)
        await fs.mkdir(secretsDir, { recursive: true })
        await fs.writeFile(legacyPath, "{malformed", "utf8")

        await expect(migration.migrate([codexProfile("profile-a")])).resolves.toEqual({ status: "malformed-legacy" })
        expect(await fs.readFile(legacyPath, "utf8")).toBe("{malformed")
    })

    it("is idempotent after the destination is durable but before the legacy source is removed", async () => {
        const legacyPath = await writeLegacy(credentials)
        await repository.save("profile-a", { ...credentials, access_token: "newer-access", refresh_token: "newer-refresh" })

        await expect(migration.migrate([codexProfile("profile-a")])).resolves.toEqual({
            status: "already-isolated",
            profileId: "profile-a",
        })
        await expect(repository.read("profile-a")).resolves.toMatchObject({
            status: "valid",
            credential: { access_token: "newer-access", refresh_token: "newer-refresh" },
        })
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("does not consume data/secrets.json as a migration source", async () => {
        const forbiddenPath = path.join(root, "data", "secrets.json")
        await fs.mkdir(path.dirname(forbiddenPath), { recursive: true })
        await fs.writeFile(forbiddenPath, JSON.stringify({ "openai-codex-oauth-credentials": JSON.stringify(credentials) }))

        await expect(migration.migrate([codexProfile("profile-a")])).resolves.toEqual({ status: "missing-legacy" })
        await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
        expect(await fs.readFile(forbiddenPath, "utf8")).toContain("openai-codex-oauth-credentials")
    })

    it("keeps the legacy source when no Codex profile can own it", async () => {
        const legacyPath = await writeLegacy(credentials)
        await expect(migration.migrate([{ id: "other", provider: "openai" }])).resolves.toEqual({ status: "unassigned-legacy" })
        await expect(fs.access(legacyPath)).resolves.toBeUndefined()
    })
})
