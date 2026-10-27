import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DiagnosticOutboxRepository } from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { TelemetryProviderInput, TelemetryProviderRegistration } from "../../providers/capabilities"
import type { TelemetrySettings } from "../../providers/ITelemetryProvider"
import { encodeDiagnosticLogs } from "../diagnostics/diagnosticRecord"
import { diagnosticsAllowed } from "../policy/hostDiagnosticsPolicy"
import {
    diagnosticOutboxPath,
    refreshRemoteDiagnostics,
    startRemoteDiagnostics,
    stopRemoteDiagnostics,
} from "../remoteDiagnosticsRuntime"

const HOST_ALL: TelemetrySettings = { hostEnabled: true, level: "all" }

describe("diagnosticsAllowed", () => {
    it("needs error consent and a host that reports at least errors", () => {
        expect(diagnosticsAllowed("enabled", HOST_ALL)).toBe(true)
        expect(diagnosticsAllowed("enabled", { hostEnabled: true, level: "error" })).toBe(true)
        expect(diagnosticsAllowed("disabled", HOST_ALL)).toBe(false)
        expect(diagnosticsAllowed("unset", HOST_ALL)).toBe(false)
        expect(diagnosticsAllowed("enabled", { hostEnabled: false, level: "all" })).toBe(false)
        expect(diagnosticsAllowed("enabled", { hostEnabled: true, level: "off" })).toBe(false)
        expect(diagnosticsAllowed("enabled", { hostEnabled: true })).toBe(false)
    })
})

describe("remote diagnostics runtime", () => {
    let root: string
    let allowed: boolean
    let registration: TelemetryProviderRegistration | undefined

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-diagnostics-runtime-"))
        allowed = true
        registration = undefined
        start()
    })

    function start(): void {
        startRemoteDiagnostics({
            dataDir: path.join(root, "data"),
            clientVersion: "0.11.0",
            platform: "linux",
            allowed: () => allowed,
            hostSettings: () => HOST_ALL,
            addProvider: (provider: TelemetryProviderInput) => {
                registration = provider as TelemetryProviderRegistration
            },
            // A closed loopback port: nothing here may reach a real service.
            endpoint: "http://127.0.0.1:9",
        })
    }

    afterEach(async () => {
        await stopRemoteDiagnostics()
        await fs.rm(root, { recursive: true, force: true })
    })

    function outbox(): DiagnosticOutboxRepository {
        return new DiagnosticOutboxRepository(diagnosticOutboxPath(path.join(root, "data")), {
            encode: (records, dropped) => encodeDiagnosticLogs(records, { clientVersion: "0.11.0", platform: "linux" }, dropped),
            quarantineDir: resolveOtelStorageLayout(path.join(root, "data")).remoteQuarantineDir,
        })
    }

    function append(name: string, channel: "error" | "usage" = "error"): void {
        const journal = registration?.capabilities.find((capability) => capability.kind === "journal")
        if (journal?.kind !== "journal") throw new Error("expected a journal capability")
        journal.append({
            kind: "event",
            channel,
            severity: "error",
            name,
            // Identity never leaves; older aliases travel under their catalog keys.
            properties: { taskId: "t-1", error_status: 500, error_code: "E_UPSTREAM" },
            required: false,
        })
    }

    it("registers one remote sink for production and issue-overlay diagnostics", () => {
        expect(registration?.sink).toEqual({ kind: "remote", origin: "user", channels: ["error", "runtime"] })
        expect(registration?.capabilities.map((capability) => capability.kind)).toEqual(["journal", "trace"])
    })

    it("writes gathered failures to the shared outbox without identity attributes", async () => {
        append("api.request.failed")
        append("task.started", "usage")
        await registration?.base.forceFlush()

        const { records } = await outbox().read()
        expect(records.map((record) => [record.name, record.occurrences, record.attributes])).toEqual([
            ["api.request.failed", 1, { "http.status": 500, "error.code": "E_UPSTREAM" }],
        ])
    })

    it("merges repeats of one failure into a single counted record", async () => {
        append("api.request.failed")
        append("api.request.failed")
        append("api.request.failed")
        await registration?.base.forceFlush()

        const { records } = await outbox().read()
        expect(records.map((record) => [record.name, record.occurrences])).toEqual([["api.request.failed", 3]])
    })

    it("deletes what is waiting once error reporting is withdrawn, and gathers nothing afterwards", async () => {
        append("api.request.failed")
        await registration?.base.forceFlush()
        expect((await outbox().read()).records).toHaveLength(1)

        allowed = false
        await refreshRemoteDiagnostics()
        append("task.browser_error")
        await registration?.base.forceFlush()

        expect((await outbox().read()).records).toEqual([])
    })
})
