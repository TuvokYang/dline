import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { SupportOperationRepository } from "../SupportOperationRepository"

const NOW = 1_900_000_000_000

const createIntent = {
    kind: "create" as const,
    requestId: "request-create-1",
    pathname: "/support/authorizations",
    body: {
        report_draft_id: "draft-1",
        consent: { temporary_telemetry: true, confirmed_at: NOW },
    },
    context: { draft: { schemaVersion: 1, temporaryTelemetryConsent: true } },
}

describe("SupportOperationRepository", () => {
    let root: string
    let layout: OtelStorageLayout

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-support-operation-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository(onQuarantine = vi.fn()) {
        return {
            repository: new SupportOperationRepository(layout, { clock: () => NOW, onQuarantine }),
            onQuarantine,
        }
    }

    it("restores the exact prepared request instead of replacing its identity or body", async () => {
        const stored = repository().repository
        const prepared = await stored.prepare(createIntent)

        await expect(new SupportOperationRepository(layout).prepare(createIntent)).resolves.toEqual(prepared)
        await expect(new SupportOperationRepository(layout).read()).resolves.toEqual(prepared)

        const raw = await fs.readFile(layout.supportOperationPath, "utf8")
        expect(raw).toContain('"request_id": "request-create-1"')
        expect(raw).toContain('"report_draft_id": "draft-1"')
        if (process.platform !== "win32") {
            expect((await fs.stat(layout.supportOperationPath)).mode & 0o777).toBe(0o600)
            expect((await fs.stat(layout.secretsDir)).mode & 0o777).toBe(0o700)
        }
    })

    it("keeps the original identity while rejecting changed replay content or a competing operation", async () => {
        const stored = repository().repository
        const original = await stored.prepare(createIntent)

        await expect(stored.prepare({ ...createIntent, requestId: "request-create-2" })).resolves.toEqual(original)
        await expect(
            stored.prepare({ ...createIntent, body: { ...createIntent.body, report_draft_id: "draft-2" } }),
        ).rejects.toThrow("different support operation")
        await expect(
            stored.prepare({
                kind: "status",
                requestId: "request-status-1",
                pathname: "/support/authorizations/status",
                body: { authorization_id: "authorization-1" },
            }),
        ).rejects.toThrow("different support operation")
    })

    it("persists the response receipt before explicit completion and then removes the journal", async () => {
        const stored = repository().repository
        await stored.prepare(createIntent)

        const withResponse = await stored.storeResponse("request-create-1", {
            status: 201,
            json: { request_id: "request-create-1", authorization_id: "authorization-1" },
        })

        await expect(new SupportOperationRepository(layout).read()).resolves.toEqual(withResponse)
        await stored.complete("request-create-1")
        await expect(new SupportOperationRepository(layout).read()).resolves.toBeUndefined()
        await expect(fs.access(layout.supportOperationPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("quarantines malformed bytes instead of treating them as a valid empty journal", async () => {
        await fs.mkdir(layout.secretsDir, { recursive: true })
        await fs.writeFile(layout.supportOperationPath, "{not-json")
        const stored = repository()

        await expect(stored.repository.read()).resolves.toBeUndefined()
        expect(stored.onQuarantine).toHaveBeenCalledWith("support-operation.json")
        const copies = await fs.readdir(layout.secretsQuarantineDir)
        expect(copies).toHaveLength(1)
        expect(await fs.readFile(path.join(layout.secretsQuarantineDir, copies[0]), "utf8")).toBe("{not-json")
    })
})
