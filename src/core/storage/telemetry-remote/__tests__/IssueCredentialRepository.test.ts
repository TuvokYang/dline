import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type IssueCredentialRecord, IssueCredentialRepository } from "../IssueCredentialRepository"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"

const START = 1_900_000_000_000

function record(revision = 2, expiresAt = START + 60_000): IssueCredentialRecord {
    return {
        authorizationId: "authorization-1",
        publicCode: "SUP-ABCD-1234",
        resumeCredential: "resume-private-credential",
        state: "pending_approval",
        revision,
        authorizationExpiresAt: expiresAt,
        pollAfterMs: 1_000,
        issue: { owner: "TuvokYang", repo: "Dline", number: 115 },
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

    it("publishes the complete private record only in owner-only storage", async () => {
        const stored = repository().repository
        await stored.publish(record())

        await expect(new IssueCredentialRepository(layout).read()).resolves.toEqual({ record: record() })
        const raw = await fs.readFile(layout.issueCredentialPath, "utf8")
        expect(raw).toContain("resume-private-credential")
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

    it("replaces the live record with a tombstone that blocks the same revision", async () => {
        const stored = repository().repository
        await stored.publish(record(2))

        const tombstone = await stored.writeRevokeTombstone()

        expect(tombstone).toMatchObject({
            authorizationId: "authorization-1",
            resumeCredential: "resume-private-credential",
            expectedRevision: 2,
        })
        await expect(stored.read()).resolves.toEqual({ revokeTombstone: tombstone })
        await expect(stored.publish(record(2))).rejects.toThrow("revoked support authorization revision")
        await expect(stored.publish(record(3))).resolves.toBeUndefined()
        await expect(stored.read()).resolves.toEqual({ record: record(3) })
    })

    it("retains an offline revoke tombstone until confirmation or natural expiry", async () => {
        const stored = repository().repository
        await stored.publish(record(2, now + 10))
        await stored.writeRevokeTombstone()

        await stored.pruneNaturalExpiry(now + 9)
        await expect(fs.access(layout.issueCredentialPath)).resolves.toBeUndefined()
        await stored.pruneNaturalExpiry(now + 10)
        await expect(fs.access(layout.issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })

        await stored.publish(record(4, now + 100))
        await stored.writeRevokeTombstone()
        await stored.clearAfterConfirmedRevoke()
        await expect(fs.access(layout.issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
    })
})
