import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AtomicIssueGrant } from "@/services/telemetry/remote/contracts/issueGrant"
import { FileLock } from "../../backend/jsonl/FileLock"
import { IssueGrantRepository } from "../IssueGrantRepository"
import { resolveOtelStorageLayout } from "../OtelStorageLayout"

const START = 1_900_000_000_000

const ioGate = vi.hoisted(() => ({
    /** A rename this test parks, so a publisher can be held between its temporary write and its publication. */
    parkBefore: undefined as { destination: string; reached: () => void; release: Promise<void> } | undefined,
    /** A read this test fails once, so a read error can be injected without patching the module namespace. */
    failNextRead: undefined as Error | undefined,
}))

// `writeJsonAtomic` publishes with a rename, so parking that rename is the only way to
// observe a publisher that holds the lease while the target document is still absent.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>()
    const rename: typeof actual.rename = async (source, destination) => {
        const gate = ioGate.parkBefore
        if (gate && String(destination) === gate.destination) {
            ioGate.parkBefore = undefined
            gate.reached()
            await gate.release
        }
        return actual.rename(source, destination)
    }
    // Every reader in this path asks for "utf8"; the cast only bridges the overload set.
    const readFile: typeof actual.readFile = (async (target: string, encoding: BufferEncoding) => {
        const failure = ioGate.failNextRead
        if (failure) {
            ioGate.failNextRead = undefined
            throw failure
        }
        return actual.readFile(target, encoding)
    }) as typeof actual.readFile
    return { ...actual, readFile, rename, default: { ...actual, readFile, rename } }
})

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
        // An injected gate or failure that survived its test would affect the next one.
        ioGate.parkBefore = undefined
        ioGate.failNextRead = undefined
        vi.restoreAllMocks()
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository(): IssueGrantRepository {
        return new IssueGrantRepository(resolveOtelStorageLayout(path.join(root, "data")), { clock: () => now })
    }

    function grantPath(): string {
        return path.join(root, "data", "secrets", "otel", "issue-grant.json")
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

    it("does not ask for the lock when a publication would rewrite the same grant", async () => {
        const stored = repository()
        await stored.publish(grant(2))
        const acquire = vi.spyOn(FileLock.prototype, "acquire")
        let acquisitions = 0
        try {
            await stored.publish(grant(2))
            acquisitions = acquire.mock.calls.length
        } finally {
            acquire.mockRestore()
        }

        // A second extension host republishing the live grant is the common case;
        // taking the lock would queue it behind owners with nothing to write.
        expect(acquisitions).toBe(0)
        await expect(repository().readActive(now, 2)).resolves.toEqual(grant(2))
    })

    it("refuses to republish the same generation once its window has closed", async () => {
        const stored = repository()
        await stored.publish(grant(2))

        // The stored copy is unchanged, but equal is not live: resolving here would
        // report a publication that readActive already refuses to hand out.
        now = START + 60_000
        await expect(stored.publish(grant(2))).rejects.toThrow("expired issue grant")
        await expect(stored.readActive(now, 2)).resolves.toBeNull()
    })

    it("does not ask for the lock when there is nothing to prune", async () => {
        const stored = repository()
        const acquire = vi.spyOn(FileLock.prototype, "acquire")
        let acquisitions = 0
        try {
            await stored.pruneNaturalExpiry(now)
            acquisitions = acquire.mock.calls.length
        } finally {
            acquire.mockRestore()
        }

        expect(acquisitions).toBe(0)
        await expect(fs.stat(grantPath())).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("asks for the lock on clear even when the data directory holds no grant", async () => {
        const stored = repository()
        const acquire = vi.spyOn(FileLock.prototype, "acquire")
        let acquisitions = 0
        try {
            await stored.clear("deleted")
            acquisitions = acquire.mock.calls.length
        } finally {
            acquire.mockRestore()
        }

        // An empty directory is the answer this call is least able to establish
        // without the lock: a publisher that has written its temporary file but not
        // yet renamed leaves no target, and read() maps every failure to "absent".
        expect(acquisitions).toBe(1)
        await expect(fs.stat(grantPath())).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("reports a failed read as a failed revocation instead of a completed one", async () => {
        const stored = repository()
        await stored.publish(grant(2))
        ioGate.failNextRead = Object.assign(new Error("permission denied"), { code: "EACCES" })

        try {
            // The lock-free reader behind read() answers {} for this, so a lock-free
            // clear would resolve and let the caller purge the outbox and the token
            // while the grant on disk stays valid.
            await expect(stored.clear("revoked")).rejects.toThrow("permission denied")
        } finally {
            ioGate.failNextRead = undefined
        }

        await expect(repository().readActive(now, 2)).resolves.toEqual(grant(2))
    })

    it("revokes a first publication that is still parked before its rename", async () => {
        // A publishes grant 2 while B revokes. A holds the lease with its temporary
        // file written and the target still absent, which is the one state in which a
        // lock-free reader in B cannot see that a publication is in flight. B must
        // wait for A and then leave a tombstone, or the purge that follows destroys
        // the outbox and the token while this grant survives on disk.
        const publisher = repository()
        const revoker = repository()
        let unpark!: () => void
        const publicationMayFinish = new Promise<void>((resolve) => {
            unpark = resolve
        })
        let publicationParked!: () => void
        const parked = new Promise<void>((resolve) => {
            publicationParked = resolve
        })
        ioGate.parkBefore = { destination: grantPath(), reached: publicationParked, release: publicationMayFinish }

        // The spy records the revoker's attempt to take the lease and then performs the real
        // acquire bound to the same instance, so B waits exactly the way production waits.
        // The publisher's own acquire has already returned by the time `revoking` opens.
        const realAcquire = FileLock.prototype.acquire
        let revoking = false
        let revokerAttempted!: () => void
        const revokerAttempt = new Promise<void>((resolve) => {
            revokerAttempted = resolve
        })
        const acquire = vi.spyOn(FileLock.prototype, "acquire")
        acquire.mockImplementation(async function (this: FileLock, target: string) {
            if (revoking && target === grantPath()) revokerAttempted()
            await realAcquire.call(this, target)
        })

        const publication = publisher.publish(grant(2))
        let revocation: Promise<void> | undefined
        try {
            // A publication that fails outright settles without ever reaching the rename, so
            // race the park against it instead of waiting out the test timeout.
            const parkedFirst = await Promise.race([
                parked.then(() => "parked" as const),
                publication.then(
                    () => "settled" as const,
                    () => "settled" as const,
                ),
            ])
            expect(parkedFirst, "publication did not reach its parked rename").toBe("parked")

            revoking = true
            revocation = revoker.clear("revoked")
            // Either event decides the test. A clear that ignores the lease completes at once;
            // a clear that respects it cannot complete until the `finally` below releases the
            // publisher, so only its acquire attempt can arrive first.
            const firstEvent = await Promise.race([
                revokerAttempt.then(() => "acquire" as const),
                revocation.then(
                    () => "cleared" as const,
                    () => "cleared" as const,
                ),
            ])
            expect(firstEvent, "clear() completed while the parked publication still held the lease").toBe("acquire")
        } finally {
            // Releasing and draining in `finally` keeps a failing assertion from stranding the
            // parked writer, which would otherwise hold the lease into the next test and leave
            // the repository directory removed underneath it.
            unpark()
            ioGate.parkBefore = undefined
            await Promise.allSettled([publication, revocation ?? Promise.resolve()])
            acquire.mockRestore()
        }

        // Both writers have settled and the spy is gone, so their errors surface here rather
        // than being read as a revocation that completed before the publication landed.
        await publication
        if (revocation) await revocation

        await expect(revoker.readActive(now, 2)).resolves.toBeNull()
        await expect(revoker.publish(grant(2))).rejects.toThrow("revoked issue grant revision")
        const persisted = JSON.parse(await fs.readFile(grantPath(), "utf8")) as Record<string, unknown>
        expect(persisted.grant).toBeUndefined()
        expect(persisted.tombstone).toMatchObject({ authorization_revision: 2, reason: "revoked" })
    })

    it("still takes the lock for a prune that actually removes a tombstone", async () => {
        const stored = repository()
        await stored.publish(grant(2, now + 10))
        await stored.clear("expired")

        // Nothing to prune: the tombstone is still inside the window in which a
        // surviving receipt could reuse the credential.
        const insideWindow = vi.spyOn(FileLock.prototype, "acquire")
        let insideWindowAcquisitions = 0
        try {
            await stored.pruneNaturalExpiry(now + 9)
            insideWindowAcquisitions = insideWindow.mock.calls.length
        } finally {
            insideWindow.mockRestore()
        }
        expect(insideWindowAcquisitions).toBe(0)
        await expect(fs.stat(path.join(root, "data", "secrets", "otel", "issue-grant.json"))).resolves.toBeDefined()

        // The real prune is a mutation, so it must serialize through the lock.
        const realPrune = vi.spyOn(FileLock.prototype, "acquire")
        let realPruneAcquisitions = 0
        try {
            await stored.pruneNaturalExpiry(now + 10)
            realPruneAcquisitions = realPrune.mock.calls.length
        } finally {
            realPrune.mockRestore()
        }
        expect(realPruneAcquisitions).toBe(1)
        await expect(fs.stat(path.join(root, "data", "secrets", "otel", "issue-grant.json"))).rejects.toMatchObject({
            code: "ENOENT",
        })
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
