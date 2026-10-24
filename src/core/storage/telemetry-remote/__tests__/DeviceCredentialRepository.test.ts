import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AtomicDeviceGrant } from "@/services/telemetry/remote/contracts/deviceGrant"
import { DeviceCredentialRepository, type StoredDeviceToken } from "../DeviceCredentialRepository"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { MAX_QUARANTINED_DOCUMENTS } from "../quarantine"

const TOKEN_A = "A".repeat(43)
const TOKEN_B = "B".repeat(43)

function token(accessToken: string): StoredDeviceToken {
    return { accessToken, deviceId: "device-1", expiresAt: 2_000_000_000_000, obtainedAt: 1_900_000_000_000 }
}

async function readRaw(layout: OtelStorageLayout): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(layout.deviceCredentialPath, "utf8")) as Record<string, unknown>
}

async function quarantined(layout: OtelStorageLayout): Promise<string[]> {
    return fs.readdir(layout.secretsQuarantineDir).catch(() => [])
}

describe("DeviceCredentialRepository", () => {
    let root: string
    let layout: OtelStorageLayout

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-device-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("publishes and reads one complete schema 4 device grant atomically", async () => {
        const repository = new DeviceCredentialRepository(layout, { clock: () => 1_900_000_000_000 })
        await repository.ensure()
        const grant: AtomicDeviceGrant = {
            accessToken: TOKEN_A,
            deviceId: "device-1",
            profile: "usage",
            scopes: ["usage"],
            expiresAt: 2_000_000_000_000,
            usageContract: {
                schemaVersion: 4,
                contractVersion: 4,
                maxBodyBytes: 65_536,
                maxBuckets: 8,
                maxFacts: 32,
                maxToolRows: 384,
                maxWriteRows: 486,
                eventWindowMs: 600_000,
                defaultIntervalMs: 600_000,
                newBatchJitterMaxMs: 300_000,
            },
        }

        await repository.publishDeviceGrantAtomically(grant)

        expect(await repository.readActiveDeviceGrant(1_999_999_999_999)).toEqual(grant)
        expect(await repository.readActiveDeviceGrant(grant.expiresAt)).toBeNull()
        const raw = await readRaw(layout)
        expect(raw.generation).toBe(2)
        expect(raw.grants).toMatchObject({ usage: { access_token: TOKEN_A, scopes: ["usage"], expires_at: grant.expiresAt } })

        await repository.clearTokens(["usage"])
        expect(await repository.readActiveDeviceGrant(1_999_999_999_999)).toBeNull()
        expect(await readRaw(layout)).toMatchObject({ generation: 3, tokens: {}, grants: {} })
    })

    it("creates one machine secret under the data root that every instance shares", async () => {
        const first = await new DeviceCredentialRepository(layout).ensure()
        const second = await new DeviceCredentialRepository(layout).ensure()

        expect(first.status).toBe("valid")
        expect(second.status).toBe("valid")
        if (first.status !== "valid" || second.status !== "valid") return
        expect(first.document.deviceSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(second.document.deviceSecret).toBe(first.document.deviceSecret)
        expect(second.document.generation).toBe(1)
        expect(path.relative(root, layout.deviceCredentialPath).split(path.sep)).toEqual([
            "data",
            "secrets",
            "otel",
            "device.json",
        ])
        expect((await readRaw(layout)).device_secret).toBe(first.document.deviceSecret)
    })

    it.skipIf(process.platform === "win32")("keeps the credential readable by its owner only", async () => {
        await new DeviceCredentialRepository(layout).ensure()

        expect((await fs.stat(layout.deviceCredentialPath)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(layout.secretsDir)).mode & 0o777).toBe(0o700)
    })

    it("hands a mutation the latest document written by another instance, so a stale copy cannot win", async () => {
        const windowA = new DeviceCredentialRepository(layout)
        const windowB = new DeviceCredentialRepository(layout)
        const created = await windowA.ensure()
        if (created.status !== "valid") throw new Error("expected a device")
        const generationSeenByA = created.document.generation

        await windowB.mutate((current) => ({ next: { ...current, tokens: { usage: token(TOKEN_B) } }, value: undefined }))
        const outcome = await windowA.mutate((current) =>
            current.generation === generationSeenByA
                ? { next: { ...current, tokens: { usage: token(TOKEN_A) } }, value: "saved" as const }
                : { value: "changed" as const },
        )

        expect(outcome).toMatchObject({ status: "valid", value: "changed" })
        const stored = await windowA.read()
        expect(stored.status === "valid" && stored.document.tokens.usage?.accessToken).toBe(TOKEN_B)
        expect(stored.status === "valid" && stored.document.generation).toBe(2)
    })

    it("serialises concurrent mutations from separate instances without losing an update", async () => {
        await new DeviceCredentialRepository(layout).ensure()
        const instances = Array.from({ length: 6 }, () => new DeviceCredentialRepository(layout))

        await Promise.all(
            instances.map((repository) =>
                repository.mutate((current) => ({
                    next: {
                        ...current,
                        enrollment: { notBefore: 0, consecutiveFailures: (current.enrollment?.consecutiveFailures ?? 0) + 1 },
                    },
                    value: undefined,
                })),
            ),
        )

        const stored = await instances[0].read()
        expect(stored.status === "valid" && stored.document.enrollment?.consecutiveFailures).toBe(6)
        expect(stored.status === "valid" && stored.document.generation).toBe(7)
    })

    it("quarantines an unreadable document instead of overwriting it, then starts a new identity", async () => {
        await fs.mkdir(layout.secretsDir, { recursive: true })
        await fs.writeFile(layout.deviceCredentialPath, "{not json")
        const repository = new DeviceCredentialRepository(layout)

        expect(await repository.read()).toEqual({ status: "malformed" })
        expect(await repository.mutate(() => ({ value: undefined }))).toEqual({ status: "missing" })
        const copies = await quarantined(layout)
        expect(copies).toHaveLength(1)
        expect(await fs.readFile(path.join(layout.secretsQuarantineDir, copies[0]), "utf8")).toBe("{not json")
        expect((await repository.ensure()).status).toBe("valid")
    })

    it("keeps at most a bounded number of quarantined copies", async () => {
        const repository = new DeviceCredentialRepository(layout)
        await fs.mkdir(layout.secretsDir, { recursive: true })
        for (let attempt = 0; attempt < MAX_QUARANTINED_DOCUMENTS + 2; attempt++) {
            await fs.writeFile(layout.deviceCredentialPath, `broken-${attempt}`)
            await repository.mutate(() => ({ value: undefined }))
        }

        expect(await quarantined(layout)).toHaveLength(MAX_QUARANTINED_DOCUMENTS)
    })

    it("leaves a document from a newer Dline untouched and reports it unsupported", async () => {
        await fs.mkdir(layout.secretsDir, { recursive: true })
        const future = JSON.stringify({ schema_version: 2, device_secret: TOKEN_A, created_at: 1, generation: 4 })
        await fs.writeFile(layout.deviceCredentialPath, future)
        const repository = new DeviceCredentialRepository(layout)

        expect(await repository.ensure()).toEqual({ status: "unsupported" })
        expect(await repository.mutate(() => ({ next: { tokens: {} }, value: undefined }))).toEqual({ status: "unsupported" })
        await expect(repository.resetIdentity()).rejects.toThrow()
        expect(await fs.readFile(layout.deviceCredentialPath, "utf8")).toBe(future)
    })

    it("ignores an unreadable token without costing the device its identity, and keeps unknown fields", async () => {
        await fs.mkdir(layout.secretsDir, { recursive: true })
        await fs.writeFile(
            layout.deviceCredentialPath,
            JSON.stringify({
                schema_version: 1,
                device_secret: TOKEN_A,
                created_at: 1,
                generation: 3,
                tokens: { usage: { access_token: "short", device_id: "device-1", expires_at: 5, obtained_at: 1 } },
                future_field: { kept: true },
            }),
        )
        const repository = new DeviceCredentialRepository(layout)

        const stored = await repository.ensure()
        expect(stored).toMatchObject({ status: "valid", document: { deviceSecret: TOKEN_A, generation: 3, tokens: {} } })
        await repository.mutate((current) => ({ next: { ...current, tokens: { usage: token(TOKEN_B) } }, value: undefined }))
        const raw = await readRaw(layout)
        expect(raw.future_field).toEqual({ kept: true })
        expect(raw.device_secret).toBe(TOKEN_A)
    })

    it("refuses to store a token the service could not have issued", async () => {
        const repository = new DeviceCredentialRepository(layout)
        await repository.ensure()

        await expect(
            repository.mutate((current) => ({ next: { ...current, tokens: { usage: token("not-a-token") } }, value: undefined })),
        ).rejects.toThrow()
        const stored = await repository.read()
        expect(stored.status === "valid" && stored.document.generation).toBe(1)
    })

    it("clears bearer tokens and quarantined copies but keeps the device secret", async () => {
        const repository = new DeviceCredentialRepository(layout)
        const created = await repository.ensure()
        if (created.status !== "valid") throw new Error("expected a device")
        await repository.mutate(() => ({
            next: {
                tokens: { usage: token(TOKEN_B) },
                enrollment: { notBefore: 10, consecutiveFailures: 1 },
                refreshClaim: { ownerId: "owner", profile: "usage", expiresAt: 20 },
            },
            value: undefined,
        }))
        await fs.mkdir(layout.secretsQuarantineDir, { recursive: true })
        await fs.writeFile(path.join(layout.secretsQuarantineDir, "device.1.copy.json"), TOKEN_B)

        await repository.clearTokens()

        const raw = await readRaw(layout)
        expect(raw.device_secret).toBe(created.document.deviceSecret)
        expect(raw.tokens).toEqual({})
        expect(raw.refresh_claim).toBeUndefined()
        expect(raw.enrollment).toEqual({ not_before: 10, consecutive_failures: 1 })
        expect(JSON.stringify(raw)).not.toContain(TOKEN_B)
        expect(await quarantined(layout)).toEqual([])
    })

    it("clears only the named profile's token so the other stream keeps running", async () => {
        const repository = new DeviceCredentialRepository(layout)
        await repository.ensure()
        await repository.mutate((current) => ({
            next: { ...current, tokens: { usage: token(TOKEN_A), production: token(TOKEN_B) } },
            value: undefined,
        }))

        await repository.clearTokens(["usage"])

        const stored = await repository.read()
        if (stored.status !== "valid") throw new Error("expected a device")
        expect(Object.keys(stored.document.tokens)).toEqual(["production"])
        expect(stored.document.tokens.production?.accessToken).toBe(TOKEN_B)
        expect(stored.document.generation).toBe(3)

        // Clearing a profile that holds no token leaves the document untouched.
        await repository.clearTokens(["usage"])
        const again = await repository.read()
        expect(again.status === "valid" && again.document.generation).toBe(3)
    })

    it("does not create a device when clearing tokens for a user who never enrolled", async () => {
        await new DeviceCredentialRepository(layout).clearTokens()

        await expect(fs.access(layout.deviceCredentialPath)).rejects.toThrow()
    })

    it("forgets the identity on reset so the next device is new and stale mutations cannot resurrect it", async () => {
        const repository = new DeviceCredentialRepository(layout)
        const before = await repository.ensure()
        if (before.status !== "valid") throw new Error("expected a device")

        await repository.resetIdentity()

        expect(await repository.mutate((current) => ({ next: current, value: undefined }))).toEqual({ status: "missing" })
        const after = await repository.ensure()
        expect(after.status === "valid" && after.document.deviceSecret).not.toBe(before.document.deviceSecret)
    })
})
