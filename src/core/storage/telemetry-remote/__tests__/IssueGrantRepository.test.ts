import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AtomicIssueGrant } from "@/services/telemetry/remote/contracts/issueGrant"
import { IssueGrantRepository } from "../IssueGrantRepository"
import { resolveOtelStorageLayout } from "../OtelStorageLayout"

const START = 1_900_000_000_000

function grant(revision: number, expiresAt = START + 60_000): AtomicIssueGrant {
    return {
        accessToken: String(revision).repeat(43),
        profile: "issue_diagnostic",
        scopes: ["error", "runtime", "debug", "metrics", "traces"],
        authorizationId: "auth-fixture-001",
        authorizationRevision: revision,
        expiresAt,
        captureExpiresAt: expiresAt,
        rateLimits: { maxBytes: 8 * 1024 * 1024, maxRequests: 120, maxRecords: 20_000 },
    }
}

describe("IssueGrantRepository", () => {
    let root: string
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-issue-grant-"))
        now = START
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository(): IssueGrantRepository {
        return new IssueGrantRepository(resolveOtelStorageLayout(path.join(root, "data")), { clock: () => now })
    }

    it("publishes and reads one complete owner-only issue credential generation", async () => {
        const stored = repository()
        await stored.publish(grant(2))

        await expect(repository().readActive(now, 2)).resolves.toEqual(grant(2))
        await expect(repository().readActive(now, 1)).resolves.toBeNull()
        const filePath = path.join(root, "data", "secrets", "otel", "issue-grant.json")
        if (process.platform !== "win32") expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600)
    })

    it("keeps a tombstone that blocks crash recovery from republishing the same revision", async () => {
        const stored = repository()
        await stored.publish(grant(2))
        await stored.clear("revoked")

        await expect(stored.readActive(now, 2)).resolves.toBeNull()
        await expect(stored.publish(grant(2))).rejects.toThrow("revoked issue grant revision")
        const raw = await fs.readFile(path.join(root, "data", "secrets", "otel", "issue-grant.json"), "utf8")
        expect(raw).not.toContain(grant(2).accessToken)
        expect(raw).toContain('"reason": "revoked"')
    })

    it("accepts a higher revision backed by a new exchange ticket and removes the older tombstone", async () => {
        const stored = repository()
        await stored.publish(grant(2))
        await stored.clear("revision_changed")

        await stored.publish(grant(3))

        await expect(stored.readActive(now, 3)).resolves.toEqual(grant(3))
        const raw = await fs.readFile(path.join(root, "data", "secrets", "otel", "issue-grant.json"), "utf8")
        expect(raw).not.toContain("tombstone")
    })

    it("rejects expired publication and removes a tombstone only after natural expiry", async () => {
        const stored = repository()
        await expect(stored.publish(grant(2, now))).rejects.toThrow("expired issue grant")
        await stored.publish(grant(2, now + 10))
        await stored.clear("expired")

        await stored.pruneNaturalExpiry(now + 9)
        await expect(fs.stat(path.join(root, "data", "secrets", "otel", "issue-grant.json"))).resolves.toBeDefined()
        await stored.pruneNaturalExpiry(now + 10)
        await expect(fs.stat(path.join(root, "data", "secrets", "otel", "issue-grant.json"))).rejects.toMatchObject({
            code: "ENOENT",
        })
    })
})
