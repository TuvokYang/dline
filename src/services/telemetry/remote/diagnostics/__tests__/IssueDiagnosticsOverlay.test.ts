import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileLock } from "@/core/storage/backend/jsonl/FileLock"
import { IssueCredentialRepository } from "@/core/storage/telemetry-remote/IssueCredentialRepository"
import { IssueDiagnosticOutboxRepository } from "@/core/storage/telemetry-remote/IssueDiagnosticOutboxRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { JournalTelemetrySignal } from "../../../providers/capabilities"
import type { AtomicIssueGrant } from "../../contracts/issueGrant"
import { deriveSupportCode } from "../../contracts/supportCode"
import { DlineOtelTransportError } from "../../transport/DlineOtelHttpClient"
import { IssueDiagnosticsOverlay } from "../IssueDiagnosticsOverlay"

const NOW = 1_900_000_000_000
const RESOURCE = { clientVersion: "1.2.3", platform: "test" }

function grant(revision = 2): AtomicIssueGrant {
    return {
        accessToken: "a".repeat(43),
        profile: "issue_diagnostic",
        scopes: ["error", "runtime", "debug", "high_density_metrics", "high_density_traces"],
        authorizationId: "authorization-1",
        authorizationRevision: revision,
        expiresAt: NOW + 60_000,
        captureExpiresAt: NOW + 60_000,
        rateLimits: { maxBytes: 8 * 1024 * 1024, maxRequests: 120, maxRecords: 20_000 },
    }
}

function debugEvent(name = "diagnostic.terminal.warm_pool_miss"): JournalTelemetrySignal {
    return {
        kind: "event",
        channel: "runtime",
        severity: "debug",
        name,
        properties: { outcome: "recovered", task_id: "must-not-leave", duration_ms: 12 },
        required: false,
    }
}

function productionFailure(): JournalTelemetrySignal {
    return {
        kind: "event",
        channel: "error",
        severity: "error",
        name: "api.request.failed",
        properties: { error_code: "E_UPSTREAM" },
        required: false,
    }
}

describe("IssueDiagnosticsOverlay", () => {
    let root: string

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-issue-overlay-"))
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(root, { recursive: true, force: true })
    })

    async function authorized() {
        const layout = resolveOtelStorageLayout(path.join(root, "data"))
        const authorizationCode = "c".repeat(43)
        await new IssueCredentialRepository(layout, { clock: () => NOW }).replace({
            authorizationCode,
            publicCode: deriveSupportCode(authorizationCode),
            state: "approved",
            revision: 2,
            authorizationExpiresAt: NOW + 60_000,
            captureExpiresAt: NOW + 60_000,
            ticketExpiresAt: NOW + 600_000,
            issueState: "open",
            resolution: { state: "investigating" },
            pollAfterMs: 1_000,
        })
        await new IssueGrantRepository(layout, { clock: () => NOW }).publish(grant())
        return layout
    }

    it("queues only additive debug, metric and trace data in the issue partition", async () => {
        const layout = await authorized()
        const sent = vi.fn(async () => ({ status: 200, json: { ok: true, disposition: "accepted" }, retryAfter: null }))
        const overlay = new IssueDiagnosticsOverlay({
            layout,
            resource: RESOURCE,
            transport: { sendIssueDiagnostics: sent },
            allowed: () => true,
            clock: () => NOW,
        })
        await overlay.refresh()

        overlay.append(productionFailure())
        overlay.append(debugEvent())
        overlay.append({
            kind: "metric",
            channel: "runtime",
            severity: "info",
            instrument: "histogram",
            name: "runtime.queue.delay",
            value: 12,
            attributes: { phase: "tool", workspace_path: "must-not-leave" },
        })
        const span = overlay.startSpan({ name: "task.provider.round", attributes: { phase: "stream", task_id: "secret" } })
        span.addEvent?.("provider.chunk", { phase: "stream" })
        span.end("success", NOW + 5)
        await overlay.flush()

        const queued = await new IssueDiagnosticOutboxRepository(layout, RESOURCE).read()
        expect(queued.items.map((item) => item.stream)).toEqual(["logs", "metrics", "traces"])
        expect(JSON.stringify(queued)).not.toContain("must-not-leave")
        expect(JSON.stringify(queued)).not.toContain("task_id")
        expect(JSON.stringify(queued)).not.toContain("api.request.failed")

        await overlay.deliver()
        expect(sent).toHaveBeenCalledWith(
            expect.objectContaining({ stream: "logs", accessToken: "a".repeat(43) }),
            expect.any(AbortSignal),
        )
        await overlay.stop()
    })

    it("seals the grant and purges issue-only data on a 403 without touching production state", async () => {
        const layout = await authorized()
        const overlay = new IssueDiagnosticsOverlay({
            layout,
            resource: RESOURCE,
            transport: {
                sendIssueDiagnostics: async () => ({
                    status: 403,
                    json: { ok: false, error: { code: "authorization_revision_stale" } },
                    retryAfter: null,
                }),
            },
            allowed: () => true,
            clock: () => NOW,
        })
        await overlay.refresh()
        overlay.append(debugEvent())
        await overlay.deliver()

        await expect(new IssueGrantRepository(layout).readActive(NOW, 2)).resolves.toBeNull()
        await expect(fs.access(layout.issueDiagnosticsOutboxPath)).rejects.toMatchObject({ code: "ENOENT" })
        expect(overlay.isActive()).toBe(false)
    })

    it.each([401, 403])("preserves a new grant installed while an old %s response settles", async (status) => {
        const layout = await authorized()
        const overlay = new IssueDiagnosticsOverlay({
            layout,
            resource: RESOURCE,
            transport: { sendIssueDiagnostics: async () => ({ status, json: { ok: false }, retryAfter: null }) },
            allowed: () => true,
            clock: () => NOW,
        })
        await overlay.refresh()
        overlay.append(debugEvent("diagnostic.old_generation"))
        const settle = IssueDiagnosticOutboxRepository.prototype.settle
        vi.spyOn(IssueDiagnosticOutboxRepository.prototype, "settle").mockImplementationOnce(async function (
            this: IssueDiagnosticOutboxRepository,
            ...args
        ) {
            await settle.call(this, ...args)
            await new IssueCredentialRepository(layout).update("c".repeat(43), (record) => ({ ...record, revision: 3 }))
            await new IssueGrantRepository(layout, { clock: () => NOW }).publish(grant(3))
            await overlay.refresh()
        })

        await overlay.deliver()

        await expect(new IssueGrantRepository(layout).readActive(NOW, 3)).resolves.toEqual(grant(3))
        expect(overlay.isActive()).toBe(true)
        overlay.append(debugEvent("diagnostic.new_generation"))
        await overlay.flush()
        const queued = await new IssueDiagnosticOutboxRepository(layout, RESOURCE).read()
        expect(queued.grant?.authorization_revision).toBe(3)
        expect(queued.items.map((item) => item.name)).toEqual(["diagnostic.new_generation"])
        await overlay.stop()
    })

    it("does not reactivate from a grant read completed after deletion", async () => {
        const layout = await authorized()
        const overlay = new IssueDiagnosticsOverlay({
            layout,
            resource: RESOURCE,
            transport: { sendIssueDiagnostics: vi.fn() },
            allowed: () => true,
            clock: () => NOW,
        })
        const original = IssueGrantRepository.prototype.readActive
        let entered!: () => void
        let release!: () => void
        const reading = new Promise<void>((resolve) => {
            entered = resolve
        })
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        vi.spyOn(IssueGrantRepository.prototype, "readActive").mockImplementationOnce(async function (
            this: IssueGrantRepository,
            now,
            revision,
        ) {
            const grant = await original.call(this, now, revision)
            entered()
            await gate
            return grant
        })
        const refreshing = overlay.refresh()
        await reading
        try {
            await overlay.deactivate("deleted")
        } finally {
            release()
        }

        expect(await refreshing).toBe(false)
        expect(overlay.isActive()).toBe(false)
        overlay.append(debugEvent())
        await overlay.flush()
        await expect(fs.access(layout.issueDiagnosticsOutboxPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("does not acquire write locks repeatedly while no authorization exists", async () => {
        const layout = resolveOtelStorageLayout(path.join(root, "data"))
        const overlay = new IssueDiagnosticsOverlay({
            layout,
            resource: RESOURCE,
            transport: { sendIssueDiagnostics: vi.fn() },
            allowed: () => true,
            clock: () => NOW,
        })
        await overlay.refresh()
        const acquire = vi.spyOn(FileLock.prototype, "acquire")

        await overlay.refresh()
        await overlay.flush()
        await overlay.deliver()

        expect(acquire).not.toHaveBeenCalled()
        expect(overlay.isActive()).toBe(false)
    })

    it("stops a second overlay on the shared tombstone and admits only a new grant generation", async () => {
        const layout = await authorized()
        const send = vi.fn()
        const options = {
            layout,
            resource: RESOURCE,
            transport: { sendIssueDiagnostics: send },
            allowed: () => true,
            clock: () => NOW,
        }
        const first = new IssueDiagnosticsOverlay(options)
        const second = new IssueDiagnosticsOverlay(options)
        await first.refresh()
        await second.refresh()
        const oldSpan = first.startSpan({ name: "task.old_generation" })
        second.append(debugEvent("diagnostic.old_generation"))

        await first.deactivate("deleted")
        await second.deliver()

        expect(send).not.toHaveBeenCalled()
        expect(second.isActive()).toBe(false)
        await expect(fs.access(layout.issueDiagnosticsOutboxPath)).rejects.toMatchObject({ code: "ENOENT" })
        await new IssueCredentialRepository(layout).update("c".repeat(43), (record) => ({ ...record, revision: 3 }))
        await new IssueGrantRepository(layout, { clock: () => NOW }).publish(grant(3))
        expect(await first.refresh()).toBe(true)
        oldSpan.end()
        first.append(debugEvent("diagnostic.new_generation"))
        await first.flush()
        const queued = await new IssueDiagnosticOutboxRepository(layout, RESOURCE).read()
        expect(queued.items.map((item) => item.stream)).toEqual(["logs"])
        expect(queued.items[0].name).toBe("diagnostic.new_generation")
    })

    it("keeps a span across a refresh of the same grant", async () => {
        const layout = await authorized()
        const overlay = new IssueDiagnosticsOverlay({
            layout,
            resource: RESOURCE,
            transport: { sendIssueDiagnostics: vi.fn() },
            allowed: () => true,
            clock: () => NOW,
        })
        await overlay.refresh()
        const span = overlay.startSpan({ name: "task.long_span" })
        await overlay.refresh()
        span.end()
        await overlay.flush()

        const queued = await new IssueDiagnosticOutboxRepository(layout, RESOURCE).read()
        expect(queued.items.map((item) => item.stream)).toEqual(["traces"])
    })

    it("aborts an inflight issue request before purging the queue", async () => {
        const layout = await authorized()
        let start!: () => void
        const started = new Promise<void>((resolve) => {
            start = resolve
        })
        const overlay = new IssueDiagnosticsOverlay({
            layout,
            resource: RESOURCE,
            transport: {
                sendIssueDiagnostics: async (_delivery, signal) => {
                    start()
                    await new Promise<void>((_resolve, reject) => {
                        signal?.addEventListener("abort", () => reject(new DlineOtelTransportError("aborted")), { once: true })
                    })
                    throw new Error("unreachable")
                },
            },
            allowed: () => true,
            clock: () => NOW,
        })
        await overlay.refresh()
        overlay.append(debugEvent())
        const delivery = overlay.deliver()
        await started

        await overlay.deactivate("deleted")
        await delivery

        await expect(fs.access(layout.issueDiagnosticsOutboxPath)).rejects.toMatchObject({ code: "ENOENT" })
        expect(overlay.isActive()).toBe(false)
    })
})
