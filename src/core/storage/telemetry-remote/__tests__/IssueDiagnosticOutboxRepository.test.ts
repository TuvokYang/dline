import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AtomicIssueGrant } from "@/services/telemetry/remote/contracts/issueGrant"
import type { IssueDiagnosticItem } from "@/services/telemetry/remote/diagnostics/issueDiagnosticRecord"
import { IssueDiagnosticOutboxRepository } from "../IssueDiagnosticOutboxRepository"
import { resolveOtelStorageLayout } from "../OtelStorageLayout"

const NOW = 1_900_000_000_000
const RESOURCE = { clientVersion: "1.2.3", platform: "test" }

function grant(revision = 1): AtomicIssueGrant {
    return {
        accessToken: "a".repeat(43),
        profile: "issue_diagnostic",
        scopes: ["debug", "high_density_metrics", "high_density_traces"],
        authorizationId: "authorization-1",
        authorizationRevision: revision,
        expiresAt: NOW + 60_000,
        captureExpiresAt: NOW + 60_000,
        rateLimits: { maxRequestBytes: 128 * 1024, maxRequests: 3, maxRecords: 10 },
    }
}

function item(name: string, stream: "logs" | "metrics" = "logs"): IssueDiagnosticItem {
    return stream === "logs"
        ? { stream, name, severity: "debug", observedAt: NOW, attributes: {} }
        : { stream, name, instrument: "gauge", value: 1, observedAt: NOW, attributes: {} }
}

describe("IssueDiagnosticOutboxRepository", () => {
    let root: string

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-issue-outbox-"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository() {
        return new IssueDiagnosticOutboxRepository(resolveOtelStorageLayout(path.join(root, "data")), RESOURCE)
    }

    it("replays unknown outcomes with the exact request ID, stream and body", async () => {
        const outbox = repository()
        await outbox.append(grant(), [item("diagnostic.first")], NOW)

        const first = await outbox.claim("owner", grant(), NOW)
        await outbox.settle("owner", first!.requestId, { kind: "replay" }, NOW)
        const replay = await outbox.claim("owner", grant(), NOW + 30_000)

        expect(replay).toEqual(first)
        await outbox.settle("owner", replay!.requestId, { kind: "acknowledged" }, NOW + 30_000)
        expect((await outbox.read()).inflight).toBeUndefined()
    })

    it("drops the previous revision partition before admitting a newer generation", async () => {
        const outbox = repository()
        await outbox.append(grant(1), [item("diagnostic.old")], NOW)
        await outbox.claim("owner", grant(1), NOW)

        await outbox.append(grant(2), [item("diagnostic.new", "metrics")], NOW)

        const stored = await outbox.read()
        expect(stored.grant?.authorization_revision).toBe(2)
        expect(stored.inflight).toBeUndefined()
        expect(stored.items).toEqual([item("diagnostic.new", "metrics")])
    })

    it("physically removes the issue partition on clear", async () => {
        const layout = resolveOtelStorageLayout(path.join(root, "data"))
        const outbox = new IssueDiagnosticOutboxRepository(layout, RESOURCE)
        await outbox.append(grant(), [item("diagnostic.pending")], NOW)

        await outbox.clear()

        await expect(fs.access(layout.issueDiagnosticsOutboxPath)).rejects.toMatchObject({ code: "ENOENT" })
        expect((await outbox.read()).items).toEqual([])
    })
})
