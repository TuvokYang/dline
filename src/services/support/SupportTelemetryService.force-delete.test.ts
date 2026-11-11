import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueCredentialRepository } from "@/core/storage/telemetry-remote/IssueCredentialRepository"
import { IssueDiagnosticOutboxRepository } from "@/core/storage/telemetry-remote/IssueDiagnosticOutboxRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { AtomicIssueGrant } from "@/services/telemetry/remote/contracts/issueGrant"
import { deriveSupportCode } from "@/services/telemetry/remote/contracts/supportCode"
import {
    refreshIssueDiagnosticsOverlay,
    startRemoteDiagnostics,
    stopRemoteDiagnostics,
} from "@/services/telemetry/remote/remoteDiagnosticsRuntime"
import { SupportTelemetryService } from "./SupportTelemetryService"

const NOW = 1_900_000_000_000
const RESOURCE = { clientVersion: "1.2.3", platform: "test" }
const GRANT: AtomicIssueGrant = {
    accessToken: "a".repeat(43),
    profile: "issue_diagnostic",
    scopes: ["debug", "high_density_metrics", "high_density_traces"],
    authorizationId: "authorization-1",
    authorizationRevision: 2,
    expiresAt: NOW + 60_000,
    captureExpiresAt: NOW + 60_000,
    rateLimits: { maxBytes: 8 * 1024 * 1024, maxRequests: 120, maxRecords: 20_000 },
}

describe("temporary support telemetry force delete", () => {
    let root: string
    let service: SupportTelemetryService

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-support-force-delete-"))
        service = new SupportTelemetryService({
            dataDir: root,
            ...RESOURCE,
            otelEndpoint: "http://127.0.0.1:9",
            clock: () => NOW,
        })
        const layout = resolveOtelStorageLayout(root)
        const authorizationCode = "c".repeat(43)
        await new IssueCredentialRepository(layout).replace({
            authorizationCode,
            publicCode: deriveSupportCode(authorizationCode),
            state: "approved",
            revision: 2,
            authorizationExpiresAt: NOW + 60_000,
            captureExpiresAt: NOW + 60_000,
            ticketExpiresAt: NOW + 600_000,
            issueState: "open",
            resolution: { state: "investigating" },
            pollAfterMs: 60_000,
        })
        await new IssueGrantRepository(layout, { clock: () => NOW }).publish(GRANT)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        service.dispose()
        await stopRemoteDiagnostics()
        await fs.rm(root, { recursive: true, force: true })
    })

    async function startOverlay(): Promise<void> {
        startRemoteDiagnostics({
            dataDir: root,
            ...RESOURCE,
            endpoint: "http://127.0.0.1:9",
            allowed: () => true,
            hostSettings: () => ({ hostEnabled: true, level: "all" }),
            addProvider: () => undefined,
        })
        await refreshIssueDiagnosticsOverlay()
    }

    async function seedPartition(): Promise<void> {
        const layout = resolveOtelStorageLayout(root)
        await new IssueDiagnosticOutboxRepository(layout, RESOURCE).append(
            GRANT,
            [{ stream: "logs", name: "diagnostic.pending", severity: "debug", observedAt: NOW, attributes: {} }],
            NOW,
        )
        await fs.copyFile(layout.issueDiagnosticsOutboxPath, `${layout.issueDiagnosticsOutboxPath}.bak`)
    }

    it.each([false, true])("deletes the issue partition and its live-PID lock with runtime=%s", async (running) => {
        if (running) await startOverlay()
        await seedPartition()
        const layout = resolveOtelStorageLayout(root)
        const protectedFiles = [
            layout.deviceCredentialPath,
            layout.usageOutboxPath,
            path.join(layout.remoteDir, "diagnostics", "outbox.json"),
        ]
        for (const file of protectedFiles) {
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, `unchanged:${path.basename(file)}`)
        }
        await fs.writeFile(
            `${layout.issueDiagnosticsOutboxPath}.lck`,
            JSON.stringify({ pid: process.pid, ownerId: "abandoned-live-owner", ts: Date.now() }),
        )

        await service.deleteAndRevoke()
        await service.deleteAndRevoke()

        for (const suffix of ["", ".bak", ".lck"]) {
            await expect(fs.access(`${layout.issueDiagnosticsOutboxPath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" })
        }
        await expect(service.status()).resolves.toBeUndefined()
        const grants = new IssueGrantRepository(layout, { clock: () => NOW })
        await expect(grants.readActive(NOW, 2)).resolves.toBeNull()
        await expect(grants.publish(GRANT)).rejects.toThrow(/revoked issue grant revision/)
        for (const file of protectedFiles) {
            expect(await fs.readFile(file, "utf8")).toBe(`unchanged:${path.basename(file)}`)
        }
    })

    it("keeps the partition lock intact when revocation fails, clears the ticket and permits a later retry", async () => {
        await seedPartition()
        const layout = resolveOtelStorageLayout(root)
        const lockPath = `${layout.issueDiagnosticsOutboxPath}.lck`
        const lock = JSON.stringify({ pid: process.pid, ownerId: "active-writer", ts: Date.now() })
        await fs.writeFile(lockPath, lock)
        const queued = await fs.readFile(layout.issueDiagnosticsOutboxPath, "utf8")
        const denied = new Error("issue grant revocation denied")
        vi.spyOn(IssueGrantRepository.prototype, "clear").mockRejectedValueOnce(denied)

        await expect(service.deleteAndRevoke()).rejects.toBe(denied)

        await expect(service.status()).resolves.toBeUndefined()
        await expect(new IssueGrantRepository(layout).readActive(NOW, 2)).resolves.toEqual(GRANT)
        expect(await fs.readFile(layout.issueDiagnosticsOutboxPath, "utf8")).toBe(queued)
        expect(await fs.readFile(`${layout.issueDiagnosticsOutboxPath}.bak`, "utf8")).toBe(queued)
        expect(await fs.readFile(lockPath, "utf8")).toBe(lock)

        vi.restoreAllMocks()
        await service.deleteAndRevoke()
        await expect(new IssueGrantRepository(layout).readActive(NOW, 2)).resolves.toBeNull()
        for (const suffix of ["", ".bak", ".lck"]) {
            await expect(fs.access(`${layout.issueDiagnosticsOutboxPath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" })
        }
    })

    it("seals credentials even when the issue queue cannot be removed and reports the failure", async () => {
        await startOverlay()
        await seedPartition()
        const layout = resolveOtelStorageLayout(root)
        const remove = fs.rm.bind(fs)
        const denied = Object.assign(new Error("issue queue removal denied"), { code: "EACCES" })
        vi.spyOn(fs, "rm").mockImplementation((file, options) =>
            String(file) === layout.issueDiagnosticsOutboxPath ? Promise.reject(denied) : remove(file, options),
        )

        await expect(service.deleteAndRevoke()).rejects.toThrow()

        await expect(service.status()).resolves.toBeUndefined()
        await expect(new IssueGrantRepository(layout).readActive(NOW, 2)).resolves.toBeNull()
        await expect(fs.access(`${layout.issueDiagnosticsOutboxPath}.lck`)).rejects.toMatchObject({ code: "ENOENT" })
        vi.restoreAllMocks()
        await service.deleteAndRevoke()
        await expect(fs.access(layout.issueDiagnosticsOutboxPath)).rejects.toMatchObject({ code: "ENOENT" })
    })
})
