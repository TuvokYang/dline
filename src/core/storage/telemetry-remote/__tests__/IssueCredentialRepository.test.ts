import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deriveSupportCode } from "@/services/telemetry/remote/contracts/supportCode"
import { type IssueCredentialRecord, IssueCredentialRepository } from "../IssueCredentialRepository"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"

const START = 1_900_000_000_000
const CODE_A = "a".repeat(43)
const CODE_B = "b".repeat(43)

function record(authorizationCode = CODE_A, overrides: Partial<IssueCredentialRecord> = {}): IssueCredentialRecord {
    return {
        authorizationCode,
        publicCode: deriveSupportCode(authorizationCode),
        state: "awaiting_issue",
        revision: 0,
        authorizationExpiresAt: START + 60_000,
        ticketExpiresAt: START + 600_000,
        issueState: "unlinked",
        resolution: { state: "none" },
        pollAfterMs: 1_000,
        ...overrides,
    }
}

describe("IssueCredentialRepository", () => {
    let root: string
    let layout: OtelStorageLayout
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-support-credential-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        now = START
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository(onQuarantine = vi.fn()) {
        return { repository: new IssueCredentialRepository(layout, { clock: () => now, onQuarantine }), onQuarantine }
    }

    it("stores the complete ticket only in owner-only storage", async () => {
        const stored = repository().repository
        await stored.replace(record())

        await expect(new IssueCredentialRepository(layout).read()).resolves.toEqual({ record: record() })
        if (process.platform !== "win32") {
            expect((await fs.stat(layout.issueCredentialPath)).mode & 0o777).toBe(0o600)
            expect((await fs.stat(layout.secretsDir)).mode & 0o777).toBe(0o700)
        }
    })

    it("quarantines malformed bytes on a read instead of silently treating them as absent", async () => {
        await fs.mkdir(layout.secretsDir, { recursive: true })
        await fs.writeFile(layout.issueCredentialPath, "{not-json")
        const stored = repository()

        await expect(stored.repository.read()).resolves.toEqual({})
        expect(stored.onQuarantine).toHaveBeenCalledWith("issue-credential.json")
        const copies = await fs.readdir(layout.secretsQuarantineDir)
        expect(copies).toHaveLength(1)
        expect(await fs.readFile(path.join(layout.secretsQuarantineDir, copies[0]), "utf8")).toBe("{not-json")
    })

    it("quarantines a retired schema 1 control-plane record as loss evidence instead of migrating it", async () => {
        await fs.mkdir(layout.secretsDir, { recursive: true })
        const retired = JSON.stringify({
            schema_version: 1,
            record: { authorization_id: "authorization-1", public_code: "SUP-ABCD-1234", resume_credential: "resume" },
        })
        await fs.writeFile(layout.issueCredentialPath, retired)
        const stored = repository()

        await expect(stored.repository.read()).resolves.toEqual({})
        expect(stored.onQuarantine).toHaveBeenCalledWith("issue-credential.json")
        await expect(fs.access(layout.issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("refuses a ticket whose public code is not derived from its authorization code", async () => {
        const stored = repository().repository

        await expect(stored.replace(record(CODE_A, { publicCode: deriveSupportCode(CODE_B) }))).rejects.toThrow(
            "Invalid report authorization ticket",
        )
        await expect(fs.access(layout.issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("applies a status update only to the ticket it was queried for", async () => {
        const stored = repository().repository
        await stored.replace(record(CODE_A))
        const approved = {
            state: "approved" as const,
            revision: 1,
            captureExpiresAt: START + 30_000,
            issueState: "open" as const,
        }

        await expect(stored.update(CODE_A, (current) => ({ ...current, ...approved }))).resolves.toEqual(record(CODE_A, approved))
        // A newer report replaced the ticket while a status query for the old one was in flight.
        await stored.replace(record(CODE_B))
        await expect(stored.update(CODE_A, (current) => ({ ...current, state: "revoked" }))).resolves.toBeUndefined()
        await expect(stored.read()).resolves.toEqual({ record: record(CODE_B) })
    })

    it("deletes only the named ticket so a late refusal never removes a newer one", async () => {
        const stored = repository().repository
        await stored.replace(record(CODE_B))

        await stored.clear(CODE_A)
        await expect(stored.read()).resolves.toEqual({ record: record(CODE_B) })
        await stored.clear(CODE_B)
        await expect(fs.access(layout.issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
    })
})
